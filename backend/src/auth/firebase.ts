import { env } from "../config/env.js"
import type { Account, Merchant } from "../domain/types.js"
import { getStore } from "../store/index.js"
import { recordAuditSafe } from "../audit/audit.service.js"

/**
 * Google sign-in, verified server-side.
 *
 * The browser signs in with Firebase and gets an ID token. That token is presented to this API,
 * which verifies it against Google's public keys through `firebase-admin`. The API never trusts
 * a uid, an email or an account id sent by the client — all three come out of the verified token.
 *
 * This is deliberately separate from API-key auth. Minting an API key is an act by a *person*,
 * so it requires a session, not a key. Letting a key mint further keys would be a privilege
 * escalation with no way back.
 */

export class AuthUnavailableError extends Error {
  readonly code = "AUTH_UNAVAILABLE"
  readonly status = 503
  constructor(detail: string) {
    super(`Google sign-in is UNAVAILABLE: ${detail}`)
    this.name = "AuthUnavailableError"
  }
}

export class InvalidSessionError extends Error {
  readonly code = "INVALID_SESSION"
  readonly status = 401
  constructor(detail: string) {
    super(detail)
    this.name = "InvalidSessionError"
  }
}

let authPromise: Promise<import("firebase-admin").auth.Auth> | undefined

export function isAuthConfigured(): boolean {
  return Boolean(
    env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY,
  )
}

async function getAuth() {
  if (!isAuthConfigured()) {
    throw new AuthUnavailableError(
      "FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are not all set on the API.",
    )
  }

  if (!authPromise) {
    authPromise = (async () => {
      const admin = await import("firebase-admin")
      const app = admin.default.apps.length
        ? admin.default.app()
        : admin.default.initializeApp({
            credential: admin.default.credential.cert({
              projectId: env.FIREBASE_PROJECT_ID,
              clientEmail: env.FIREBASE_CLIENT_EMAIL,
              // Already a real PEM — config/env.ts normalizes it at load and refuses to boot
              // if it is unusable, so there is nothing left to repair here.
              privateKey: env.FIREBASE_PRIVATE_KEY!,
            }),
          })
      return app.auth()
    })()
  }

  return authPromise
}

export interface VerifiedUser {
  uid: string
  email: string
  displayName?: string
  photoUrl?: string
  emailVerified: boolean
}

export async function verifyIdToken(idToken: string): Promise<VerifiedUser> {
  const auth = await getAuth()

  let decoded: import("firebase-admin").auth.DecodedIdToken
  try {
    // checkRevoked: a signed-out or disabled user's token stops working immediately.
    decoded = await auth.verifyIdToken(idToken, true)
  } catch (error) {
    throw new InvalidSessionError(
      `Sign-in token rejected: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!decoded.email) {
    throw new InvalidSessionError("The Google account did not provide an email address.")
  }

  return {
    uid: decoded.uid,
    email: decoded.email,
    displayName: decoded.name as string | undefined,
    photoUrl: decoded.picture,
    emailVerified: Boolean(decoded.email_verified),
  }
}

/**
 * Finds or creates the account behind a verified sign-in.
 *
 * A first-time Google sign-in *is* sign-up — there is no separate registration step, and no
 * password to manage.
 */
export async function provisionAccount(user: VerifiedUser): Promise<Account> {
  const store = await getStore()
  const id = accountIdFor(user.uid)
  const now = new Date().toISOString()

  const existing = await store.getAccount(id)
  if (existing) {
    // A sign-in is only worth auditing once per session, not on every authenticated request —
    // the ID token is presented constantly. One line per hour of activity is the useful signal.
    const hoursSinceSeen =
      (Date.now() - new Date(existing.lastSeenAt).getTime()) / 3_600_000
    if (hoursSinceSeen >= 1) {
      recordAuditSafe({
        accountId: id,
        type: "account.signed_in",
        actor: { kind: "user", id: user.uid, email: user.email },
      })
    }

    // Keep the profile fresh — people change their Google display name and avatar.
    return store.saveAccount({
      ...existing,
      email: user.email,
      displayName: user.displayName,
      photoUrl: user.photoUrl,
      lastSeenAt: now,
    })
  }

  const account = await store.saveAccount({
    id,
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoUrl: user.photoUrl,
    provider: "google",
    createdAt: now,
    lastSeenAt: now,
  })

  /*
   * A new account starts with NO settlement addresses.
   *
   * Inheriting the deployment's addresses would be far more convenient and quietly wrong: a
   * developer who signs up and never opens Settings would have their customers pay the
   * *operator's* XRPL address, and the operator's wallet would receive the FXRP. Money silently
   * going to the wrong party is not a default worth having.
   *
   * Blank instead means the router reports the routes as unavailable, naming the setting to fill
   * in. One extra step, and no way to take someone else's payment by accident.
   *
   * The webhook endpoint and secret are deliberately not inherited either — those would post a
   * developer's payment events to the operator's server, signed with the operator's secret.
   */
  const merchant: Merchant = {
    id: account.id,
    name: user.displayName ?? user.email,
    settlementPreference: { asset: "FXRP", chain: "coston2" },
  }
  await store.saveMerchant(merchant)

  recordAuditSafe({
    accountId: account.id,
    type: "account.created",
    actor: { kind: "user", id: user.uid, email: user.email },
    metadata: { provider: "google", inheritedDefaults: !merchant.xrplAddress ? [] : ["xrplAddress"] },
  })

  return account
}

export function accountIdFor(uid: string): string {
  return `acct_${uid}`
}
