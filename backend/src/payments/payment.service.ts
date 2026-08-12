import { randomBytes, randomUUID } from "node:crypto"
import { env } from "../config/env.js"
import type {
  Merchant,
  PaymentEvent,
  PaymentFailureCode,
  PaymentIntent,
  PaymentQuote,
  PaymentRoute,
  PaymentStatus,
  FAssetsReservation,
} from "../domain/types.js"
import { assertTransition, webhookForStatus } from "../domain/state-machine.js"
import { validatePaymentAssets, validateSettlementAsset } from "../registry/assets.js"
import { getStore } from "../store/index.js"
import { findRoutes, selectBestRoute } from "../routing/router.js"
import { createQuote } from "../pricing/quote.service.js"
import { paymentBus } from "../events/bus.js"
import { enqueue } from "../webhooks/dispatcher.js"
import * as registry from "../chain/payment-registry.js"
import { xrpToDrops, dropsToXrp, buildMemo } from "../verification/xrpl.payment.js"
import { startSweeper } from "../util/sweeper.js"
import * as fassets from "../chain/fassets.js"
import { decimalsFor, toSmallestUnit } from "../verification/coston2.payment.js"

/**
 * The payment engine.
 *
 * Every status change in the system funnels through `transition()`, which enforces the state
 * machine, writes an immutable event, publishes to the SSE bus and fires the merchant webhook.
 * No other module writes `status` directly, and no API route accepts one from a client.
 */

export class PaymentNotFoundError extends Error {
  readonly code = "PAYMENT_NOT_FOUND"
  constructor(id: string) {
    super(`Payment ${id} not found`)
    this.name = "PaymentNotFoundError"
  }
}

export interface CreatePaymentInput {
  merchantId: string
  amount: string
  currency: string
  acceptedAssets: string[]
  settlementAsset?: string
  orderId?: string
  metadata?: Record<string, string>
  expiresInSeconds?: number
}

/**
 * References are short enough to fit an XRPL memo and be read aloud, and use an unambiguous
 * alphabet (no 0/O, 1/I) because people retype these.
 */
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

export function generatePaymentReference(): string {
  const bytes = randomBytes(6)
  let out = ""
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]
  return `pay_${out}`
}

