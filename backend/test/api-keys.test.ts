import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"
import { createApp } from "../src/app.js"
import {
  issueApiKey,
  listApiKeys,
  parseApiKey,
  revokeApiKey,
  rotateApiKey,
  verifyApiKey,
  ApiKeyError,
} from "../src/auth/api-keys.js"
import { getStore } from "../src/store/index.js"

const ACCOUNT = "acct_test_developer"
const OTHER_ACCOUNT = "acct_other_developer"

async function clearKeys(accountId: string) {
  const store = await getStore()
  for (const key of await store.listApiKeys(accountId)) {
    await store.saveApiKey({ ...key, status: "revoked" })
  }
}

// The in-memory store is shared across this file, and issuing counts against the per-account
// limit. Reset both accounts before every test so suites cannot starve each other.
beforeEach(async () => {
  await clearKeys(ACCOUNT)
  await clearKeys(OTHER_ACCOUNT)
})

describe("API key format", () => {
  it("issues a key that parses back to its id", async () => {
    const issued = await issueApiKey(ACCOUNT, "Test key")
    const parsed = parseApiKey(issued.secret)

    expect(issued.secret).toMatch(/^sk_ctn2_[0-9a-f]{16}_[A-Za-z0-9_-]{20,}$/)
    expect(parsed?.keyId).toBe(issued.record.id)
  })

  it("never stores the secret", async () => {
    const issued = await issueApiKey(ACCOUNT, "Test key")
    const store = await getStore()
    const stored = await store.getApiKey(issued.record.id)

    expect(stored?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(issued.secret.split("_")[3])
  })

  it("shows only a truncated prefix", async () => {
    const issued = await issueApiKey(ACCOUNT, "Test key")
    expect(issued.secret.startsWith(issued.record.prefix)).toBe(true)
    // Short enough to be useless on its own.
    expect(issued.record.prefix.length).toBeLessThan(issued.secret.length / 2)
  })

  it("rejects malformed keys without touching the store", () => {
    expect(parseApiKey("nonsense")).toBeUndefined()
    expect(parseApiKey("sk_ctn2_short_abc")).toBeUndefined()
    expect(parseApiKey("pk_ctn2_aaaaaaaaaaaaaaaa_abcdefghijklmnopqrstuvwxyz")).toBeUndefined()
    // A mainnet-looking environment must not be accepted by a testnet deployment.
    expect(parseApiKey("sk_flare_aaaaaaaaaaaaaaaa_abcdefghijklmnopqrstuvwxyz")).toBeUndefined()
  })
})

describe("API key verification", () => {
  it("verifies a freshly issued key", async () => {
    const issued = await issueApiKey(ACCOUNT, "Test key")
    const verified = await verifyApiKey(issued.secret)

    expect(verified?.accountId).toBe(ACCOUNT)
    expect(verified?.keyId).toBe(issued.record.id)
  })

  it("rejects a key with the right id and the wrong secret", async () => {
    const issued = await issueApiKey(ACCOUNT, "Test key")
    const forged = `sk_ctn2_${issued.record.id}_${"A".repeat(43)}`
    expect(await verifyApiKey(forged)).toBeUndefined()
  })

  it("rejects an unknown key id", async () => {
    expect(await verifyApiKey(`sk_ctn2_${"ab".repeat(8)}_${"C".repeat(43)}`)).toBeUndefined()
  })

  it("records last-used on success", async () => {
    const issued = await issueApiKey(ACCOUNT, "Test key")
    expect(issued.record.lastUsedAt).toBeUndefined()

    await verifyApiKey(issued.secret)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const store = await getStore()
    expect((await store.getApiKey(issued.record.id))?.lastUsedAt).toBeDefined()
  })
})

describe("rotation", () => {
  beforeEach(async () => {
    await clearKeys(ACCOUNT)
  })

  it("keeps the old key working during the grace window", async () => {
    const original = await issueApiKey(ACCOUNT, "Production")
    const result = await rotateApiKey(ACCOUNT, original.record.id, 24)

    // This is the whole point of a grace window: no gap where neither key works.
    expect(await verifyApiKey(original.secret)).toBeDefined()
    expect(await verifyApiKey(result.issued.secret)).toBeDefined()

    expect(result.previous.status).toBe("rotating")
    expect(result.previous.expiresAt).toBeDefined()
    expect(result.previous.rotatedToId).toBe(result.issued.record.id)
    expect(result.issued.record.rotatedFromId).toBe(original.record.id)
  })

  it("stops the old key once the grace window lapses", async () => {
    const original = await issueApiKey(ACCOUNT, "Production")
    await rotateApiKey(ACCOUNT, original.record.id, 1)

    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + 2 * 3_600_000))
    try {
      expect(await verifyApiKey(original.secret)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }

    const store = await getStore()
    expect((await store.getApiKey(original.record.id))?.status).toBe("expired")
  })

  it("revokes immediately with no grace period", async () => {
    const original = await issueApiKey(ACCOUNT, "Leaked")
    const result = await rotateApiKey(ACCOUNT, original.record.id, 0)

    expect(result.previous.status).toBe("revoked")
    expect(result.previous.expiresAt).toBeUndefined()
    expect(await verifyApiKey(original.secret)).toBeUndefined()
    expect(await verifyApiKey(result.issued.secret)).toBeDefined()
  })

  it("refuses to rotate the same key twice", async () => {
    const original = await issueApiKey(ACCOUNT, "Production")
    await rotateApiKey(ACCOUNT, original.record.id, 24)

    await expect(rotateApiKey(ACCOUNT, original.record.id, 24)).rejects.toThrow(ApiKeyError)
  })

  it("refuses to rotate another developer's key", async () => {
    const original = await issueApiKey(ACCOUNT, "Production")
    await expect(rotateApiKey(OTHER_ACCOUNT, original.record.id, 24)).rejects.toMatchObject({
      // Same error as a missing key, so key ids cannot be probed across accounts.
      code: "API_KEY_NOT_FOUND",
    })
  })
})

