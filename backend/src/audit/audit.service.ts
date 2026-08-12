import { randomUUID } from "node:crypto"
import type { Request } from "express"
import type { AuditActor, AuditEvent, AuditEventType } from "../domain/types.js"
import { getStore } from "../store/index.js"

/**
 * The account audit trail.
 *
 * Answers "who did this, from where, and when" for the things that change an account's security
 * posture: sign-ins, key issuance, rotation, revocation, denied scopes, settlement address
 * changes. Payment history lives in `paymentEvents`; this is the other half.
 *
 * Two rules:
 *
 *   1. Append-only. Nothing here updates or deletes an event.
 *   2. Never record a secret. Settings changes log the *names* of the fields that changed and,
 *      for non-sensitive ones, the new value. A webhook secret is logged as having changed and
 *      nothing more.
 */

export interface RecordAuditInput {
  accountId: string
  type: AuditEventType
  actor: AuditActor
  target?: AuditEvent["target"]
  metadata?: Record<string, unknown>
  request?: Request
}

export async function recordAudit(input: RecordAuditInput): Promise<AuditEvent> {
  const store = await getStore()

  const event: AuditEvent = {
    id: `aud_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    accountId: input.accountId,
    type: input.type,
    actor: input.actor,
    target: input.target,
    metadata: input.metadata ?? {},
    requestId: input.request?.requestId,
    ip: clientIp(input.request),
    userAgent: input.request?.header("User-Agent")?.slice(0, 200),
    createdAt: new Date().toISOString(),
  }

  return store.appendAuditEvent(event)
}

/**
 * Audit writes must never fail the operation they describe.
 *
 * A dropped audit line is bad; a rotation that appears to fail after the key was already
 * rotated is worse — the developer retries and ends up with an extra live key. So failures are
 * logged loudly and swallowed.
 */
export function recordAuditSafe(input: RecordAuditInput): void {
  void recordAudit(input).catch((error) => {
    console.error(
      `[payflux] audit write failed (${input.type} on ${input.accountId}):`,
      error instanceof Error ? error.message : error,
    )
  })
}

export async function listAuditEvents(accountId: string, limit = 100): Promise<AuditEvent[]> {
  const store = await getStore()
  return store.listAuditEvents(accountId, limit)
}

/** Derives the actor from whichever credential authenticated the request. */
export function actorFor(req: Request): AuditActor {
  if (req.user) {
    return { kind: "user", id: req.user.uid, email: req.user.email }
  }
  if (req.apiKeyId) {
    return { kind: "api_key", id: req.apiKeyId }
  }
  return { kind: "system", id: "payflux" }
}

function clientIp(req?: Request): string | undefined {
  if (!req) return undefined
  // `trust proxy` is set, so req.ip already accounts for X-Forwarded-For.
  return req.ip
}
