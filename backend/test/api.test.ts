import { beforeAll, describe, expect, it } from "vitest"
import request from "supertest"
import { TEST_API_KEY } from "./setup.js"
import { createApp } from "../src/app.js"
import { getStore } from "../src/store/index.js"
import { signWebhook, verifyWebhookSignature } from "../src/webhooks/signer.js"
import { validatePaymentAssets, UnsupportedAssetError, toSmallestUnit, fromSmallestUnit } from "../src/registry/assets.js"

const app = createApp()

const auth = (req: request.Test) => req.set("X-API-Key", TEST_API_KEY)

const validPayment = {
  amount: "50.00",
  currency: "USD",
  acceptedAssets: ["XRP", "FXRP", "C2FLR"],
  settlementAsset: "FXRP",
  orderId: "order_1001",
}

beforeAll(async () => {
  const store = await getStore()
  await store.saveMerchant({
    id: "merchant_demo",
    name: "Test Merchant",
    settlementPreference: { asset: "FXRP", chain: "coston2" },
    xrplAddress: "rPayFluxDemoMerchantAddress000000000",
    flareAddress: "0x1111111111111111111111111111111111111111",
  })
})

describe("authentication", () => {
  it("rejects a request with no API key", async () => {
    const res = await request(app).post("/v1/payments").send(validPayment)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe("UNAUTHORIZED")
  })

  it("rejects an invalid API key", async () => {
    const res = await request(app)
      .post("/v1/payments")
      .set("X-API-Key", "sk_wrong")
      .send(validPayment)
    expect(res.status).toBe(401)
  })

  it("attaches a request id to every response", async () => {
    const res = await request(app).get("/v1/assets")
    expect(res.headers["x-request-id"]).toMatch(/^req_/)
  })

  it("honours a caller-supplied request id", async () => {
    const res = await request(app).get("/v1/assets").set("X-Request-ID", "req_traceme")
    expect(res.headers["x-request-id"]).toBe("req_traceme")
  })
})