export async function createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
  const store = await getStore()

  validatePaymentAssets(input.acceptedAssets)
  if (input.settlementAsset) validateSettlementAsset(input.settlementAsset)

  const now = new Date()
  const ttl = input.expiresInSeconds ?? env.PAYMENT_TTL_SECONDS

  const payment: PaymentIntent = {
    id: `pay_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    merchantId: input.merchantId,
    amount: input.amount,
    currency: input.currency.toUpperCase(),
    acceptedAssets: input.acceptedAssets.map((a) => a.toUpperCase()),
    preferredSettlementAsset: input.settlementAsset?.toUpperCase(),
    status: "created",
    orderId: input.orderId,
    paymentReference: generatePaymentReference(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    metadata: input.metadata,
  }

  await store.createPayment(payment)
  await recordEvent(payment.id, "payment.created", "api", {
    amount: payment.amount,
    currency: payment.currency,
    acceptedAssets: payment.acceptedAssets,
  })

  const merchant = await store.getMerchant(input.merchantId)
  if (merchant) await enqueue(merchant, "payment.created", payment)

  paymentBus.publish(payment.id, { payment })
  return payment
}

export async function getPayment(id: string): Promise<PaymentIntent> {
  const store = await getStore()
  const payment = await store.getPayment(id)
  if (!payment) throw new PaymentNotFoundError(id)
  return payment
}

export async function listPayments(merchantId: string, limit?: number): Promise<PaymentIntent[]> {
  const store = await getStore()
  return store.listPayments(merchantId, limit)
}

export async function getRoutes(
  payment: PaymentIntent,
  merchant: Merchant,
): Promise<PaymentRoute[]> {
  return findRoutes(
    {
      paymentId: payment.id,
      fiatAmount: payment.amount,
      fiatCurrency: payment.currency,
      acceptedAssets: payment.acceptedAssets,
      preferredSettlementAsset: payment.preferredSettlementAsset,
    },
    {
      merchantXrplAddress: merchant.xrplAddress,
      merchantFlareAddress: merchant.flareAddress,
    },
  )
}

/**
 * The customer picks an asset. This is the point at which PayFlux commits: it locks a quote,
 * writes the intent commitment to PaymentRegistry on Coston2, and only then tells the customer
 * where to send funds.
 *
 * Committing on-chain *before* the payment is what lets the registry reject a mismatched payment
 * later without trusting anything PayFlux says afterwards.
 */
export async function selectAsset(
  paymentId: string,
  assetId: string,
  merchant: Merchant,
): Promise<PaymentIntent> {
  const store = await getStore()
  let payment = await getPayment(paymentId)

  if (!payment.acceptedAssets.includes(assetId.toUpperCase())) {
    throw new PaymentAssetRejectedError(assetId, payment.acceptedAssets)
  }
  if (new Date(payment.expiresAt) <= new Date()) {
    return fail(payment, "PAYMENT_EXPIRED", "The payment intent expired before an asset was chosen.")
  }

  const routes = await getRoutes(payment, merchant)
  const route = routes.find((r) => r.sourceAsset === assetId.toUpperCase())

  if (!route) {
    throw new PaymentAssetRejectedError(assetId, payment.acceptedAssets)
  }
  if (route.status === "unavailable") {
    throw new RouteUnavailableError(route.unavailableReason ?? `Route for ${assetId} is unavailable.`)
  }

  const quote = await createQuote(payment.amount, payment.currency, route.sourceAsset)

  payment = await store.updatePayment(paymentId, {
    selectedAsset: route.sourceAsset,
    selectedRoute: route,
    quote,
  })

  await recordEvent(paymentId, "payment.asset_selected", "checkout", {
    asset: route.sourceAsset,
    routeId: route.id,
    score: route.score,
    quoteId: quote.id,
    rate: quote.rate,
    rateSource: quote.rateSource,
  })

  /*
   * Reserve FAssets collateral before telling the customer where to pay.
   *
   * This is the step that makes real FXRP settlement possible. FAssets only mints against a
   * payment sent to the agent's own underlying address carrying the agent's own reference, and
   * neither exists until collateral is reserved. So the reservation has to happen here — the
   * customer then pays the agent, and the merchant is made whole in FXRP on Coston2.
   *
   * If it fails, the payment is not broken: the route degrades to verify-only and says so. That
   * is a worse outcome than settling, and a much better one than sending the customer to an
   * address whose payment can never be minted.
   */
  let destinationAddress = route.paymentInstructions?.destinationAddress
  let xrplMemoHex = route.sourceAsset === "XRP" ? buildMemo(payment.paymentReference).memoDataHex : undefined
  let onChainReference = payment.paymentReference
  let minAmount =
    route.sourceAsset === "XRP"
      ? xrpToDrops(route.estimatedInputAmount)
      : toSmallestUnit(
          route.estimatedInputAmount,
          await decimalsFor(route.sourceAsset as "C2FLR" | "FXRP"),
        )
  let intentExpiresAt = new Date(payment.expiresAt)

  if (route.sourceAsset === "XRP" && route.settlementMethod === "fassets-mint") {
    try {
      const reservation = await reserveForPayment(payment, route)

      destinationAddress = reservation.paymentAddress
      // The AssetManager dictates the reference; ours is not accepted for minting.
      xrplMemoHex = reservation.paymentReference.replace(/^0x/, "").toUpperCase()
      onChainReference = reservation.paymentReference
      minAmount = BigInt(reservation.totalUBA)
      // The reservation window may close before the intent would have expired.
      intentExpiresAt = new Date(
        Math.min(intentExpiresAt.getTime(), reservation.lastUnderlyingTimestamp * 1000),
      )

      payment = await store.updatePayment(paymentId, {
        fassetsReservation: reservation,
        expiresAt: intentExpiresAt.toISOString(),
        selectedRoute: {
          ...route,
          estimatedInputAmount: dropsToXrp(BigInt(reservation.totalUBA)),
          paymentInstructions: route.paymentInstructions
            ? {
                ...route.paymentInstructions,
                destinationAddress: reservation.paymentAddress,
                amount: dropsToXrp(BigInt(reservation.totalUBA)),
              }
            : undefined,
        },
      })

      await recordEvent(paymentId, "fassets.collateral_reserved", "coston2", {
        collateralReservationId: reservation.collateralReservationId,
        agentVault: reservation.agentVault,
        paymentAddress: reservation.paymentAddress,
        valueUBA: reservation.valueUBA,
        feeUBA: reservation.feeUBA,
        transactionHash: reservation.transactionHash,
      })
    } catch (error) {
      // Degrade to verify-only rather than promising a settlement that cannot happen.
      await recordEvent(paymentId, "fassets.reservation_failed", "coston2", {
        error: error instanceof Error ? error.message : String(error),
      })
      payment = await store.updatePayment(paymentId, {
        selectedRoute: {
          ...route,
          settlementMethod: undefined,
          status: "degraded",
          unavailableReason:
            `FXRP settlement is unavailable: ${error instanceof Error ? error.message : String(error)}. ` +
            `The payment will still be verified on Coston2.`,
        },
      })
    }
  }

  // Commit the expectation on-chain. If the registry is unavailable, say so rather than
  // proceeding with an unverifiable payment.
  if (registry.registryAddress() && merchant.flareAddress && destinationAddress) {
    try {
      const result = await registry.openPaymentIntent({
        paymentId: payment.id,
        merchantAddress: merchant.flareAddress,
        sourceChain: route.sourceAsset === "XRP" ? "testXRP" : "coston2",
        sourceAsset: route.sourceAsset,
        destinationAddress,
        paymentReference: onChainReference,
        minAmountSmallestUnit: minAmount,
        expiresAt: intentExpiresAt,
      })

      payment = await store.updatePayment(paymentId, {
        onChainIntentTransactionHash: result.transactionHash,
      })

      await recordEvent(paymentId, "registry.intent_opened", "coston2", {
        transactionHash: result.transactionHash,
        blockNumber: result.blockNumber,
        explorerUrl: result.explorerUrl,
      })
    } catch (error) {
      await recordEvent(paymentId, "registry.intent_failed", "coston2", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return transition(payment, "awaiting_payment", "checkout", {
    asset: route.sourceAsset,
    destination: destinationAddress,
    memo: xrplMemoHex,
    payingAgent: Boolean(payment.fassetsReservation),
  })
}

/**
 * Reserves collateral for an XRP payment so it can mint FXRP.
 *
 * The reservation is quantised to whole lots, so the customer pays the lot-aligned amount plus
 * the agent's minting fee — both reported by the AssetManager rather than estimated here.
 */
async function reserveForPayment(
  payment: PaymentIntent,
  route: PaymentRoute,
): Promise<FAssetsReservation> {
  /*
   * Cap outstanding reservations per account.
   *
   * Each reservation costs the operator a non-refundable C2FLR fee and is lost if the customer
   * never pays. Without this, selecting the XRP route repeatedly and walking away drains the
   * operator's balance — and an empty balance stops verification for every account, not just the
   * one doing it. The cap bounds that to a few lots per developer.
   */
  const store = await getStore()
  const recent = await store.listPayments(payment.merchantId, 100)
  const now = Date.now()

  const outstanding = recent.filter(
    (other) =>
      other.id !== payment.id &&
      other.fassetsReservation &&
      ["created", "awaiting_payment", "payment_detected"].includes(other.status) &&
      new Date(other.expiresAt).getTime() > now,
  )

  if (outstanding.length >= env.MAX_OPEN_RESERVATIONS_PER_ACCOUNT) {
    throw new Error(
      `this account already holds ${outstanding.length} unpaid FAssets reservation(s) ` +
        `(limit ${env.MAX_OPEN_RESERVATIONS_PER_ACCOUNT}). Complete or let one expire before ` +
        `starting another XRP payment.`,
    )
  }

  const desiredDrops = xrpToDrops(route.estimatedOutputAmount || route.estimatedInputAmount)
  const check = await fassets.preflight(desiredDrops)

  if (!check.ok || !check.agent) {
    throw new Error(check.blockers.join("; ") || "no FAssets agent available")
  }

  const reservation = await fassets.reserveCollateral(
    check.agent.agentVault,
    check.lots,
    // Accept exactly the fee this agent advertises; a higher fee would be a different price
    // than the customer was quoted.
    check.agent.feeBIPS,
  )

  const total = reservation.valueUBA + reservation.feeUBA

  return {
    collateralReservationId: reservation.collateralReservationId,
    agentVault: reservation.agentVault,
    paymentAddress: reservation.paymentAddress,
    paymentReference: reservation.paymentReference,
    valueUBA: reservation.valueUBA.toString(),
    feeUBA: reservation.feeUBA.toString(),
    totalUBA: total.toString(),
    lastUnderlyingTimestamp: reservation.lastUnderlyingTimestamp,
    reservationFeeWei: (check.collateralReservationFeeWei ?? 0n).toString(),
    transactionHash: reservation.transactionHash,
    reservedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

export async function transition(
  payment: PaymentIntent,
  to: PaymentStatus,
  source: string,
  metadata: Record<string, unknown> = {},
): Promise<PaymentIntent> {
  assertTransition(payment.status, to)
  if (payment.status === to) return payment

  const store = await getStore()
  const updated = await store.updatePayment(payment.id, { status: to })

  const event = await recordEvent(payment.id, `payment.${to}`, source, {
    from: payment.status,
    ...metadata,
  })

  paymentBus.publish(payment.id, { payment: updated, event })

  const webhook = webhookForStatus(to)
  if (webhook) {
    const merchant = await store.getMerchant(payment.merchantId)
    if (merchant) await enqueue(merchant, webhook, updated)
  }

  return updated
}

export async function fail(
  payment: PaymentIntent,
  code: PaymentFailureCode,
  detail: string,
): Promise<PaymentIntent> {
  const store = await getStore()
  const withReason = await store.updatePayment(payment.id, {
    failureCode: code,
    failureDetail: detail,
  })
  const terminal: PaymentStatus = code === "PAYMENT_EXPIRED" ? "expired" : "failed"
  return transition(withReason, terminal, "engine", { failureCode: code, detail })
}

export async function applyPatch(
  paymentId: string,
  patch: Partial<PaymentIntent>,
): Promise<PaymentIntent> {
  const store = await getStore()
  const updated = await store.updatePayment(paymentId, patch)
  paymentBus.publish(paymentId, { payment: updated })
  return updated
}

// ---------------------------------------------------------------------------
// Event log (master prompt §49)
// ---------------------------------------------------------------------------

export async function recordEvent(
  paymentId: string,
  type: string,
  source: string,
  metadata: Record<string, unknown> = {},
): Promise<PaymentEvent> {
  const store = await getStore()
  return store.appendEvent({
    paymentId,
    type,
    source,
    timestamp: new Date().toISOString(),
    metadata,
  })
}

export async function listEvents(paymentId: string): Promise<PaymentEvent[]> {
  const store = await getStore()
  return store.listEvents(paymentId)
}

// ---------------------------------------------------------------------------
// Expiry sweeper
// ---------------------------------------------------------------------------

/**
 * Expires intents whose window has closed.
 *
 * The database clock decides *when to check*, but the authority on whether a payment arrived is
 * the chain. `verify.service` re-checks XRPL before expiring anything that might have been paid
 * at the last moment, and FDC's ReferencedPaymentNonexistence attestation is the path to making
 * this provable rather than merely careful (see docs/fdc-flow.md).
 */
export function startExpirySweeper(check: (payment: PaymentIntent) => Promise<boolean>) {
  return startSweeper({
    name: "expiry sweeper",
    intervalMs: 30_000 * env.PAYFLUX_POLL_SCALE,
    tick: async () => {
      const store = await getStore()
      const candidates = await store.listExpirablePayments(new Date())
      for (const payment of candidates) {
        const paidLate = await check(payment)
        if (paidLate) continue
        await fail(payment, "PAYMENT_EXPIRED", `No matching payment arrived before ${payment.expiresAt}.`)
        if (registry.registryAddress() && payment.onChainIntentTransactionHash) {
          try {
            const result = await registry.closePaymentIntent(payment.id, "expired")
            await recordEvent(payment.id, "registry.intent_closed", "coston2", {
              transactionHash: result.transactionHash,
            })
          } catch {
            // Closing is housekeeping; the intent is already unusable because it expired.
          }
        }
      }
      // An empty sweep is the common case — nothing is expiring most of the time.
      return candidates.length > 0
    },
  })
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PaymentAssetRejectedError extends Error {
  readonly code = "ASSET_UNSUPPORTED"
  constructor(
    readonly asset: string,
    readonly accepted: string[],
  ) {
    super(`Asset ${asset} is not accepted for this payment (accepted: ${accepted.join(", ")}).`)
    this.name = "PaymentAssetRejectedError"
  }
}

export class RouteUnavailableError extends Error {
  readonly code = "ROUTE_UNAVAILABLE"
  constructor(detail: string) {
    super(detail)
    this.name = "RouteUnavailableError"
  }
}

export type { PaymentQuote }
