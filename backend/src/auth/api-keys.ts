import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import {
  ALL_SCOPES,
  API_SCOPES,
  DEFAULT_SCOPES,
  type ApiKeyRecord,
  type ApiKeyStatus,
  type ApiKeyView,
  type ApiScope,
} from "../domain/types.js"
import { getStore } from "../store/index.js"
import { env } from "../config/env.js"

/**
 * API key lifecycle: issue, verify, rotate, revoke.
 *
 * ---------------------------------------------------------------------------
 * Key format
 * ---------------------------------------------------------------------------
 *
 *     sk_ctn2_a1b2c3d4e5f6a7b8_XmR3n...   (43-char secret)
 *     └┬┘ └─┬┘ └──────┬───────┘ └──┬──┘
 *      │    │         │            └── 32 random bytes, base64url
 *      │    │         └─────────────── key id: public lookup handle
 *      │    └───────────────────────── environment, so a testnet key is obvious on sight
 *      └────────────────────────────── secret key marker, for secret scanners
 *
 * Embedding the key id means verification is a single indexed lookup rather than a scan over
 * every key in the system, which matters once more than a handful of developers sign up.
 *
 * ---------------------------------------------------------------------------
 * Why SHA-256 and not bcrypt/argon2
 * ---------------------------------------------------------------------------
 *
 * Password hashes need to be slow because passwords are low-entropy and human-chosen. These
 * secrets are 256 bits from a CSPRNG — there is no dictionary to attack and no brute-force
 * budget that touches it. A slow KDF here would only add latency to every authenticated request.
 * The comparison is still constant-time, to avoid leaking the digest through timing.
 */

const KEY_PREFIX = "sk"
const KEY_ENVIRONMENT = "ctn2"
const SECRET_BYTES = 32

/** How much of the key is safe to show in a list. Enough to recognise, useless to an attacker. */
const DISPLAY_PREFIX_LENGTH = `${KEY_PREFIX}_${KEY_ENVIRONMENT}_`.length + 8

export class ApiKeyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = "ApiKeyError"
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "hex")
  const bufferB = Buffer.from(b, "hex")
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB)
}

interface ParsedKey {
  keyId: string
  secret: string
}

/**
 * Splits a presented key without revealing whether the id exists.
 *
 * The secret is base64url, whose alphabet includes `_` — so only the first three separators are
 * structural and everything after them is the secret. Splitting on every underscore would reject
 * roughly three keys in four.
 */