describe("payment creation", () => {
  it("creates a payment intent with a reference and expiry", async () => {
    const res = await auth(request(app).post("/v1/payments")).send(validPayment)
    expect(res.status).toBe(201)
    expect(res.body.id).toMatch(/^pay_/)
    expect(res.body.paymentReference).toMatch(/^pay_[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/)
    expect(res.body.status).toBe("created")
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it("never lets a client set the status", async () => {
    const res = await auth(request(app).post("/v1/payments")).send({
      ...validPayment,
      status: "settled",
    })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe("created")
  })

  it("rejects an unsupported asset", async () => {
    const res = await auth(request(app).post("/v1/payments")).send({
      ...validPayment,
      acceptedAssets: ["DOGE"],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("ASSET_UNSUPPORTED")
  })

  it("rejects a malformed amount", async () => {
    const res = await auth(request(app).post("/v1/payments")).send({
      ...validPayment,
      amount: "50.12345",
    })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("VALIDATION_FAILED")
  })

  it("rejects an empty accepted-assets list", async () => {
    const res = await auth(request(app).post("/v1/payments")).send({
      ...validPayment,
      acceptedAssets: [],
    })
    expect(res.status).toBe(422)
  })
})

describe("idempotency", () => {
  it("returns the same payment for a repeated key", async () => {
    const key = `idem_${Date.now()}`
    const first = await auth(request(app).post("/v1/payments")).set("Idempotency-Key", key).send(validPayment)
    const second = await auth(request(app).post("/v1/payments")).set("Idempotency-Key", key).send(validPayment)

    expect(first.status).toBe(201)
    expect(second.body.id).toBe(first.body.id)
    expect(second.headers["idempotent-replay"]).toBe("true")
  })

  it("rejects the same key with a different body", async () => {
    const key = `idem_conflict_${Date.now()}`
    await auth(request(app).post("/v1/payments")).set("Idempotency-Key", key).send(validPayment)
    const conflict = await auth(request(app).post("/v1/payments"))
      .set("Idempotency-Key", key)
      .send({ ...validPayment, amount: "99.00" })

    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED")
  })

  it("creates distinct payments for distinct keys", async () => {
    const a = await auth(request(app).post("/v1/payments")).set("Idempotency-Key", `a_${Date.now()}`).send(validPayment)
    const b = await auth(request(app).post("/v1/payments")).set("Idempotency-Key", `b_${Date.now()}`).send(validPayment)
    expect(a.body.id).not.toBe(b.body.id)
  })
})

describe("payment reads", () => {
  it("returns 404 for an unknown payment", async () => {
    const res = await request(app).get("/v1/payments/pay_doesnotexist")
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PAYMENT_NOT_FOUND")
  })

  it("records a created event in the audit trail", async () => {
    const created = await auth(request(app).post("/v1/payments")).send(validPayment)
    const events = await request(app).get(`/v1/payments/${created.body.id}/events`)
    expect(events.status).toBe(200)
    expect(events.body.data.some((e: { type: string }) => e.type === "payment.created")).toBe(true)
  })
})

describe("assets endpoint", () => {
  it("lists assets and marks unimplemented ones as unsupported", async () => {
    const res = await request(app).get("/v1/assets")
    expect(res.status).toBe(200)

    const btc = res.body.data.find((a: { id: string }) => a.id === "BTC")
    expect(btc.enabled).toBe(false)
    expect(btc.supportsPayment).toBe(false)

    const xrp = res.body.data.find((a: { id: string }) => a.id === "XRP")
    expect(xrp.supportsPayment).toBe(true)
    // XRP is not a Flare-side settlement asset; only FXRP is.
    expect(xrp.supportsSettlement).toBe(false)
  })
})

describe("asset registry", () => {
  it("throws a typed error for an unsupported asset", () => {
    expect(() => validatePaymentAssets(["BTC"])).toThrow(UnsupportedAssetError)
    expect(() => validatePaymentAssets([])).toThrow(UnsupportedAssetError)
  })

  it("converts to and from smallest units exactly", () => {
    expect(toSmallestUnit("1.5", 6)).toBe(1_500_000n)
    expect(toSmallestUnit("0.000001", 6)).toBe(1n)
    expect(fromSmallestUnit(1_500_000n, 6)).toBe("1.5")
    expect(fromSmallestUnit(10n ** 18n, 18)).toBe("1")
  })
})

describe("webhook signatures", () => {
  const secret = "whsec_test_secret_value_abcdef"

  it("verifies a signature it produced", () => {
    const signed = signWebhook({ type: "payment.verified" }, secret)
    expect(verifyWebhookSignature(signed.signature, signed.body, secret).valid).toBe(true)
  })

  it("rejects a tampered body", () => {
    const signed = signWebhook({ type: "payment.verified", amount: "50" }, secret)
    const tampered = JSON.stringify({ type: "payment.verified", amount: "5000" })
    const result = verifyWebhookSignature(signed.signature, tampered, secret)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("signature mismatch")
  })

  it("rejects the wrong secret", () => {
    const signed = signWebhook({ type: "payment.settled" }, secret)
    expect(verifyWebhookSignature(signed.signature, signed.body, "whsec_other").valid).toBe(false)
  })

  it("rejects a replayed signature outside the tolerance window", () => {
    const signed = signWebhook({ type: "payment.settled" }, secret, Date.now() - 10 * 60_000)
    const result = verifyWebhookSignature(signed.signature, signed.body, secret)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/tolerance/)
  })

  it("rejects a malformed header", () => {
    expect(verifyWebhookSignature("nonsense", "{}", secret).valid).toBe(false)
  })
})

describe("CORS", () => {
  it("allows a configured origin", async () => {
    const res = await request(app).get("/v1/assets").set("Origin", "http://localhost:3000")
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000")
    expect(res.headers["access-control-allow-credentials"]).toBe("true")
  })

  it("never returns a wildcard origin", async () => {
    const res = await request(app).get("/v1/assets").set("Origin", "http://localhost:3000")
    expect(res.headers["access-control-allow-origin"]).not.toBe("*")
  })
})