describe("revocation", () => {
  beforeEach(async () => {
    await clearKeys(ACCOUNT)
  })

  it("rejects a revoked key immediately", async () => {
    const issued = await issueApiKey(ACCOUNT, "Test key")
    expect(await verifyApiKey(issued.secret)).toBeDefined()

    await revokeApiKey(ACCOUNT, issued.record.id)
    expect(await verifyApiKey(issued.secret)).toBeUndefined()
  })

  it("is idempotent", async () => {
    const issued = await issueApiKey(ACCOUNT, "Test key")
    const first = await revokeApiKey(ACCOUNT, issued.record.id)
    const second = await revokeApiKey(ACCOUNT, issued.record.id)
    expect(second.revokedAt).toBe(first.revokedAt)
  })

  it("refuses to revoke another developer's key", async () => {
    const issued = await issueApiKey(ACCOUNT, "Test key")
    await expect(revokeApiKey(OTHER_ACCOUNT, issued.record.id)).rejects.toMatchObject({
      code: "API_KEY_NOT_FOUND",
    })
    expect(await verifyApiKey(issued.secret)).toBeDefined()
  })
})

describe("account scoping", () => {
  beforeEach(async () => {
    await clearKeys(ACCOUNT)
    await clearKeys(OTHER_ACCOUNT)
  })

  it("lists only the account's own keys", async () => {
    await issueApiKey(ACCOUNT, "Mine")
    await issueApiKey(OTHER_ACCOUNT, "Theirs")

    const mine = await listApiKeys(ACCOUNT)
    expect(mine.some((k) => k.name === "Mine")).toBe(true)
    expect(mine.some((k) => k.name === "Theirs")).toBe(false)
  })

  it("never returns the hash", async () => {
    await issueApiKey(ACCOUNT, "Mine")
    const listed = await listApiKeys(ACCOUNT)
    expect(listed[0]).not.toHaveProperty("hash")
    expect(listed[0].secret).toBeUndefined()
  })

  it("enforces the live key limit", async () => {
    for (let i = 0; i < 5; i += 1) await issueApiKey(ACCOUNT, `Key ${i}`)
    await expect(issueApiKey(ACCOUNT, "One too many")).rejects.toMatchObject({
      code: "API_KEY_LIMIT_REACHED",
    })
  })

  it("frees a slot when a key is revoked", async () => {
    const keys = []
    for (let i = 0; i < 5; i += 1) keys.push(await issueApiKey(ACCOUNT, `Key ${i}`))
    await revokeApiKey(ACCOUNT, keys[0].record.id)
    await expect(issueApiKey(ACCOUNT, "Replacement")).resolves.toBeDefined()
  })
})

describe("key management endpoints", () => {
  const app = createApp()

  it("requires a signed-in user, not an API key", async () => {
    const issued = await issueApiKey(OTHER_ACCOUNT, "Machine key")

    // An API key is a valid credential for payments and must NOT be one for minting keys.
    const withApiKey = await request(app).get("/v1/api-keys").set("X-API-Key", issued.secret)
    expect(withApiKey.status).toBe(401)

    const anonymous = await request(app).get("/v1/api-keys")
    expect(anonymous.status).toBe(401)
  })

  it("reports UNAVAILABLE rather than 500 when Firebase is not configured", async () => {
    const response = await request(app)
      .get("/v1/api-keys")
      .set("Authorization", "Bearer not-a-real-firebase-token")

    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe("AUTH_UNAVAILABLE")
    expect(response.body.error.message).toMatch(/FIREBASE_PROJECT_ID/)
  })
})

describe("payment API accepts developer-issued keys", () => {
  it("scopes payments to the issuing account", async () => {
    const app = createApp()
    const store = await getStore()
    await store.saveMerchant({
      id: ACCOUNT,
      name: "Test Developer",
      settlementPreference: { asset: "FXRP", chain: "coston2" },
    })

    const issued = await issueApiKey(ACCOUNT, "Payments key")
    const created = await request(app)
      .post("/v1/payments")
      .set("X-API-Key", issued.secret)
      .send({ amount: "25.00", currency: "USD", acceptedAssets: ["XRP"] })

    expect(created.status).toBe(201)
    expect(created.body.merchantId).toBe(ACCOUNT)
  })
})
