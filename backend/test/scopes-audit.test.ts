import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"
import { createApp } from "../src/app.js"
import {
  effectiveScopes,
  isLegacyFullAccess,
  issueApiKey,
  normalizeScopes,
  rotateApiKey,
  verifyApiKey,
} from "../src/auth/api-keys.js"
import { listAuditEvents, recordAudit } from "../src/audit/audit.service.js"
import { getStore } from "../src/store/index.js"
import { ALL_SCOPES, DEFAULT_SCOPES } from "../src/domain/types.js"

const ACCOUNT = "acct_scope_tester"
const app = createApp()

async function reset() {
  const store = await getStore()
  for (const key of await store.listApiKeys(ACCOUNT)) {
    await store.saveApiKey({ ...key, status: "revoked" })
  }
  await store.saveMerchant({
    id: ACCOUNT,
    name: "Scope Tester",
    settlementPreference: { asset: "FXRP", chain: "coston2" },
    xrplAddress: "rPayFluxDemoMerchantAddress000000000",
    flareAddress: "0x2222222222222222222222222222222222222222",
  })
}

beforeEach(reset)

describe("scope normalisation", () => {
  it("defaults to the minimum needed to accept a payment, not full access", () => {
    expect(normalizeScopes(undefined)).toEqual(DEFAULT_SCOPES)
    expect(normalizeScopes([])).toEqual(DEFAULT_SCOPES)
    expect(normalizeScopes(undefined)).not.toEqual(ALL_SCOPES)
  })

  it("rejects unknown scopes rather than silently dropping them", () => {
    expect(() => normalizeScopes(["payments:read", "payments:delete"])).toThrow(/Unknown scope/)
    expect(() => normalizeScopes(["admin"])).toThrow(/Unknown scope/)
  })

  it("deduplicates and orders consistently", () => {
    const a = normalizeScopes(["payments:write", "payments:read", "payments:write"])
    const b = normalizeScopes(["payments:read", "payments:write"])
    expect(a).toEqual(b)
  })
})

describe("scope enforcement", () => {
  const payload = { amount: "10.00", currency: "USD", acceptedAssets: ["XRP"] }

  it("allows a call the key has the scope for", async () => {
    const key = await issueApiKey(ACCOUNT, "Writer", { scopes: ["payments:write"] })
    const response = await request(app)
      .post("/v1/payments")
      .set("X-API-Key", key.secret)
      .send(payload)
    expect(response.status).toBe(201)
  })

  it("refuses a write with a read-only key", async () => {
    const key = await issueApiKey(ACCOUNT, "Reader", { scopes: ["payments:read"] })
    const response = await request(app)
      .post("/v1/payments")
      .set("X-API-Key", key.secret)
      .send(payload)

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe("INSUFFICIENT_SCOPE")
    expect(response.body.error.requiredScope).toBe("payments:write")
    // The message must say how to fix it, not just that it failed.
    expect(response.body.error.message).toMatch(/Rotate the key/)
  })

  it("refuses a read with a write-only key", async () => {
    const key = await issueApiKey(ACCOUNT, "Writer", { scopes: ["payments:write"] })
    const response = await request(app).get("/v1/payments").set("X-API-Key", key.secret)
    expect(response.status).toBe(403)
    expect(response.body.error.requiredScope).toBe("payments:read")
  })

  it("separates settlement scopes from payment scopes", async () => {
    const key = await issueApiKey(ACCOUNT, "Payments only", {
      scopes: ["payments:read", "payments:write"],
    })
    const response = await request(app).get("/v1/settlements").set("X-API-Key", key.secret)
    expect(response.status).toBe(403)
    expect(response.body.error.requiredScope).toBe("settlements:read")
  })

  it("separates webhook read from webhook write", async () => {
    const key = await issueApiKey(ACCOUNT, "Webhook reader", { scopes: ["webhooks:read"] })

    const read = await request(app).get("/v1/webhooks").set("X-API-Key", key.secret)
    expect(read.status).toBe(200)

    const write = await request(app).post("/v1/webhooks/test").set("X-API-Key", key.secret)
    expect(write.status).toBe(403)
    expect(write.body.error.requiredScope).toBe("webhooks:write")
  })

  it("leaves public endpoints unscoped", async () => {
    const assets = await request(app).get("/v1/assets")
    expect(assets.status).toBe(200)
  })

  it("grants every scope to the environment bootstrap key", async () => {
    const response = await request(app)
      .get("/v1/settlements")
      .set("X-API-Key", "sk_test_secret_value_1234567890")
    expect(response.status).toBe(200)
  })
})

