import { randomUUID } from "node:crypto"
import type { Merchant, PaymentIntent, PaymentReconciliation } from "../domain/types.js"
import * as coston2 from "../verification/coston2.payment.js"
import { getStore } from "../store/index.js"
import { ROUTER_CONFIG } from "../routing/router.js"
import * as payments from "./payment.service.js"
import * as fdc from "../verification/fdc.service.js"
import * as registry from "../chain/payment-registry.js"
import { serializeProof, toContractProof } from "../verification/proof.js"
import * as settlement from "../settlement/settlement.service.js"
import { matchPaymentProof } from "../verification/verification-result.js"
import {
  getIncomingPayments,
  getTransaction,
  encodeStandardPaymentReference,
  xrpToDrops,
  explorerTxUrl,
  type XrplPaymentTransaction,
} from "../verification/xrpl.payment.js"
import { NETWORKS, env } from "../config/env.js"
import { startSweeper } from "../util/sweeper.js"

/**
 * The verification orchestrator: XRPL transaction -> FDC attestation -> Coston2 record.
 *
 * Two rules govern this file.
 *
 * 1. A transaction hash supplied by a client is a *hint*, never evidence (master prompt §18).
 *    It only ever narrows which transaction to attest; the payment's fate is decided entirely by
 *    the attested data that comes back from FDC.
 *
 * 2. No status advances on a timer. `verifying` -> `verified` happens when, and only when, a
 *    finalized FDC proof has been matched and accepted by PaymentRegistry on Coston2.
 */

export interface VerifyOptions {
  /** Untrusted hint from the checkout page. */
  transactionHashHint?: string
  /** Wait for round finalization inline. The API uses false and streams progress over SSE. */
  waitForFinalization?: boolean
}

/**
 * Entry point for verification, dispatching on the asset the customer chose.
 *
 * Two genuinely different mechanisms sit behind one call:
 *
 *   XRP           external chain  -> FDC attestation, then PaymentRegistry
 *   FXRP / C2FLR  this chain      -> read the transaction directly, then PaymentRegistry
 *
 * The native path needs no attestation because Coston2 *is* the chain PayFlux runs on. Both end
 * at the same place: a verified record on the registry and the same payment states.
 */
export async function verifyPayment(
  paymentId: string,
  merchant: Merchant,
  options: VerifyOptions = {},
): Promise<VerifyOutcome> {
  const payment = await payments.getPayment(paymentId)
  const asset = payment.selectedAsset?.toUpperCase()

  if (asset === "FXRP" || asset === "C2FLR") {
    return verifyNativePayment(paymentId, merchant, asset, options)
  }
  return verifyXrplPayment(paymentId, merchant, options)
}

export interface VerifyOutcome {
  payment: PaymentIntent
  status: "verified" | "pending" | "failed" | "no_payment_found"
  detail?: string
}

// ---------------------------------------------------------------------------
// Finalization claims
// ---------------------------------------------------------------------------

/**
 * How long a finalization claim is held before it lapses.
 *
 * Long enough to cover the slowest honest run — proof retrieval, a PaymentRegistry write and an
 * FAssets mint, each waiting on Coston2 confirmations — and short enough that a worker killed
 * mid-flight does not delay the retry by much. If it does lapse early and two workers overlap,
 * the registry still refuses the second write; the claim exists to make that the rare case
 * rather than the routine one.
 */
const CLAIM_TTL_MS = 120_000

