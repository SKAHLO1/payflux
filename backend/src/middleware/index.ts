import { randomUUID, createHash, timingSafeEqual } from "node:crypto"
import type { NextFunction, Request, Response } from "express"
import rateLimit from "express-rate-limit"
import { z, type ZodTypeAny } from "zod"
import { env } from "../config/env.js"
import { getStore } from "../store/index.js"
import { verifyApiKey } from "../auth/api-keys.js"
import { provisionAccount, verifyIdToken, type VerifiedUser } from "../auth/firebase.js"
import { ALL_SCOPES, SCOPE_DESCRIPTIONS, type ApiScope } from "../domain/types.js"
import { actorFor, recordAuditSafe } from "../audit/audit.service.js"

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string
      /** Scopes payment data. Equals `accountId` for developer-issued keys. */
      merchantId?: string
      accountId?: string
      apiKeyId?: string
      /** Scopes the presented API key carries. Absent for session-authenticated requests. */
      scopes?: ApiScope[]
      /** True when the key predates scopes and is running with implicit full access. */
      legacyKey?: boolean
      /** Set only by `authenticateUser`. */
      user?: VerifiedUser
    }
  }
}

// ---------------------------------------------------------------------------
// Request ID (master prompt §50)
// ---------------------------------------------------------------------------

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("X-Request-ID")
  req.requestId = incoming && /^[\w-]{1,128}$/.test(incoming) ? incoming : `req_${randomUUID()}`
  res.setHeader("X-Request-ID", req.requestId)
  next()
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

interface EnvApiKey {
  id: string
  merchantId: string
  hash: string
}

/**
 * Bootstrap keys from the environment, in `keyId:merchantId:secret` form.
 *
 * These exist so the API, the test suite and the demo store work before anyone has signed in.
 * Developer-owned keys live in the store and are managed from the dashboard — see
 * `auth/api-keys.ts`. Both paths compare SHA-256 digests in constant time and neither ever logs,
 * persists or returns a raw secret.
 */
function loadEnvApiKeys(): EnvApiKey[] {
  return env.PAYFLUX_API_KEYS.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, merchantId, secret] = entry.split(":")
      if (!id || !merchantId || !secret) {
        // The overwhelmingly common mistake is pasting a dashboard-issued key here. Say so,
        // rather than making someone reverse-engineer a format string from a stack trace.
        const looksLikeIssuedKey = /^sk_[a-z0-9]+_/.test(entry)
        const hint = looksLikeIssuedKey
          ? `\n\n  That looks like a dashboard-issued key. It does not belong in PAYFLUX_API_KEYS —` +
            `\n  put it in .env.local as PAYFLUX_SECRET_KEY, and leave PAYFLUX_API_KEYS blank` +
            `\n  (or set a bootstrap triple such as key_local:merchant_demo:sk_local_dev_secret).`
          : `\n\n  Expected comma-separated "keyId:merchantId:secret" entries.`

        console.error(
          `\n[payflux] configuration error: malformed PAYFLUX_API_KEYS entry "${entry.slice(0, 16)}…"${hint}\n`,
        )
        process.exit(1)
      }
      return { id, merchantId, hash: sha256(secret) }
    })
}

const ENV_API_KEYS = loadEnvApiKeys()

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function matchEnvKey(presented: string): EnvApiKey | undefined {
  const provided = sha256(presented)
  return ENV_API_KEYS.find((key) => {
    const a = Buffer.from(key.hash, "hex")
    const b = Buffer.from(provided, "hex")
    return a.length === b.length && timingSafeEqual(a, b)
  })
}

function unauthorized(res: Response, req: Request, message: string) {
  return res.status(401).json({
    error: { code: "UNAUTHORIZED", message },
    requestId: req.requestId,
  })
}

/**
 * API-key authentication for machine callers.
 *
 * Tries developer-issued keys first (a single indexed lookup by embedded key id), then falls back
 * to the environment bootstrap keys. Every rejection returns the same message, so a caller cannot
 * distinguish "no such key" from "wrong secret" or "revoked".
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.header("X-API-Key") ?? req.header("Authorization")?.replace(/^Bearer\s+/i, "")
  if (!header) {
    return unauthorized(res, req, "Missing API key. Send it as X-API-Key.")
  }

  try {
    const verified = await verifyApiKey(header)
    if (verified) {
      req.merchantId = verified.accountId
      req.accountId = verified.accountId
      req.apiKeyId = verified.keyId
      req.scopes = verified.scopes
      req.legacyKey = verified.legacyFullAccess
      return next()
    }
  } catch (error) {
    // A store outage must not be reported as a credential problem.
    return next(error)
  }

  const envKey = matchEnvKey(header)
  if (envKey) {
    req.merchantId = envKey.merchantId
    req.apiKeyId = envKey.id
    // Bootstrap keys are a local-development convenience and carry every scope. Scoped keys are
    // the reason the dashboard exists; these are not manageable from it.
    req.scopes = [...ALL_SCOPES]
    req.legacyKey = false
    return next()
  }

  return unauthorized(res, req, "Invalid API key.")
}

/**
 * Requires a scope on the presented API key.
 *
 * Session-authenticated requests bypass this: a signed-in developer acting in their own dashboard
 * is not constrained by a key's scopes, because they hold no key. Scopes limit *integrations*.
 *
 * A denial is recorded in the audit log — a key repeatedly hitting an endpoint it cannot use is
 * either a misconfigured deploy or someone probing, and both are worth seeing.
 */