export function parseApiKey(raw: string): ParsedKey | undefined {
  const parts = raw.split("_")
  if (parts.length < 4) return undefined

  const [prefix, environment, keyId, ...secretParts] = parts
  const secret = secretParts.join("_")

  if (prefix !== KEY_PREFIX || environment !== KEY_ENVIRONMENT) return undefined
  if (!/^[0-9a-f]{16}$/.test(keyId)) return undefined
  if (!/^[A-Za-z0-9_-]{20,}$/.test(secret)) return undefined

  return { keyId, secret }
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

export interface IssuedKey {
  record: ApiKeyRecord
  /** The only moment this value exists in plaintext. */
  secret: string
}

export function normalizeScopes(scopes: string[] | undefined): ApiScope[] {
  if (!scopes || scopes.length === 0) return [...DEFAULT_SCOPES]

  const valid = scopes.filter((scope): scope is ApiScope =>
    (API_SCOPES as readonly string[]).includes(scope),
  )
  const unknown = scopes.filter((scope) => !(API_SCOPES as readonly string[]).includes(scope))

  if (unknown.length > 0) {
    throw new ApiKeyError(
      "INVALID_SCOPE",
      `Unknown scope(s): ${unknown.join(", ")}. Valid scopes are ${API_SCOPES.join(", ")}.`,
      422,
    )
  }
  if (valid.length === 0) {
    throw new ApiKeyError("INVALID_SCOPE", "A key must have at least one scope.", 422)
  }

  // Deduplicate and keep a stable order so two keys with the same scopes look the same.
  return API_SCOPES.filter((scope) => valid.includes(scope))
}

/**
 * The effective scopes of a stored key.
 *
 * A key issued before scopes existed has no `scopes` field. Narrowing it silently would break a
 * working integration with a confusing 403, so it is grandfathered as full access and surfaced
 * in the dashboard as legacy — rotating it applies real scopes.
 */
export function effectiveScopes(record: ApiKeyRecord): ApiScope[] {
  return record.scopes ?? [...ALL_SCOPES]
}

export function isLegacyFullAccess(record: ApiKeyRecord): boolean {
  return record.scopes === undefined
}

export async function issueApiKey(
  accountId: string,
  name: string,
  options: { rotatedFromId?: string; scopes?: string[] } = {},
): Promise<IssuedKey> {
  const store = await getStore()

  const existing = await store.listApiKeys(accountId)
  const live = existing.filter((key) => key.status === "active" || key.status === "rotating")
  if (live.length >= env.MAX_API_KEYS_PER_ACCOUNT) {
    throw new ApiKeyError(
      "API_KEY_LIMIT_REACHED",
      `This account already has ${live.length} live keys (limit ${env.MAX_API_KEYS_PER_ACCOUNT}). ` +
        `Revoke one before creating another.`,
      409,
    )
  }

  const keyId = randomBytes(8).toString("hex")
  const secretPart = randomBytes(SECRET_BYTES).toString("base64url")
  const full = `${KEY_PREFIX}_${KEY_ENVIRONMENT}_${keyId}_${secretPart}`

  const record: ApiKeyRecord = {
    id: keyId,
    accountId,
    name: name.trim() || "Untitled key",
    prefix: full.slice(0, DISPLAY_PREFIX_LENGTH),
    // Hash the secret part only — the id is public, so including it adds nothing.
    hash: sha256(secretPart),
    status: "active",
    createdAt: new Date().toISOString(),
    environment: "testnet",
    rotatedFromId: options.rotatedFromId,
    scopes: normalizeScopes(options.scopes),
  }

  await store.saveApiKey(record)
  return { record, secret: full }
}

// ---------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------

export interface VerifiedKey {
  keyId: string
  accountId: string
  scopes: ApiScope[]
  legacyFullAccess: boolean
}

/**
 * Verifies a presented key.
 *
 * Returns `undefined` for every failure — unknown id, wrong secret, revoked, expired — so a
 * caller cannot probe which key ids exist.
 */
export async function verifyApiKey(raw: string): Promise<VerifiedKey | undefined> {
  const parsed = parseApiKey(raw)
  if (!parsed) return undefined

  const store = await getStore()
  const record = await store.getApiKey(parsed.keyId)
  if (!record) return undefined

  if (!constantTimeEquals(record.hash, sha256(parsed.secret))) return undefined

  if (record.status === "revoked") return undefined
  if (record.status === "expired") return undefined

  // A rotating key keeps working until its grace window closes, then retires itself.
  if (record.expiresAt && new Date(record.expiresAt) <= new Date()) {
    await store.saveApiKey({ ...record, status: "expired" })
    return undefined
  }

  // Last-used is best-effort: a write failure must never fail an otherwise valid request.
  void store
    .saveApiKey({ ...record, lastUsedAt: new Date().toISOString() })
    .catch(() => undefined)

  return {
    keyId: record.id,
    accountId: record.accountId,
    scopes: effectiveScopes(record),
    legacyFullAccess: isLegacyFullAccess(record),
  }
}

// ---------------------------------------------------------------------------
// Rotating and revoking
// ---------------------------------------------------------------------------

export interface RotationResult {
  previous: ApiKeyRecord
  issued: IssuedKey
}

/**
 * Rotation issues a successor and puts the old key on a countdown.
 *
 * The grace window is the whole point: a developer can deploy the new key, confirm traffic has
 * moved, and let the old one lapse — without a window where production is authenticating with a
 * key that no longer works. `graceHours: 0` revokes immediately, for a suspected leak.
 */
export async function rotateApiKey(
  accountId: string,
  keyId: string,
  graceHours: number,
  scopes?: string[],
): Promise<RotationResult> {
  const store = await getStore()
  const record = await store.getApiKey(keyId)

  if (!record || record.accountId !== accountId) {
    throw new ApiKeyError("API_KEY_NOT_FOUND", `No API key ${keyId} on this account.`, 404)
  }
  if (record.status === "revoked" || record.status === "expired") {
    throw new ApiKeyError(
      "API_KEY_NOT_ROTATABLE",
      `Key ${keyId} is ${record.status} and cannot be rotated. Create a new one instead.`,
      409,
    )
  }
  if (record.rotatedToId) {
    throw new ApiKeyError(
      "API_KEY_ALREADY_ROTATED",
      `Key ${keyId} was already rotated into ${record.rotatedToId}.`,
      409,
    )
  }

  // The successor inherits the predecessor's scopes unless the caller narrows them. Rotation is
  // the moment a legacy full-access key gains real scopes, so it inherits the explicit default
  // rather than silently carrying full access forward forever.
  const inherited = isLegacyFullAccess(record) ? [...DEFAULT_SCOPES] : effectiveScopes(record)

  const issued = await issueApiKey(accountId, `${record.name} (rotated)`, {
    rotatedFromId: record.id,
    scopes: scopes ?? inherited,
  })

  const now = new Date()
  const previous: ApiKeyRecord = {
    ...record,
    status: graceHours > 0 ? "rotating" : "revoked",
    rotatedToId: issued.record.id,
    expiresAt:
      graceHours > 0 ? new Date(now.getTime() + graceHours * 3_600_000).toISOString() : undefined,
    revokedAt: graceHours > 0 ? undefined : now.toISOString(),
  }

  await store.saveApiKey(previous)
  return { previous, issued }
}

export async function revokeApiKey(accountId: string, keyId: string): Promise<ApiKeyRecord> {
  const store = await getStore()
  const record = await store.getApiKey(keyId)

  if (!record || record.accountId !== accountId) {
    throw new ApiKeyError("API_KEY_NOT_FOUND", `No API key ${keyId} on this account.`, 404)
  }
  if (record.status === "revoked") return record

  const revoked: ApiKeyRecord = {
    ...record,
    status: "revoked",
    revokedAt: new Date().toISOString(),
    expiresAt: undefined,
  }
  await store.saveApiKey(revoked)
  return revoked
}

export async function listApiKeys(accountId: string): Promise<ApiKeyView[]> {
  const store = await getStore()
  const keys = await store.listApiKeys(accountId)
  return keys
    .map((key) => toView(settleStatus(key)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Presents a lapsed grace window as expired even before the record is rewritten. */
function settleStatus(record: ApiKeyRecord): ApiKeyRecord {
  if (
    record.status === "rotating" &&
    record.expiresAt &&
    new Date(record.expiresAt) <= new Date()
  ) {
    return { ...record, status: "expired" as ApiKeyStatus }
  }
  return record
}

/** Strips the hash. The only place an ApiKeyRecord becomes API-visible. */
export function toView(record: ApiKeyRecord, secret?: string): ApiKeyView {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    status: record.status,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    rotatedToId: record.rotatedToId,
    rotatedFromId: record.rotatedFromId,
    environment: record.environment,
    scopes: effectiveScopes(record),
    legacyFullAccess: isLegacyFullAccess(record),
    secret,
  }
}
