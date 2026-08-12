import type { PaymentFailureCode, PaymentIntent, PaymentReconciliation } from "../domain/types.js"
import type { PaymentProof } from "./proof.js"
import { decodeStandardPaymentReference, dropsToXrp, hashXrplAddress } from "./xrpl.payment.js"
import { env } from "../config/env.js"

/**
 * Matching an attested payment against a payment intent.
 *
 * This runs on the *attested* data — what FDC says happened — never on anything the client sent.
 * Every rejection reason is explicit, because "payment failed" with no cause is the worst
 * possible outcome for a merchant debugging a real customer's order (master prompt §19).
 */

export interface MatchContext {
  intent: PaymentIntent
  /** Merchant's XRPL destination address, in plain form. */
  merchantXrplAddress: string
  /** Expected amount in drops, from the accepted quote. */
  expectedDrops: bigint
}

export type MatchOutcome =
  | { matched: true; reconciliation: PaymentReconciliation; attestedDrops: bigint }
  | { matched: false; failureCode: PaymentFailureCode; detail: string }

export function matchPaymentProof(proof: PaymentProof, context: MatchContext): MatchOutcome {
  const { responseBody, requestBody } = proof.data
  const { intent, merchantXrplAddress, expectedDrops } = context

  if (responseBody.status !== 0) {
    return {
      matched: false,
      failureCode: "TRANSACTION_NOT_FOUND",
      detail: `The XRPL transaction did not succeed (attested status ${responseBody.status}).`,
    }
  }

  const expectedDestination = hashXrplAddress(merchantXrplAddress)
  if (responseBody.receivingAddressHash.toLowerCase() !== expectedDestination.toLowerCase()) {
    return {
      matched: false,
      failureCode: "WRONG_DESTINATION",
      detail:
        `Payment ${requestBody.transactionId} went to a different address than the merchant's ` +
        `XRPL destination.`,
    }
  }

  // An FAssets payment carries the AssetManager's bytes32 reference, not the PayFlux one, so
  // the comparison is made against whichever this intent actually committed to.
  const reservation = intent.fassetsReservation
  if (reservation) {
    if (
      responseBody.standardPaymentReference.toLowerCase() !==
      reservation.paymentReference.toLowerCase()
    ) {
      return {
        matched: false,
        failureCode: "TRANSACTION_NOT_FOUND",
        detail:
          `The attested payment does not carry the FAssets reference this reservation requires ` +
          `(${reservation.paymentReference}), so it cannot mint FXRP.`,
      }
    }
  } else {
    const attestedReference = decodeStandardPaymentReference(responseBody.standardPaymentReference)
    if (attestedReference !== intent.paymentReference) {
      return {
        matched: false,
        failureCode: "TRANSACTION_NOT_FOUND",
        detail:
          `The attested payment carries reference "${attestedReference || "(none)"}" but this ` +
          `intent expects "${intent.paymentReference}".`,
      }
    }
  }

  const expiresAt = Math.floor(new Date(intent.expiresAt).getTime() / 1000)
  if (Number(responseBody.blockTimestamp) > expiresAt) {
    return {
      matched: false,
      failureCode: "PAYMENT_EXPIRED",
      detail:
        `The payment landed at ${new Date(Number(responseBody.blockTimestamp) * 1000).toISOString()}, ` +
        `after this intent expired at ${intent.expiresAt}.`,
    }
  }

  const received = responseBody.receivedAmount < 0n ? 0n : responseBody.receivedAmount
  const reconciliation = reconcile(expectedDrops, received)

  return { matched: true, reconciliation, attestedDrops: received }
}

/**
 * Amount reconciliation.
 *
 * A tolerance band absorbs the rounding that is unavoidable when a fiat amount is converted to a
 * volatile asset. Outside the band, the payment is reported as underpaid or overpaid — it is
 * never rounded into "paid" (master prompt §21, §22).
 */
export function reconcile(expected: bigint, received: bigint): PaymentReconciliation {
  const toleranceBps = BigInt(env.AMOUNT_TOLERANCE_BPS)
  const tolerance = (expected * toleranceBps) / 10_000n
  const difference = received - expected

  let outcome: PaymentReconciliation["outcome"] = "exact"
  if (difference < 0n && -difference > tolerance) outcome = "underpaid"
  else if (difference > 0n && difference > tolerance) outcome = "overpaid"

  return {
    expectedAmount: dropsToXrp(expected),
    receivedAmount: dropsToXrp(received),
    differenceAmount: dropsToXrp(difference < 0n ? -difference : difference),
    asset: "XRP",
    outcome,
    toleranceApplied: dropsToXrp(tolerance),
  }
}