export function requireScope(scope: ApiScope) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user) return next()

    if (!req.scopes) {
      return unauthorized(res, req, "Missing API key.")
    }
    if (req.scopes.includes(scope)) return next()

    if (req.accountId) {
      recordAuditSafe({
        accountId: req.accountId,
        type: "api_key.scope_denied",
        actor: actorFor(req),
        target: req.apiKeyId ? { kind: "api_key", id: req.apiKeyId } : undefined,
        metadata: {
          requiredScope: scope,
          heldScopes: req.scopes,
          method: req.method,
          path: req.originalUrl.split("?")[0],
        },
        request: req,
      })
    }

    return res.status(403).json({
      error: {
        code: "INSUFFICIENT_SCOPE",
        message:
          `This API key lacks the "${scope}" scope (${SCOPE_DESCRIPTIONS[scope]}). ` +
          `It holds: ${req.scopes.join(", ") || "none"}. Rotate the key with the scope added.`,
        requiredScope: scope,
      },
      requestId: req.requestId,
    })
  }
}

/**
 * Google sign-in for humans.
 *
 * Used by endpoints that act on behalf of a person rather than an integration — creating,
 * rotating and revoking API keys. Deliberately not satisfiable with an API key: a key that can
 * mint keys is a privilege escalation with no way back.
 */
export async function authenticateUser(req: Request, res: Response, next: NextFunction) {
  const header = req.header("Authorization")
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]

  if (!token) {
    return res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Sign in required. Send a Firebase ID token as `Authorization: Bearer <token>`.",
      },
      requestId: req.requestId,
    })
  }

  try {
    const user = await verifyIdToken(token)
    const account = await provisionAccount(user)
    req.user = user
    req.accountId = account.id
    req.merchantId = account.id
    return next()
  } catch (error) {
    return next(error)
  }
}

/**
 * Accepts either a signed-in developer or an API key.
 *
 * Used by the merchant read endpoints, which serve two callers with the same data: a developer
 * looking at their own dashboard, and that developer's integration.
 *
 * Without this the dashboard has to read through a single server-held key, which means every
 * signed-in developer sees whichever account that key belongs to — their own data invisible and
 * someone else's on screen. Scoping reads to the session is what makes a shared deployment
 * usable by more than one person.
 *
 * A session is not subject to API-key scopes: scopes limit integrations, not the account owner.
 */
export function authenticateSessionOrKey(scope: ApiScope) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const bearer = req.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
    const apiKey = req.header("X-API-Key")

    // A Firebase ID token is a JWT (three dot-separated parts); an API key never is. Checking
    // the shape avoids paying for a token verification on every API-key request.
    if (bearer && bearer.split(".").length === 3) {
      return authenticateUser(req, res, next)
    }
    if (!apiKey && !bearer) {
      return unauthorized(res, req, "Sign in, or send an API key as X-API-Key.")
    }

    return authenticate(req, res, (error?: unknown) => {
      if (error) return next(error)
      return requireScope(scope)(req, res, next)
    })
  }
}

/** Public endpoints (the customer-facing status page) resolve the merchant from the payment. */
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("X-API-Key")
  if (!header) return next()
  return authenticate(req, res, next)
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export const rateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  // Per API key when authenticated, per IP otherwise, so one noisy merchant cannot starve others.
  keyGenerator: (req: Request) => req.apiKeyId ?? req.ip ?? "anonymous",
  message: {
    error: { code: "RATE_LIMITED", message: "Too many requests. Slow down." },
  },
})

/**
 * A much tighter limit for key introspection.
 *
 * `/v1/keys/self` answers "is this key real, and what does it carry?", which makes it the most
 * useful endpoint on the API to point a key-guessing script at: one request, one unambiguous
 * answer, no side effects to slow an attacker down. The general 120/min ceiling is far too
 * generous for that shape of question.
 *
 * Limited on IP as well as key id, because an attacker probing unknown keys never gets an
 * `apiKeyId` assigned — a key-only limiter would leave exactly the abuse case unbounded.
 */
export const introspectionRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `${req.ip ?? "anonymous"}:${req.apiKeyId ?? "unknown"}`,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many key verification attempts. Wait a minute and try again.",
    },
  },
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validate<T extends ZodTypeAny>(schema: T, source: "body" | "query" | "params" = "body") {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source])
    if (!result.success) {
      return res.status(422).json({
        error: {
          code: "VALIDATION_FAILED",
          message: "Request validation failed.",
          details: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        requestId: req.requestId,
      })
    }
    // Replace with the parsed value so downstream code sees coerced, trimmed data.
    Object.defineProperty(req, source, { value: result.data, writable: true })
    next()
  }
}

