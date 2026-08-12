import { Router } from "express"
import { asyncHandler, authenticate, introspectionRateLimiter } from "../middleware/index.js"
import { getStore } from "../store/index.js"
import { ALL_SCOPES } from "../domain/types.js"

/**
 * Key introspection: what the presented key is, and what it is allowed to do.
 *
 * This exists so a developer who has just created a key can confirm it works without writing
 * anything. It is deliberately the only endpoint that reports on the caller's own credential,
 * and it is deliberately side-effect free — no payments, no chain writes, no collateral. The
 * checks that *do* create things live in scripts/verify-key.ts, where someone runs them against
 * their own account on purpose.
 *
 * Two rules hold here.
 *
 * 1. The key authenticates the request and is never echoed back. Callers get the public key id
 *    and prefix, which are already safe to display, and nothing that could reconstruct a secret.
 *
 * 2. It answers only for the key that signed the request. There is no lookup by id, so holding
 *    one key tells you nothing about any other.
 */
export const keysRouter = Router()

/**
 * The rate limit runs *before* authentication.
 *
 * Ordered the other way, every rejected guess would still cost a store lookup and a constant-time
 * hash comparison, and the limiter would only ever see requests that already succeeded.
 */
keysRouter.get(
  "/self",
  introspectionRateLimiter,
  authenticate,
  asyncHandler(async (req, res) => {
    const store = await getStore()
    const record = req.apiKeyId ? await store.getApiKey(req.apiKeyId) : undefined

    /*
     * Bootstrap keys from PAYFLUX_API_KEYS never enter the store, so there is no record to read.
     * Reporting that plainly is more useful than a 404 on a key that demonstrably just worked —
     * it tells a developer their request authenticated against an environment key rather than
     * the dashboard-issued one they thought they were using, which is a real and confusing
     * mix-up during setup.
     */
    if (!record) {
      return res.json({
        keyId: req.apiKeyId,
        source: "environment",
        status: "active",
        merchantId: req.merchantId,
        scopes: req.scopes ?? ALL_SCOPES,
        legacyKey: Boolean(req.legacyKey),
        detail:
          "Authenticated by a bootstrap key from PAYFLUX_API_KEYS. Dashboard-issued keys report " +
          "their full record here.",
      })
    }

    res.json({
      keyId: record.id,
      source: "dashboard",
      name: record.name,
      // Already shown in the dashboard list; it identifies a key without revealing it.
      prefix: record.prefix,
      status: record.status,
      environment: record.environment,
      merchantId: req.merchantId,
      accountId: record.accountId,
      scopes: req.scopes ?? ALL_SCOPES,
      // A key issued before scopes existed runs with implicit full access, and the dashboard
      // flags it for rotation rather than silently narrowing what already works.
      legacyKey: Boolean(req.legacyKey),
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      // Present only on a rotated key: the instant this one stops working.
      expiresAt: record.expiresAt,
      rotatedToId: record.rotatedToId,
      rotatedFromId: record.rotatedFromId,
    })
  }),
)