describe("legacy keys", () => {
  it("grandfathers a key issued before scopes existed", async () => {
    const key = await issueApiKey(ACCOUNT, "Legacy", { scopes: ["payments:read"] })

    // Simulate a record written before the scopes field existed.
    const store = await getStore()
    const stored = await store.getApiKey(key.record.id)
    const { scopes, ...withoutScopes } = stored!
    await store.saveApiKey(withoutScopes as typeof stored)

    const reloaded = (await store.getApiKey(key.record.id))!
    expect(isLegacyFullAccess(reloaded)).toBe(true)
    expect(effectiveScopes(reloaded)).toEqual(ALL_SCOPES)

    const verified = await verifyApiKey(key.secret)
    expect(verified?.legacyFullAccess).toBe(true)

    // Full access means it still works everywhere — nothing silently breaks.
    const response = await request(app).get("/v1/settlements").set("X-API-Key", key.secret)
    expect(response.status).toBe(200)
  })

  it("applies real scopes when a legacy key is rotated", async () => {
    const key = await issueApiKey(ACCOUNT, "Legacy", { scopes: ["payments:read"] })
    const store = await getStore()
    const stored = await store.getApiKey(key.record.id)
    const { scopes, ...withoutScopes } = stored!
    await store.saveApiKey(withoutScopes as typeof stored)

    const rotated = await rotateApiKey(ACCOUNT, key.record.id, 0)

    // The successor must not inherit implicit full access.
    expect(rotated.issued.record.scopes).toEqual(DEFAULT_SCOPES)
    expect(isLegacyFullAccess(rotated.issued.record)).toBe(false)
  })
})

describe("rotation and scopes", () => {
  it("inherits the predecessor's scopes by default", async () => {
    const key = await issueApiKey(ACCOUNT, "Settlements", {
      scopes: ["settlements:read", "settlements:write"],
    })
    const rotated = await rotateApiKey(ACCOUNT, key.record.id, 0)
    expect(rotated.issued.record.scopes).toEqual(["settlements:read", "settlements:write"])
  })

  it("can narrow scopes during rotation", async () => {
    const key = await issueApiKey(ACCOUNT, "Broad", {
      scopes: ["payments:read", "payments:write", "settlements:write"],
    })
    const rotated = await rotateApiKey(ACCOUNT, key.record.id, 0, ["payments:read"])
    expect(rotated.issued.record.scopes).toEqual(["payments:read"])
  })
})

