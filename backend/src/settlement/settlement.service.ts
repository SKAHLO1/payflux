import type { Merchant, PaymentIntent, Settlement, SettlementQuote, SettlementRequest } from "../domain/types.js"
import { FAssetsMintProvider } from "./fassets.provider.js"
import { FlareNativeProvider } from "./flare-native.provider.js"
import type { SettlementContext, SettlementProvider } from "./provider.js"
import { SettlementUnavailableError } from "./provider.js"
import * as payments from "../payments/payment.service.js"
import { getStore } from "../store/index.js"
import { enqueue } from "../webhooks/dispatcher.js"
import { dropsToXrp } from "../verification/xrpl.payment.js"

/**
 * Routes a settlement to a provider and drives it to a terminal state.
 *
 * The service never fabricates a completed settlement: `settled` is reached only when a provider
 * returns a settlement carrying a confirmed transaction hash and a verified balance change.
 */

const PROVIDERS: SettlementProvider[] = [new FAssetsMintProvider(), new FlareNativeProvider()]

export function findProvider(sourceAsset: string, destinationAsset: string): SettlementProvider | undefined {
  return PROVIDERS.find((p) => p.supports(sourceAsset, destinationAsset))
}

export function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name }))
}

export async function quoteSettlement(request: SettlementRequest): Promise<SettlementQuote> {
  const provider = findProvider(request.sourceAsset, request.destinationAsset)
  if (!provider) {
    throw new SettlementUnavailableError(
      "router",
      `No settlement provider implements ${request.sourceAsset} -> ${request.destinationAsset}. ` +
        `PayFlux does not invent conversion routes.`,
    )
  }
  return provider.quote(request)
}

export interface ExecuteInput {
  payment: PaymentIntent
  merchant: Merchant
  /** FDC proof of the customer's payment, required for FAssets minting. */
  proof?: unknown
  collateralReservationId?: string
}

export async function executeSettlement(input: ExecuteInput): Promise<Settlement> {
  const { payment, merchant } = input

  if (payment.status !== "verified" && payment.status !== "overpaid") {
    throw new SettlementUnavailableError(
      "router",
      `Payment ${payment.id} is ${payment.status}; settlement requires a verified payment.`,
    )
  }
  if (!merchant.flareAddress) {
    throw new SettlementUnavailableError("router", "The merchant has no Coston2 settlement address.")
  }

  const sourceAsset = payment.selectedAsset ?? ""
  const destinationAsset =
    payment.preferredSettlementAsset ?? merchant.settlementPreference.asset ?? sourceAsset

  const provider = findProvider(sourceAsset, destinationAsset)
  if (!provider) {
    throw new SettlementUnavailableError(
      "router",
      `No settlement provider implements ${sourceAsset} -> ${destinationAsset}.`,
    )
  }

  const reservation = payment.fassetsReservation

  const request: SettlementRequest = {
    paymentId: payment.id,
    sourceAsset,
    destinationAsset,
    // With a reservation, the AssetManager has already fixed exactly how much will be minted.
    // The agent's fee is not minted, so the merchant receives the reserved value, not the total
    // the customer sent.
    amount: reservation
      ? dropsToXrp(BigInt(reservation.valueUBA))
      : (payment.selectedRoute?.estimatedOutputAmount ??
        payment.quote?.assetAmount ??
        payment.amount),
    merchantAddress: merchant.flareAddress,
  }

  // Pre-flight before touching the chain, so an impossible settlement never burns gas. Skipped
  // when a reservation already exists — that reservation *is* the reserved capacity, and
  // re-asking whether an agent is free would fail for the wrong reason.
  if (!input.collateralReservationId) {
    const quote = await provider.quote(request)
    if (!quote.executable) {
      throw new SettlementUnavailableError(provider.id, quote.blockers.join("; "))
    }
  }

  const inSettling = await payments.transition(payment, "settling", "settlement", {
    provider: provider.id,
    sourceAsset,
    destinationAsset,
  })

  const context: SettlementContext = {
    paymentId: payment.id,
    proof: input.proof,
    collateralReservationId: input.collateralReservationId,
    onProgress: (stage, metadata) => {
      void payments.recordEvent(payment.id, stage, provider.id, metadata)
    },
  }

  let settlement: Settlement
  try {
    const result = await provider.execute(request, context)
    settlement = result.settlement
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    await payments.applyPatch(payment.id, {
      failureCode: "SETTLEMENT_FAILED",
      failureDetail: detail,
    })
    await payments.transition(inSettling, "failed", "settlement", { detail })

    const store = await getStore()
    const merchantRecord = await store.getMerchant(payment.merchantId)
    if (merchantRecord) {
      await enqueue(merchantRecord, "settlement.failed", await payments.getPayment(payment.id))
    }
    throw error
  }

  if (settlement.status !== "completed" || !settlement.transactionHash) {
    const detail = settlement.failureDetail ?? "Provider returned a settlement without a transaction hash."
    await payments.transition(inSettling, "failed", "settlement", { detail })
    throw new SettlementUnavailableError(provider.id, detail)
  }

  await payments.applyPatch(payment.id, { settlement })
  const settled = await payments.transition(inSettling, "settled", "settlement", {
    settlementId: settlement.id,
    transactionHash: settlement.transactionHash,
    outputAmount: settlement.outputAmount,
  })

  const store = await getStore()
  const merchantRecord = await store.getMerchant(payment.merchantId)
  if (merchantRecord) await enqueue(merchantRecord, "settlement.completed", settled)

  return settlement
}

export async function getSettlement(id: string): Promise<Settlement | undefined> {
  const store = await getStore()
  return store.getSettlement(id)
}

export async function listSettlements(merchantId: string, limit?: number): Promise<Settlement[]> {
  const store = await getStore()
  return store.listSettlements(merchantId, limit)
}
