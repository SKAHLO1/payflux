import { describe, expect, it } from "vitest"
import request from "supertest"
import { TEST_API_KEY, TEST_MERCHANT_ID } from "./setup.js"
import { createApp } from "../src/app.js"

/**
 * `/v1/keys/self` is what the dashboard playground runs to prove a key works. It is the only
 * endpoint that reports on the caller's own credential, so the properties worth pinning down are
 * as much about what it refuses to say as what it returns.
 */

const app = createApp()

describe("GET /v1/keys/self", () => {
  it("reports the key that signed the request", async () => {
    const res = await request(app).get("/v1/keys/self").set("X-API-Key", TEST_API_KEY)

    expect(res.status).toBe(200)
    expect(res.body.keyId).toBe("key_test")
    expect(res.body.merchantId).toBe(TEST_MERCHANT_ID)
    expect(Array.isArray(res.body.scopes)).toBe(true)
  })

  it("identifies a bootstrap key as coming from the environment", async () => {
    const res = await request(app).get("/v1/keys/self").set("X-API-Key", TEST_API_KEY)

    // The test suite authenticates with a PAYFLUX_API_KEYS triple, which never enters the store.
    expect(res.body.source).toBe("environment")
    expect(res.body.status).toBe("active")
  })

  it("rejects a request with no key", async () => {
    const res = await request(app).get("/v1/keys/self")
    expect(res.status).toBe(401)
  })

  it("rejects a tampered key", async () => {
    const res = await request(app).get("/v1/keys/self").set("X-API-Key", `${TEST_API_KEY}x`)
    expect(res.status).toBe(401)
  })

  /*
   * The whole point of the endpoint is that it authenticates with the secret but never repeats
   * it. A response that echoed the key would turn any log, screenshot or shared terminal output
   * into a credential leak.
   */
  it("never returns the secret or its hash", async () => {
    const res = await request(app).get("/v1/keys/self").set("X-API-Key", TEST_API_KEY)

    const body = JSON.stringify(res.body)
    expect(body).not.toContain(TEST_API_KEY)
    expect(res.body.hash).toBeUndefined()
    expect(res.body.secret).toBeUndefined()
  })

  /* Holding one key must reveal nothing about any other — there is no lookup by id. */
  it("offers no way to introspect a different key", async () => {
    const byId = await request(app).get("/v1/keys/key_other").set("X-API-Key", TEST_API_KEY)
    expect(byId.status).toBe(404)

    const viaQuery = await request(app)
      .get("/v1/keys/self?keyId=key_other")
      .set("X-API-Key", TEST_API_KEY)
    expect(viaQuery.body.keyId).toBe("key_test")
  })

  it("does not accept a session cookie in place of a key", async () => {
    // Key management lives at /v1/api-keys behind a session. This endpoint is key-authenticated
    // only, so the two surfaces cannot be confused.
    const res = await request(app).get("/v1/keys/self").set("Authorization", "Bearer not-a-key")
    expect(res.status).toBe(401)
  })

  /*
   * Introspection is the most useful endpoint to point a key-guessing script at: one request,
   * one unambiguous answer, no side effects. It carries a far tighter limit than the general
   * ceiling, and the limiter runs before authentication so rejected guesses are cheap.
   */
  it("rate limits far below the general ceiling", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 24 }, () =>
        request(app).get("/v1/keys/self").set("X-API-Key", "sk_ctn2_wrong_key_guess"),
      ),
    )

    const limited = attempts.filter((r) => r.status === 429)
    expect(limited.length).toBeGreaterThan(0)
    expect(limited[0].body.error.code).toBe("RATE_LIMITED")
  })
})