describe("audit log", () => {
  it("records a scope denial with the required and held scopes", async () => {
    const key = await issueApiKey(ACCOUNT, "Reader", { scopes: ["payments:read"] })
    await request(app)
      .post("/v1/payments")
      .set("X-API-Key", key.secret)
      .send({ amount: "10.00", currency: "USD", acceptedAssets: ["XRP"] })

    // The audit write is fire-and-forget so it does not delay the response.
    await new Promise((resolve) => setTimeout(resolve, 30))

    const events = await listAuditEvents(ACCOUNT)
    const denial = events.find((event) => event.type === "api_key.scope_denied")

    expect(denial).toBeDefined()
    expect(denial?.metadata.requiredScope).toBe("payments:write")
    expect(denial?.metadata.heldScopes).toEqual(["payments:read"])
    expect(denial?.actor.kind).toBe("api_key")
    expect(denial?.actor.id).toBe(key.record.id)
  })

  it("is append-only and newest first", async () => {
    await recordAudit({
      accountId: ACCOUNT,
      type: "settings.updated",
      actor: { kind: "user", id: "uid", email: "dev@example.com" },
      metadata: { changed: ["xrplAddress"] },
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await recordAudit({
      accountId: ACCOUNT,
      type: "api_key.revoked",
      actor: { kind: "user", id: "uid" },
      metadata: {},
    })

    const events = await listAuditEvents(ACCOUNT)
    expect(events[0].type).toBe("api_key.revoked")
    expect(events.some((e) => e.type === "settings.updated")).toBe(true)
  })

  it("scopes events to the account", async () => {
    await recordAudit({
      accountId: "acct_someone_else",
      type: "api_key.created",
      actor: { kind: "user", id: "other" },
      metadata: {},
    })
    const events = await listAuditEvents(ACCOUNT)
    expect(events.every((event) => event.accountId === ACCOUNT)).toBe(true)
  })

  it("never records a webhook secret", async () => {
    await recordAudit({
      accountId: ACCOUNT,
      type: "settings.updated",
      actor: { kind: "user", id: "uid" },
      metadata: { changed: ["webhookSecret"] },
    })
    const events = await listAuditEvents(ACCOUNT)
    const serialized = JSON.stringify(events)
    expect(serialized).toContain("webhookSecret")
    // The field name is recorded; the value never is.
    expect(serialized).not.toMatch(/whsec_/)
  })
})

describe("account settings endpoints", () => {
  it("require a signed-in user, not an API key", async () => {
    const key = await issueApiKey(ACCOUNT, "Machine", { scopes: ["payments:write"] })

    const withKey = await request(app).get("/v1/account/settings").set("X-API-Key", key.secret)
    expect(withKey.status).toBe(401)

    const patchWithKey = await request(app)
      .patch("/v1/account/settings")
      .set("X-API-Key", key.secret)
      .send({ flareAddress: "0x3333333333333333333333333333333333333333" })
    expect(patchWithKey.status).toBe(401)
  })

  it("reports UNAVAILABLE when Firebase is not configured", async () => {
    const response = await request(app)
      .get("/v1/account/settings")
      .set("Authorization", "Bearer not-a-real-token")
    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe("AUTH_UNAVAILABLE")
  })
})

describe("per-account settlement addresses", () => {
  it("scopes payments to the account and uses its own merchant record", async () => {
    const store = await getStore()
    await store.saveMerchant({
      id: ACCOUNT,
      name: "Scope Tester",
      settlementPreference: { asset: "FXRP", chain: "coston2" },
      xrplAddress: "rOwnAddressForThisAccount0000000000",
      flareAddress: "0x4444444444444444444444444444444444444444",
    })

    const key = await issueApiKey(ACCOUNT, "Writer", { scopes: ["payments:write"] })
    const created = await request(app)
      .post("/v1/payments")
      .set("X-API-Key", key.secret)
      .send({ amount: "10.00", currency: "USD", acceptedAssets: ["XRP"] })

    expect(created.status).toBe(201)
    expect(created.body.merchantId).toBe(ACCOUNT)

    const merchant = await store.getMerchant(created.body.merchantId)
    expect(merchant?.xrplAddress).toBe("rOwnAddressForThisAccount0000000000")
  })

  it("lists every merchant so the watcher can poll each address", async () => {
    const store = await getStore()
    await store.saveMerchant({
      id: "acct_second",
      name: "Second",
      settlementPreference: { asset: "FXRP", chain: "coston2" },
      xrplAddress: "rSecondAccountAddress0000000000000",
    })

    const merchants = await store.listMerchants()
    const addresses = merchants.map((m) => m.xrplAddress)
    expect(addresses).toContain("rSecondAccountAddress0000000000000")
    expect(new Set(addresses).size).toBeGreaterThan(1)
  })
})

describe("error handler robustness", () => {
  it("does not crash on a non-string error code", async () => {
    // gRPC (and therefore every Firestore error) uses numeric codes. The error formatter
    // assuming a string once made it throw, which bypassed the JSON response entirely and
    // returned an HTML stack trace to the caller.
    const { errorHandler } = await import("../src/middleware/index.js")

    const grpcError = Object.assign(new Error("9 FAILED_PRECONDITION: index required"), {
      code: 9,
    })

    let status = 0
    let body: any
    const res = {
      status(code: number) {
        status = code
        return this
      },
      json(payload: unknown) {
        body = payload
        return this
      },
    }

    expect(() =>
      errorHandler(grpcError as never, { requestId: "req_test" } as never, res as never, (() => {}) as never),
    ).not.toThrow()

    expect(status).toBe(500)
    expect(body.error.code).toBe("INTERNAL_ERROR")
    // The upstream numeric code is preserved without masquerading as a PayFlux code.
    expect(body.error.upstreamCode).toBe("9")
    expect(body.error.message).toMatch(/FAILED_PRECONDITION/)
  })
})
