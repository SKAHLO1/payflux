import { describe, expect, it } from "vitest"
import { keccak256, toUtf8Bytes } from "ethers"
import { matchPaymentProof, reconcile } from "../src/verification/verification-result.js"
import {
  encodeStandardPaymentReference,
  decodeStandardPaymentReference,
  hashXrplAddress,
  xrpToDrops,
  dropsToXrp,
  buildMemo,
} from "../src/verification/xrpl.payment.js"
import { decodePaymentResponse, PAYMENT_RESPONSE_ABI, encodeBytes32Utf8 } from "../src/verification/proof.js"
import { AbiCoder } from "ethers"
import type { PaymentIntent } from "../src/domain/types.js"
import type { PaymentProof } from "../src/verification/proof.js"

const MERCHANT_XRPL = "rPayFluxDemoMerchantAddress000000000"
const REFERENCE = "pay_8F92K2"

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: "pay_abc123",
    merchantId: "merchant_demo",
    amount: "50.00",
    currency: "USD",
    acceptedAssets: ["XRP"],
    status: "verifying",
    paymentReference: REFERENCE,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function proof(overrides: Partial<PaymentProof["data"]["responseBody"]> = {}): PaymentProof {
  return {
    merkleProof: ["0x" + "11".repeat(32)],
    data: {
      attestationType: encodeBytes32Utf8("Payment"),
      sourceId: encodeBytes32Utf8("testXRP"),
      votingRound: 1_000_000n,
      lowestUsedTimestamp: 0n,
      requestBody: { transactionId: "0x" + "ab".repeat(32), inUtxo: 0, utxo: 0 },
      responseBody: {
        blockNumber: 100n,
        blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        sourceAddressHash: keccak256(toUtf8Bytes("rCustomer")),
        sourceAddressesRoot: "0x" + "00".repeat(32),
        receivingAddressHash: hashXrplAddress(MERCHANT_XRPL),
        intendedReceivingAddressHash: hashXrplAddress(MERCHANT_XRPL),
        spentAmount: 0n,
        intendedSpentAmount: 0n,
        receivedAmount: 73_210_000n,
        intendedReceivedAmount: 73_210_000n,
        standardPaymentReference: encodeStandardPaymentReference(REFERENCE),
        oneToOne: true,
        status: 0,
        ...overrides,
      },
    },
  }
}

describe("XRPL reference encoding", () => {
  it("round-trips a payment reference through the 32-byte encoding", () => {
    const encoded = encodeStandardPaymentReference(REFERENCE)
    expect(encoded).toHaveLength(66)
    expect(decodeStandardPaymentReference(encoded)).toBe(REFERENCE)
  })

  it("rejects a reference that will not fit a memo", () => {
    expect(() => encodeStandardPaymentReference("x".repeat(33))).toThrow(/exceeds 32 bytes/)
  })

  it("produces an uppercase hex memo the wallet can paste", () => {
    const memo = buildMemo(REFERENCE)
    expect(memo.memoDataHex).toMatch(/^[0-9A-F]{64}$/)
  })

  it("hashes addresses the way FDC does", () => {
    expect(hashXrplAddress(MERCHANT_XRPL)).toBe(keccak256(toUtf8Bytes(MERCHANT_XRPL)))
  })

  it("converts XRP and drops without float drift", () => {
    expect(xrpToDrops("73.21")).toBe(73_210_000n)
    expect(xrpToDrops("0.000001")).toBe(1n)
    expect(dropsToXrp(73_210_000n)).toBe("73.21")
    expect(dropsToXrp(1n)).toBe("0.000001")
  })
})