// ---------------------------------------------------------------------------
// Idempotency (master prompt §34)
// ---------------------------------------------------------------------------

/**
 * Replays the stored response for a repeated Idempotency-Key, and rejects the same key used with
 * a *different* body — silently returning the first payment for a second, different request would
 * be worse than an error.
 */
export function idempotency() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("Idempotency-Key")
    if (!key || !req.merchantId) return next()

    const store = await getStore()
    const requestHash = sha256(JSON.stringify(req.body ?? {}))
    const existing = await store.getIdempotentResponse(req.merchantId, key)

    if (existing) {
      if (existing.requestHash !== requestHash) {
        return res.status(409).json({
          error: {
            code: "IDEMPOTENCY_KEY_REUSED",
            message:
              "This Idempotency-Key was already used with a different request body. Use a new key.",
          },
          requestId: req.requestId,
        })
      }
      res.setHeader("Idempotent-Replay", "true")
      return res.status(200).json(existing.response)
    }

    // Capture the response so a retry can replay it verbatim.
    const originalJson = res.json.bind(res)
    res.json = ((body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && req.merchantId) {
        // Fire-and-forget so the response is not delayed — but an unhandled rejection here
        // would take the whole process down, and a lost idempotency record is far cheaper than
        // a dead API.
        void store
          .saveIdempotentResponse(req.merchantId, key, requestHash, body)
          .catch((error) =>
            console.error(`[payflux] idempotency record failed for ${key}:`, error),
          )
      }
      return originalJson(body)
    }) as Response["json"]

    next()
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface CodedError extends Error {
  code?: string
  status?: number
}

const STATUS_FOR_CODE: Record<string, number> = {
  AUTH_UNAVAILABLE: 503,
  INVALID_SESSION: 401,
  API_KEY_NOT_FOUND: 404,
  API_KEY_LIMIT_REACHED: 409,
  API_KEY_NOT_ROTATABLE: 409,
  API_KEY_ALREADY_ROTATED: 409,
  PAYMENT_NOT_FOUND: 404,
  ASSET_UNSUPPORTED: 400,
  ROUTE_UNAVAILABLE: 409,
  INVALID_STATE_TRANSITION: 409,
  QUOTE_UNAVAILABLE: 503,
  PRICE_FEED_UNAVAILABLE: 503,
  FDC_UNAVAILABLE: 503,
  FASSETS_UNAVAILABLE: 503,
  PAYMENT_REGISTRY_UNAVAILABLE: 503,
  SIGNER_UNAVAILABLE: 503,
  CONTRACT_NOT_REGISTERED: 503,
  SETTLEMENT_FAILED: 502,
}

export function errorHandler(error: CodedError, req: Request, res: Response, _next: NextFunction) {
  // `code` is not necessarily a string. gRPC — and therefore every Firestore error — uses numeric
  // codes (9 = FAILED_PRECONDITION). Assuming a string here made the error handler itself throw,
  // which bypasses Express's JSON response and returns an HTML stack trace to the caller. An
  // error formatter must never be able to fail.
  const rawCode = (error as { code?: unknown }).code
  const code = typeof rawCode === "string" && rawCode ? rawCode : "INTERNAL_ERROR"
  const status = error.status ?? STATUS_FOR_CODE[code] ?? 500

  // A 503 from an unconfigured capability is a deployment state, not a fault. Log one line so it
  // is still visible, but keep stack traces for things that are actually broken.
  const expectedUnavailable = code.endsWith("_UNAVAILABLE") || code === "CONTRACT_NOT_REGISTERED"

  if (status >= 500 && expectedUnavailable) {
    console.warn(`[payflux] ${req.requestId} ${code}: ${error.message}`)
  } else if (status >= 500) {
    // Keep the original code (numeric or otherwise) in the log — it is how you find the cause.
    console.error(`[payflux] ${req.requestId} ${code} (raw: ${String(rawCode)}):`, error)
  }

  const message =
    status >= 500 && env.NODE_ENV === "production"
      ? "Internal server error."
      : (error.message ?? "Unknown error")

  res.status(status).json({
    error: {
      code,
      message,
      // Surfaces the underlying cause without pretending it is a PayFlux error code.
      ...(rawCode !== undefined && typeof rawCode !== "string"
        ? { upstreamCode: String(rawCode) }
        : {}),
    },
    requestId: req.requestId,
  })
}

export function notFound(req: Request, res: Response) {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` },
    requestId: req.requestId,
  })
}

/** Wraps an async handler so rejections reach the error middleware. */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(
  handler: T,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next)
  }
}

export const schemas = {
  paymentId: z.object({ id: z.string().min(3).max(64) }),
}