/** Identifies this process in claims. Diagnostic only — uniqueness is all that is required. */
const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`

/** Statuses that mean finalization already ran and succeeded. */
const FINALIZED_STATUSES = ["verified", "overpaid", "settling", "settled"]

async function claimForFinalization(paymentId: string): Promise<PaymentIntent | undefined> {
  const store = await getStore()
  const now = Date.now()
  return store.claimPayment(paymentId, "verifying", {
    owner: WORKER_ID,
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CLAIM_TTL_MS).toISOString(),
  })
}

async function releaseFinalizationClaim(paymentId: string): Promise<void> {
  try {
    const store = await getStore()
    await store.releasePayment(paymentId, WORKER_ID)
  } catch (error) {
    // Never let cleanup mask the outcome of the finalization itself. A claim left behind lapses
    // on its own after CLAIM_TTL_MS.
    console.error(`[payflux] failed to release finalization claim for ${paymentId}:`, error)
  }
}

/** What to report when the claim could not be taken, based on where the payment actually got to. */
async function describeUnclaimed(paymentId: string): Promise<VerifyOutcome> {
  const payment = await payments.getPayment(paymentId)

  if (FINALIZED_STATUSES.includes(payment.status)) {
    return { payment, status: "verified" }
  }
  if (["failed", "expired", "partially_paid"].includes(payment.status)) {
    return { payment, status: "failed", detail: payment.failureDetail }
  }
  // Still `verifying`: another worker holds the claim and is finalizing right now.
  return {
    payment,
    status: "pending",
    detail: "This payment is already being finalized. Poll for the result rather than retrying.",
  }
}

/**
 * Finds the XRPL transaction that belongs to this intent.
 *
 * Matching is on the standard payment reference — the same field FDC will attest — so a match
 * here and a match on-chain are the same claim, checked twice.
 */
export async function findMatchingXrplPayment(
  payment: PaymentIntent,
  merchant: Merchant,
  hint?: string,
): Promise<XrplPaymentTransaction | undefined> {
  // When collateral is reserved, the customer pays the *agent* with the *agent's* reference —
  // that is the only shape FAssets will mint against. Matching has to follow the money.
  const reservation = payment.fassetsReservation
  const expectedDestination = reservation?.paymentAddress ?? merchant.xrplAddress
  const expectedReference = (
    reservation?.paymentReference ?? encodeStandardPaymentReference(payment.paymentReference)
  ).toLowerCase()

  const matches = (tx: XrplPaymentTransaction) =>
    tx.successful &&
    tx.isXrp &&
    tx.destination === expectedDestination &&
    tx.standardPaymentReference?.toLowerCase() === expectedReference

  if (hint) {
    const tx = await getTransaction(hint)
    // The hint is only accepted if it independently satisfies every matching rule.
    if (tx && matches(tx)) return tx
  }

  if (!expectedDestination) return undefined
  const recent = await getIncomingPayments(expectedDestination, 50)
  return recent.find(matches)
}

/**
 * Runs the full verification pipeline for a payment.
 *
 * Safe to call repeatedly — it resumes from whatever stage the payment reached, which is what
 * makes it usable both from the API and from the watcher.
 */
async function verifyXrplPayment(
  paymentId: string,
  merchant: Merchant,
  options: VerifyOptions = {},
): Promise<VerifyOutcome> {
  let payment = await payments.getPayment(paymentId)

  if (payment.status === "settled" || payment.status === "verified" || payment.status === "settling") {
    return { payment, status: "verified" }
  }
  if (payment.status === "failed" || payment.status === "expired") {
    return { payment, status: "failed", detail: payment.failureDetail }
  }
  if (!merchant.xrplAddress) {
    return {
      payment,
      status: "failed",
      detail: "The merchant has no XRPL address configured, so no XRP payment can be matched.",
    }
  }

  // --- Stage 0: locate the transaction --------------------------------
  const tx = await findMatchingXrplPayment(payment, merchant, options.transactionHashHint)
  if (!tx) {
    return {
      payment,
      status: "no_payment_found",
      detail:
        `No validated XRPL payment carrying reference ${payment.paymentReference} has reached ` +
        `${merchant.xrplAddress} yet.`,
    }
  }

  if (payment.status === "awaiting_payment" || payment.status === "created") {
    payment = await payments.transition(payment, "payment_detected", "xrpl-watcher", {
      transactionHash: tx.hash,
      explorerUrl: explorerTxUrl(tx.hash),
      deliveredDrops: tx.deliveredDrops.toString(),
      ledgerIndex: tx.ledgerIndex,
    })
  }

  // --- Stage 1: prepare the attestation request -----------------------
  payment = await payments.transition(payment, "verifying", "fdc", { transactionHash: tx.hash })
  await payments.applyPatch(payment.id, {
    verification: {
      method: "fdc-payment",
      attestationType: "Payment",
      sourceChain: "xrpl-testnet",
      sourceTransactionId: tx.hash,
      status: "pending",
    },
  })

  let prepared: fdc.PrepareResult
  try {
    // Retries while the verifier's indexer catches up with XRPL — see the note in fdc.service.
    prepared = await fdc.prepareXrpPaymentRequestWithRetry(tx.hash, {
      onRetry: (attempt, detail) => {
        void payments.recordEvent(payment.id, "fdc.awaiting_indexer", "fdc", {
          attempt,
          detail,
          transactionHash: tx.hash,
        })
      },
    })
    await payments.recordEvent(payment.id, "fdc.requested", "fdc", {
      fdcRequestId: prepared.requestId,
      attestationType: "Payment",
      sourceId: "testXRP",
    })
  } catch (error) {
    return await failVerification(
      payment,
      "FDC_REQUEST_FAILED",
      error instanceof Error ? error.message : String(error),
    )
  }

  // --- Stage 2: submit on Coston2 -------------------------------------
  let submitted: fdc.SubmitResult
  try {
    submitted = await fdc.submitAttestationRequest(prepared.abiEncodedRequest)
    await payments.applyPatch(payment.id, {
      verification: {
        method: "fdc-payment",
        attestationType: "Payment",
        sourceChain: "xrpl-testnet",
        sourceTransactionId: tx.hash,
        fdcRequestId: prepared.requestId,
        // Persisted so the finalization sweeper can retrieve the proof later, even across a
        // restart — the request cannot be reconstructed without it.
        abiEncodedRequest: prepared.abiEncodedRequest,
        votingRound: submitted.votingRound,
        status: "requested",
      },
    })
    await payments.recordEvent(payment.id, "fdc.submitted", "coston2", {
      transactionHash: submitted.transactionHash,
      votingRound: submitted.votingRound,
      fee: submitted.fee,
      explorerUrl: submitted.explorerUrl,
    })
  } catch (error) {
    return await failVerification(
      payment,
      "FDC_REQUEST_FAILED",
      error instanceof Error ? error.message : String(error),
    )
  }

  // --- Stage 3: wait for finalization ---------------------------------
  // Rounds take minutes. The API returns `pending` and the caller polls or listens on SSE;
  // only the PoC script blocks inline.
  if (!options.waitForFinalization) {
    return {
      payment: await payments.getPayment(payment.id),
      status: "pending",
      detail:
        `FDC attestation submitted in voting round ${submitted.votingRound}. ` +
        `The proof becomes retrievable once the round finalizes.`,
    }
  }

  return completeVerification(payment.id, merchant, prepared, submitted.votingRound)
}

/**
 * Stage 4-6: retrieve the proof, match it against the intent, register it on Coston2.
 * Split out so the watcher can resume a payment whose round has since finalized.
 */
export async function completeVerification(
  paymentId: string,
  merchant: Merchant,
  prepared: fdc.PrepareResult,
  votingRound: number,
): Promise<VerifyOutcome> {
  const payment = await payments.getPayment(paymentId)

  let proof
  try {
    proof = await fdc.waitForProof(votingRound, prepared.abiEncodedRequest, {
      onTick: (attempt) => {
        if (attempt % 6 === 1) {
          void payments.recordEvent(paymentId, "fdc.awaiting_finalization", "fdc", {
            votingRound,
            attempt,
          })
        }
      },
    })
  } catch (error) {
    return await failVerification(
      payment,
      "FDC_REQUEST_PENDING",
      error instanceof Error ? error.message : String(error),
    )
  }

  return finalizeWithProof(paymentId, merchant, proof, prepared, votingRound)
}

/**
 * The half of verification that runs once a proof exists: match it, register it, transition.
 *
 * Split out from the waiting so it can be driven two ways — blocking (the PoC script) and
 * polling (the finalization sweeper). The sweeper is what actually completes payments in the
 * running product; without it a payment submits its attestation and then sits in `verifying`
 * forever, because nothing would ever come back for the proof.
 *
 * Everything past this point is irreversible and costs gas, so entry is gated on an exclusive
 * claim. The guard lives here rather than at each call site because this is the function that
 * does the spending — a future caller inherits the protection instead of having to remember it.
 */
export async function finalizeWithProof(
  paymentId: string,
  merchant: Merchant,
  proof: Awaited<ReturnType<typeof fdc.waitForProof>>,
  prepared: fdc.PrepareResult,
  votingRound: number,
): Promise<VerifyOutcome> {
  const claimed = await claimForFinalization(paymentId)
  if (!claimed) return describeUnclaimed(paymentId)

  try {
    return await runFinalization(paymentId, merchant, proof, prepared, votingRound)
  } finally {
    await releaseFinalizationClaim(paymentId)
  }
}

async function runFinalization(
  paymentId: string,
  merchant: Merchant,
  proof: Awaited<ReturnType<typeof fdc.waitForProof>>,
  prepared: fdc.PrepareResult,
  votingRound: number,
): Promise<VerifyOutcome> {
  let payment = await payments.getPayment(paymentId)

  await payments.recordEvent(paymentId, "fdc.finalized", "fdc", {
    votingRound,
    merkleProofLength: proof.merkleProof.length,
    attestedAmount: proof.data.responseBody.receivedAmount.toString(),
    proof: serializeProof(proof),
  })

  // --- Stage 5: match the attested data against the intent ------------
  if (!payment.quote) {
    return await failVerification(payment, "WRONG_AMOUNT", "The payment has no locked quote.")
  }

  // With a reservation, the agent dictates both the destination and the exact amount that will
  // mint — the merchant's own address and the fiat-derived quote are no longer what to check.
  const reservation = payment.fassetsReservation
  const expectedDrops = reservation
    ? BigInt(reservation.totalUBA)
    : xrpToDrops(payment.selectedRoute?.estimatedInputAmount ?? payment.quote.assetAmount)

  const match = matchPaymentProof(proof, {
    intent: payment,
    merchantXrplAddress: reservation?.paymentAddress ?? merchant.xrplAddress!,
    expectedDrops,
  })

  if (!match.matched) {
    return await failVerification(payment, match.failureCode, match.detail)
  }

  await payments.applyPatch(paymentId, { reconciliation: match.reconciliation })

  // Underpayment does not become a successful payment, whatever the proof says.
  if (match.reconciliation.outcome === "underpaid") {
    payment = await payments.getPayment(paymentId)
    const updated = await payments.transition(payment, "partially_paid", "fdc", {
      expected: match.reconciliation.expectedAmount,
      received: match.reconciliation.receivedAmount,
      remaining: match.reconciliation.differenceAmount,
    })
    return {
      payment: updated,
      status: "failed",
      detail: `Underpaid by ${match.reconciliation.differenceAmount} XRP.`,
    }
  }

  // --- Stage 6: register on Coston2 -----------------------------------
  let registryResult: registry.RegistryWriteResult | undefined
  try {
    registryResult = await registry.registerVerifiedPayment(paymentId, proof)
    await payments.recordEvent(paymentId, "registry.payment_verified", "coston2", {
      transactionHash: registryResult.transactionHash,
      blockNumber: registryResult.blockNumber,
      explorerUrl: registryResult.explorerUrl,
    })
  } catch (error) {
    // "Already registered" is not a rejection — it is the chain enforcing exactly-once after a
    // duplicate attempt, and the payment it refers to is verified. Failing here would mark a
    // payment failed that Coston2 says is good, so reconcile against the registry instead.
    if (registry.isAlreadyRegistered(error)) {
      return await reconcileAlreadyRegistered(paymentId, match.reconciliation)
    }
    return await failVerification(
      payment,
      "FDC_PROOF_INVALID",
      `PaymentRegistry rejected the proof: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  await payments.applyPatch(paymentId, {
    verification: {
      method: "fdc-payment",
      attestationType: "Payment",
      sourceChain: "xrpl-testnet",
      sourceTransactionId: proof.data.requestBody.transactionId,
      fdcRequestId: prepared.requestId,
      votingRound,
      proofRetrievedAt: new Date().toISOString(),
      coston2TransactionHash: registryResult.transactionHash,
      registryAddress: registry.registryAddress(),
      verifiedAt: new Date().toISOString(),
      attestedAmount: proof.data.responseBody.receivedAmount.toString(),
      status: "verified",
    },
  })

  payment = await payments.getPayment(paymentId)
  const nextStatus = match.reconciliation.outcome === "overpaid" ? "overpaid" : "verified"
  let verified = await payments.transition(payment, nextStatus, "coston2", {
    registryTransaction: registryResult.transactionHash,
    explorerUrl: NETWORKS.flare.txUrl(registryResult.transactionHash),
    reconciliation: match.reconciliation,
  })

  /*
   * Settle, using the very same proof.
   *
   * This is the point of reserving collateral up front: one customer transfer, one attestation,
   * used twice — once to prove the payment to PaymentRegistry, once to mint FXRP through
   * `executeMinting`. Nothing is converted or bridged; the customer's XRP *is* the underlying
   * backing the minted FXRP.
   *
   * A settlement failure does not undo the verification. The payment stays verified with a real
   * on-chain record, and the failure is reported for what it is.
   */
  if (verified.fassetsReservation) {
    try {
      await settlement.executeSettlement({
        payment: verified,
        merchant,
        proof: toContractProof(proof),
        collateralReservationId: verified.fassetsReservation.collateralReservationId,
      })
      verified = await payments.getPayment(paymentId)
    } catch (error) {
      await payments.recordEvent(paymentId, "settlement.failed", "fassets-mint", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { payment: verified, status: "verified" }
}

// ---------------------------------------------------------------------------
// Native Coston2 verification (FXRP, C2FLR)
// ---------------------------------------------------------------------------

/** Confirmations before a native payment is treated as final. Coston2 blocks are ~1.8s. */
const NATIVE_CONFIRMATIONS = 2

/**
 * Finds the Coston2 transfer belonging to this intent.
 *
 * A C2FLR payer can attach the payment reference as calldata, which binds exactly. FXRP cannot
 * — ERC-20 `transfer` has no memo field — so it is matched on (destination, amount, window), and
 * the match is *refused* when another open intent expects an indistinguishable amount. Crediting
 * the wrong order is worse than asking the customer for their transaction hash.
 */
async function findMatchingNativeTransfer(
  payment: PaymentIntent,
  merchant: Merchant,
  asset: "C2FLR" | "FXRP",
  hint?: string,
): Promise<coston2.Coston2Transfer | undefined> {
  if (!merchant.flareAddress) return undefined

  const decimals = await coston2.decimalsFor(asset)
  const expected = coston2.toSmallestUnit(
    payment.selectedRoute?.estimatedInputAmount ?? payment.quote?.assetAmount ?? "0",
    decimals,
  )

  // A hash from the client is settled against the chain, not believed.
  if (hint) {
    const transfer = await coston2.verifyTransactionHash(hint, merchant.flareAddress, asset)
    if (transfer.reference && transfer.reference !== payment.paymentReference) return undefined
    return transfer
  }

  const createdAt = Math.floor(new Date(payment.createdAt).getTime() / 1000)
  const expiresAt = Math.floor(new Date(payment.expiresAt).getTime() / 1000)
  const head = await coston2.currentBlock()
  // Coston2 targets ~1.8s blocks; look back far enough to cover the intent's whole window.
  const lookback = Math.ceil(((expiresAt - createdAt) * 1.5) / 1.8) + 50
  const fromBlock = Math.max(0, head - lookback)

  const transfers =
    asset === "FXRP"
      ? await coston2.getIncomingFxrpTransfers(merchant.flareAddress, fromBlock, head)
      : await coston2.getIncomingNativeTransfers(merchant.flareAddress, fromBlock, head)

  const store = await getStore()
  const inWindow = transfers.filter(
    (transfer) => transfer.timestamp >= createdAt && transfer.timestamp <= expiresAt,
  )

  // An exact reference wins outright — no amount guessing needed.
  const byReference = inWindow.find((transfer) => transfer.reference === payment.paymentReference)
  if (byReference) return byReference

  const tolerance = (expected * BigInt(ROUTER_CONFIG.amountToleranceBps)) / 10_000n
  const candidates = inWindow.filter((transfer) => {
    const delta = transfer.amount > expected ? transfer.amount - expected : expected - transfer.amount
    return delta <= tolerance
  })
  if (candidates.length === 0) return undefined

  // Do not reuse a transfer that already settled another intent.
  const openPayments = await store.listPayments(payment.merchantId, 200)
  const usedHashes = new Set(
    openPayments
      .map((other) => other.verification?.sourceTransactionId?.toLowerCase())
      .filter((hash): hash is string => Boolean(hash)),
  )
  const unused = candidates.filter((transfer) => !usedHashes.has(transfer.hash.toLowerCase()))
  if (unused.length === 0) return undefined

  // Refuse to guess when another live intent expects the same amount.
  const rivals = openPayments.filter(
    (other) =>
      other.id !== payment.id &&
      other.selectedAsset?.toUpperCase() === asset &&
      ["awaiting_payment", "payment_detected", "verifying"].includes(other.status),
  )
  const rivalAmounts = rivals.map((other) =>
    coston2.toSmallestUnit(
      other.selectedRoute?.estimatedInputAmount ?? other.quote?.assetAmount ?? "0",
      decimals,
    ),
  )
  if (coston2.isAmbiguous(unused[0].amount, rivalAmounts, ROUTER_CONFIG.amountToleranceBps)) {
    return undefined
  }

  return unused[0]
}

export async function verifyNativePayment(
  paymentId: string,
  merchant: Merchant,
  asset: "C2FLR" | "FXRP",
  options: VerifyOptions = {},
): Promise<VerifyOutcome> {
  let payment = await payments.getPayment(paymentId)

  if (["settled", "verified", "settling", "overpaid"].includes(payment.status)) {
    return { payment, status: "verified" }
  }
  if (payment.status === "failed" || payment.status === "expired") {
    return { payment, status: "failed", detail: payment.failureDetail }
  }
  if (!merchant.flareAddress) {
    return {
      payment,
      status: "failed",
      detail: "The merchant has no Coston2 address configured, so no payment can be matched.",
    }
  }

  let transfer: coston2.Coston2Transfer | undefined
  try {
    transfer = await findMatchingNativeTransfer(payment, merchant, asset, options.transactionHashHint)
  } catch (error) {
    if (error instanceof coston2.NativeTransferError) {
      return await failVerification(
        payment,
        error.code === "WRONG_DESTINATION" ? "WRONG_DESTINATION" : "TRANSACTION_NOT_FOUND",
        error.message,
      )
    }
    throw error
  }

  if (!transfer) {
    return {
      payment,
      status: "no_payment_found",
      detail:
        `No ${asset} transfer matching this payment has reached ${merchant.flareAddress} yet. ` +
        `If you have already paid, submit the transaction hash to match it exactly.`,
    }
  }

  if (payment.status === "awaiting_payment" || payment.status === "created") {
    payment = await payments.transition(payment, "payment_detected", "coston2-watcher", {
      transactionHash: transfer.hash,
      explorerUrl: transfer.explorerUrl,
      blockNumber: transfer.blockNumber,
    })
  }

  payment = await payments.transition(payment, "verifying", "coston2", {
    transactionHash: transfer.hash,
  })

  // Wait for the transfer to be a couple of blocks deep before treating it as final.
  if (transfer.confirmations < NATIVE_CONFIRMATIONS) {
    await payments.recordEvent(paymentId, "coston2.awaiting_confirmations", "coston2", {
      confirmations: transfer.confirmations,
      required: NATIVE_CONFIRMATIONS,
    })
    return {
      payment,
      status: "pending",
      detail: `Waiting for ${NATIVE_CONFIRMATIONS} confirmations (currently ${transfer.confirmations}).`,
    }
  }

  const decimals = await coston2.decimalsFor(asset)
  const expected = coston2.toSmallestUnit(
    payment.selectedRoute?.estimatedInputAmount ?? payment.quote?.assetAmount ?? "0",
    decimals,
  )
  const reconciliation = reconcileNative(expected, transfer.amount, asset, decimals)
  await payments.applyPatch(paymentId, { reconciliation })

  if (reconciliation.outcome === "underpaid") {
    payment = await payments.getPayment(paymentId)
    const updated = await payments.transition(payment, "partially_paid", "coston2", {
      expected: reconciliation.expectedAmount,
      received: reconciliation.receivedAmount,
      remaining: reconciliation.differenceAmount,
    })
    return {
      payment: updated,
      status: "failed",
      detail: `Underpaid by ${reconciliation.differenceAmount} ${asset}.`,
    }
  }

  return finalizeNativePayment(paymentId, asset, transfer, reconciliation)
}

/**
 * The irreversible tail of the native path, behind the same claim as the FDC path.
 *
 * Split out for exactly one reason: a claim has to be released on every exit, and that is only
 * reliable when the guarded work is one function with one `finally`.
 */
async function finalizeNativePayment(
  paymentId: string,
  asset: "C2FLR" | "FXRP",
  transfer: coston2.Coston2Transfer,
  reconciliation: PaymentReconciliation,
): Promise<VerifyOutcome> {
  const claimed = await claimForFinalization(paymentId)
  if (!claimed) return describeUnclaimed(paymentId)

  try {
    return await runNativeFinalization(paymentId, asset, transfer, reconciliation)
  } finally {
    await releaseFinalizationClaim(paymentId)
  }
}

async function runNativeFinalization(
  paymentId: string,
  asset: "C2FLR" | "FXRP",
  transfer: coston2.Coston2Transfer,
  reconciliation: PaymentReconciliation,
): Promise<VerifyOutcome> {
  let payment = await payments.getPayment(paymentId)

  // Record on Coston2. Role-gated and tagged FLARE_NATIVE, so it is never confused with an
  // FDC-verified cross-chain payment.
  let registryResult: registry.RegistryWriteResult | undefined
  try {
    registryResult = await registry.recordNativePayment(
      paymentId,
      asset,
      transfer.hash,
      transfer.amount,
    )
    await payments.recordEvent(paymentId, "registry.payment_verified", "coston2", {
      transactionHash: registryResult.transactionHash,
      blockNumber: registryResult.blockNumber,
      explorerUrl: registryResult.explorerUrl,
    })
  } catch (error) {
    // Same reasoning as the FDC path: a duplicate record means this payment is already on the
    // registry, not that it was refused.
    if (registry.isAlreadyRegistered(error)) {
      return await reconcileAlreadyRegistered(paymentId, reconciliation)
    }
    return await failVerification(
      payment,
      "FDC_PROOF_INVALID",
      `PaymentRegistry rejected the native payment: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  await payments.applyPatch(paymentId, {
    verification: {
      method: "flare-native",
      sourceChain: "coston2",
      sourceTransactionId: transfer.hash,
      coston2TransactionHash: registryResult.transactionHash,
      registryAddress: registry.registryAddress(),
      verifiedAt: new Date().toISOString(),
      attestedAmount: transfer.amount.toString(),
      status: "verified",
    },
  })

  payment = await payments.getPayment(paymentId)
  const nextStatus = reconciliation.outcome === "overpaid" ? "overpaid" : "verified"
  const verified = await payments.transition(payment, nextStatus, "coston2", {
    registryTransaction: registryResult.transactionHash,
    explorerUrl: NETWORKS.flare.txUrl(registryResult.transactionHash),
    reconciliation,
  })

  return { payment: verified, status: "verified" }
}

function reconcileNative(
  expected: bigint,
  received: bigint,
  asset: string,
  decimals: number,
): PaymentReconciliation {
  const tolerance = (expected * BigInt(ROUTER_CONFIG.amountToleranceBps)) / 10_000n
  const difference = received - expected

  let outcome: PaymentReconciliation["outcome"] = "exact"
  if (difference < 0n && -difference > tolerance) outcome = "underpaid"
  else if (difference > 0n && difference > tolerance) outcome = "overpaid"

  return {
    expectedAmount: coston2.formatAmount(expected, decimals),
    receivedAmount: coston2.formatAmount(received, decimals),
    differenceAmount: coston2.formatAmount(difference < 0n ? -difference : difference, decimals),
    asset,
    outcome,
    toleranceApplied: coston2.formatAmount(tolerance, decimals),
  }
}

// ---------------------------------------------------------------------------
// FDC finalization sweeper
// ---------------------------------------------------------------------------

/**
 * Completes payments whose attestation round has finalized.
 *
 * Submitting an FDC request and waiting for its proof are minutes apart, so the request path
 * cannot block on it. This sweeper is the other half: it finds payments parked in `verifying`,
 * asks the Data Availability layer whether the proof exists yet, and finishes the ones that are
 * ready. State lives on the payment record, so a restart mid-round resumes rather than stranding
 * the payment.
 */
export function startFdcFinalizationSweeper(intervalMs = 20_000 * env.PAYFLUX_POLL_SCALE) {
  const tick = async () => {
    {
      const store = await getStore()
      const pending = await store.listPaymentsByStatus("verifying", 25)

      for (const payment of pending) {
        const verification = payment.verification
        if (
          verification?.method !== "fdc-payment" ||
          verification.status !== "requested" ||
          verification.votingRound === undefined
        ) {
          continue
        }

        const merchant = await store.getMerchant(payment.merchantId)
        if (!merchant) continue

        // `prepareRequest` is deterministic for a given transaction, so a payment whose encoded
        // request was never stored — or was lost — can still be finalized by rebuilding it
        // rather than being stranded in `verifying`.
        let abiEncodedRequest = verification.abiEncodedRequest
        if (!abiEncodedRequest && verification.sourceTransactionId) {
          abiEncodedRequest = await fdc
            .prepareXrpPaymentRequest(verification.sourceTransactionId)
            .then((prepared) => prepared.abiEncodedRequest)
            .catch(() => undefined)
        }
        if (!abiEncodedRequest) continue

        // A single non-blocking probe. Absent simply means the round has not finalized.
        const proof = await fdc
          .retrieveProof(verification.votingRound, abiEncodedRequest)
          .catch((error) => {
            console.error(`[payflux] proof retrieval failed for ${payment.id}:`, error)
            return undefined
          })

        if (!proof) continue

        await finalizeWithProof(
          payment.id,
          merchant,
          proof,
          { abiEncodedRequest, requestId: verification.fdcRequestId ?? "" },
          verification.votingRound,
        ).catch((error) => {
          console.error(`[payflux] finalization failed for ${payment.id}:`, error)
        })
      }

      // Payments awaiting a proof keep the loop at full speed; nothing pending lets it idle.
      return pending.length > 0
    }
  }

  console.log(`[payflux] FDC finalization sweeper polling every ${intervalMs / 1000}s when busy`)
  return startSweeper({ name: "FDC finalization sweeper", intervalMs, tick })
}

/**
 * Brings the store back in line with a registry that already holds this payment.
 *
 * Two situations arrive here, and both mean the same thing — the on-chain write happened.
 *
 *   1. A duplicate finalization attempt: a claim lapsed and was retried, or a caller reached the
 *      registry before the claim existed. The winner's record stands.
 *   2. A crash between the on-chain write and the store update, which leaves a payment verified
 *      on Coston2 and stuck in `verifying` here. Nothing else recovers this.
 *
 * The chain is the record of truth, so read it back and make the store agree rather than
 * inventing a status from what this call happened to be carrying.
 */
async function reconcileAlreadyRegistered(
  paymentId: string,
  reconciliation?: PaymentReconciliation,
): Promise<VerifyOutcome> {
  await payments.recordEvent(paymentId, "registry.already_registered", "coston2", {
    detail: "PaymentRegistry already holds a verified record for this payment.",
  })

  const payment = await payments.getPayment(paymentId)
  if (FINALIZED_STATUSES.includes(payment.status)) {
    return { payment, status: "verified" }
  }

  const onChain = await registry.getVerifiedPayment(paymentId).catch(() => undefined)
  if (!onChain) {
    // The registry refused the write but has no record to point at. That is a real
    // inconsistency, not a duplicate, and reporting it as verified would be a lie — leave the
    // payment in `verifying` so the next sweep retries it.
    return {
      payment,
      status: "pending",
      detail:
        "PaymentRegistry reports this payment as already recorded, but no record could be read " +
        "back. Left unverified for the next sweep.",
    }
  }

  await payments.applyPatch(paymentId, {
    verification: {
      ...(payment.verification ?? { method: "fdc-payment", sourceChain: "xrpl-testnet" }),
      registryAddress: registry.registryAddress(),
      // The registry's own timestamp, not this process's clock — it is when the payment was
      // actually verified, which may have been in another process some time ago.
      verifiedAt: new Date(onChain.timestamp * 1000).toISOString(),
      attestedAmount: onChain.amount,
      status: "verified",
    },
    ...(reconciliation ? { reconciliation } : {}),
  })

  const current = await payments.getPayment(paymentId)
  const nextStatus = reconciliation?.outcome === "overpaid" ? "overpaid" : "verified"
  const verified = await payments.transition(current, nextStatus, "coston2", {
    externalTransactionId: onChain.externalTransactionId,
    detail: "Reconciled from the on-chain record after a duplicate registration attempt.",
  })

  return { payment: verified, status: "verified" }
}

async function failVerification(
  payment: PaymentIntent,
  code: Parameters<typeof payments.fail>[1],
  detail: string,
): Promise<VerifyOutcome> {
  await payments.applyPatch(payment.id, {
    verification: {
      ...(payment.verification ?? {
        method: "fdc-payment",
        sourceChain: "xrpl-testnet",
      }),
      status: "failed",
      failureCode: code,
      failureDetail: detail,
    },
  })
  const failed = await payments.fail(payment, code, detail)
  return { payment: failed, status: "failed", detail }
}