describe("proof decoding", () => {
  it("decodes an ABI-encoded Payment response", () => {
    const source = proof().data
    const encoded = AbiCoder.defaultAbiCoder().encode(
      [PAYMENT_RESPONSE_ABI],
      [
        [
          source.attestationType,
          source.sourceId,
          source.votingRound,
          source.lowestUsedTimestamp,
          [source.requestBody.transactionId, source.requestBody.inUtxo, source.requestBody.utxo],
          [
            source.responseBody.blockNumber,
            source.responseBody.blockTimestamp,
            source.responseBody.sourceAddressHash,
            source.responseBody.sourceAddressesRoot,
            source.responseBody.receivingAddressHash,
            source.responseBody.intendedReceivingAddressHash,
            source.responseBody.spentAmount,
            source.responseBody.intendedSpentAmount,
            source.responseBody.receivedAmount,
            source.responseBody.intendedReceivedAmount,
            source.responseBody.standardPaymentReference,
            source.responseBody.oneToOne,
            source.responseBody.status,
          ],
        ],
      ],
    )

    const decoded = decodePaymentResponse(encoded)
    expect(decoded.responseBody.receivedAmount).toBe(73_210_000n)
    expect(decodeStandardPaymentReference(decoded.responseBody.standardPaymentReference)).toBe(REFERENCE)
  })
})

describe("payment matching", () => {
  const context = {
    intent: intent(),
    merchantXrplAddress: MERCHANT_XRPL,
    expectedDrops: 73_210_000n,
  }

  it("accepts an exact payment", () => {
    const result = matchPaymentProof(proof(), context)
    expect(result.matched).toBe(true)
    if (result.matched) expect(result.reconciliation.outcome).toBe("exact")
  })

  it("rejects a payment sent to the wrong address", () => {
    const result = matchPaymentProof(
      proof({ receivingAddressHash: keccak256(toUtf8Bytes("rSomeoneElse")) }),
      context,
    )
    expect(result.matched).toBe(false)
    if (!result.matched) expect(result.failureCode).toBe("WRONG_DESTINATION")
  })

  it("rejects a payment carrying someone else's reference", () => {
    const result = matchPaymentProof(
      proof({ standardPaymentReference: encodeStandardPaymentReference("pay_OTHER1") }),
      context,
    )
    expect(result.matched).toBe(false)
    if (!result.matched) expect(result.failureCode).toBe("TRANSACTION_NOT_FOUND")
  })

  it("rejects a failed source transaction", () => {
    const result = matchPaymentProof(proof({ status: 1 }), context)
    expect(result.matched).toBe(false)
    if (!result.matched) expect(result.failureCode).toBe("TRANSACTION_NOT_FOUND")
  })

  it("rejects a payment that landed after expiry", () => {
    const expired = {
      ...context,
      intent: intent({ expiresAt: new Date(Date.now() - 600_000).toISOString() }),
    }
    const result = matchPaymentProof(proof(), expired)
    expect(result.matched).toBe(false)
    if (!result.matched) expect(result.failureCode).toBe("PAYMENT_EXPIRED")
  })

  it("reports underpayment rather than accepting it", () => {
    const result = matchPaymentProof(proof({ receivedAmount: 70_000_000n }), context)
    expect(result.matched).toBe(true)
    if (result.matched) {
      expect(result.reconciliation.outcome).toBe("underpaid")
      expect(result.reconciliation.differenceAmount).toBe("3.21")
    }
  })

  it("reports overpayment with the excess", () => {
    const result = matchPaymentProof(proof({ receivedAmount: 76_000_000n }), context)
    expect(result.matched).toBe(true)
    if (result.matched) {
      expect(result.reconciliation.outcome).toBe("overpaid")
      expect(result.reconciliation.differenceAmount).toBe("2.79")
    }
  })
})

describe("reconciliation tolerance", () => {
  it("treats a difference inside the tolerance band as exact", () => {
    // 50 bps of 73.21 XRP is ~0.366 XRP.
    const result = reconcile(73_210_000n, 73_000_000n)
    expect(result.outcome).toBe("exact")
  })

  it("treats a difference outside the band as underpaid", () => {
    const result = reconcile(73_210_000n, 72_000_000n)
    expect(result.outcome).toBe("underpaid")
  })
})
