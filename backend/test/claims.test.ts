import { beforeEach, describe, expect, it } from "vitest"
import "./setup.js"
import { getStore } from "../src/store/index.js"
import { isAlreadyRegistered, RegistryRevertError } from "../src/chain/payment-registry.js"
import type { PaymentClaim, PaymentIntent } from "../src/domain/types.js"

/**
 * The finalization claim is what stops two workers — or the sweeper and a merchant calling
 * `POST /v1/payments/:id/verify` — from both registering a payment on Coston2 and both minting
 * FXRP. It has no observable API surface, so it is tested directly against the store.
 *
 * These run against the in-memory store, which is the implementation whose atomicity is the
 * subtler of the two: it holds only because there is no `await` between its read and its write.
 * The Firestore implementation gets the same guarantee from a transaction.
 */

const BASE: Omit<PaymentIntent, "id"> = {
  merchantId: "merchant_demo",
  amount: "50.00",
  currency: "USD",
  acceptedAssets: ["XRP"],
  status: "verifying",
  paymentReference: "pay_TEST01",
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const claim = (owner: string, ttlMs = 120_000): PaymentClaim => {
  const now = Date.now()
  return {
    owner,
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  }
}

let counter = 0
async function seed(status: PaymentIntent["status"] = "verifying"): Promise<string> {
  const store = await getStore()
  const id = `pay_claim_${counter++}`
  await store.createPayment({ ...BASE, id, status })
  return id
}

describe("finalization claims", () => {
  beforeEach(() => {
    counter += 1
  })

  it("lets exactly one caller claim a payment", async () => {
    const store = await getStore()
    const id = await seed()

    const first = await store.claimPayment(id, "verifying", claim("worker-a"))
    const second = await store.claimPayment(id, "verifying", claim("worker-b"))

    expect(first).toBeDefined()
    expect(first?.processingClaim?.owner).toBe("worker-a")
    expect(second).toBeUndefined()
  })

  /*
   * The real shape of the race: concurrent callers, not sequential ones. Every claim is issued
   * before any of them is awaited, so they interleave the way the sweeper and an API request do.
   */
  it("admits one winner when many callers race", async () => {
    const store = await getStore()
    const id = await seed()

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.claimPayment(id, "verifying", claim(`worker-${i}`))),
    )

    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("refuses a claim when the payment has left the expected status", async () => {
    const store = await getStore()
    const id = await seed("verified")

    expect(await store.claimPayment(id, "verifying", claim("worker-a"))).toBeUndefined()
  })

  it("refuses a claim on a payment that does not exist", async () => {
    const store = await getStore()
    expect(await store.claimPayment("pay_missing", "verifying", claim("worker-a"))).toBeUndefined()
  })

  /*
   * A worker that dies mid-finalization must not strand the payment in `verifying` forever.
   * The lapsed lease is the only thing that lets the next sweep pick it up.
   */
  it("lets a later worker take over once the lease has lapsed", async () => {
    const store = await getStore()
    const id = await seed()

    await store.claimPayment(id, "verifying", claim("dead-worker", -1_000))
    const takeover = await store.claimPayment(id, "verifying", claim("live-worker"))

    expect(takeover?.processingClaim?.owner).toBe("live-worker")
  })

  it("releases a claim so the next caller can take it", async () => {
    const store = await getStore()
    const id = await seed()

    await store.claimPayment(id, "verifying", claim("worker-a"))
    await store.releasePayment(id, "worker-a")

    const second = await store.claimPayment(id, "verifying", claim("worker-b"))
    expect(second?.processingClaim?.owner).toBe("worker-b")
  })

  it("ignores a release from anyone but the current holder", async () => {
    const store = await getStore()
    const id = await seed()

    await store.claimPayment(id, "verifying", claim("worker-a"))
    // A worker whose lease lapsed, finishing late, must not free its successor's claim.
    await store.releasePayment(id, "worker-stale")

    const payment = await store.getPayment(id)
    expect(payment?.processingClaim?.owner).toBe("worker-a")
  })

  it("does not leak the claim into the payment's public shape", async () => {
    const { serializePayment } = await import("../src/routes/payments.routes.js")
    const store = await getStore()
    const id = await seed()

    await store.claimPayment(id, "verifying", claim("worker-a"))
    const payment = await store.getPayment(id)

    expect(serializePayment(payment!)).not.toHaveProperty("processingClaim")
  })
})

describe("registry revert classification", () => {
  /*
   * This is the distinction that stops a verified payment being marked failed: the registry
   * refusing a *duplicate* write is success arriving late, while every other revert is a real
   * rejection. Matching on the decoded custom error name rather than message text is what keeps
   * that true across contract revisions.
   */
  it("treats already-registered reverts as duplicates", () => {
    expect(isAlreadyRegistered(new RegistryRevertError("PaymentAlreadyRegistered", "…"))).toBe(true)
    expect(isAlreadyRegistered(new RegistryRevertError("TransactionAlreadyUsed", "…"))).toBe(true)
  })

  it("treats every other revert as a genuine rejection", () => {
    expect(isAlreadyRegistered(new RegistryRevertError("InvalidFdcProof", "…"))).toBe(false)
    expect(isAlreadyRegistered(new RegistryRevertError("ReferenceMismatch", "…"))).toBe(false)
    expect(isAlreadyRegistered(new RegistryRevertError("AmountBelowMinimum", "…"))).toBe(false)
  })

  /*
   * An undecodable revert and a plain network failure are not duplicates. Treating either as one
   * would mark an unregistered payment verified — the exact failure this classification exists
   * to prevent.
   */
  it("does not treat an undecoded revert or a transport error as a duplicate", () => {
    expect(isAlreadyRegistered(new RegistryRevertError(undefined, "missing revert data"))).toBe(false)
    expect(isAlreadyRegistered(new Error("ETIMEDOUT"))).toBe(false)
  })
})
