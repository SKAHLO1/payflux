import type {
  PaymentRoute,
  RouteRequest,
  PaymentAsset,
} from "../domain/types.js"
import { getAsset, CHAINS } from "../registry/assets.js"
import { createQuote, QuoteUnavailableError } from "../pricing/quote.service.js"
import { preflight, fassetsHealth } from "../chain/fassets.js"
import { xrpToDrops } from "../verification/xrpl.payment.js"
import { registryHealth } from "../chain/payment-registry.js"
import { fdcHealth } from "../verification/fdc.service.js"
import { env } from "../config/env.js"

/**
 * The asset-agnostic router.
 *
 * Its job is to turn "$50, and I'll take XRP, FXRP or C2FLR" into concrete, ranked, *executable*
 * paths. The distinction the router exists to enforce is SUPPORTED versus AVAILABLE
 * (master prompt §54): PayFlux implements the XRP→FXRP path, but whether it can run right now
 * depends on live FAssets agent capacity, which the router checks every time.
 *
 * Nothing here estimates liquidity it cannot observe.
 */

export interface RouterContext {
  merchantXrplAddress?: string
  merchantFlareAddress?: string
}

/** Cached health snapshot — these are chain reads and the router runs on every checkout load. */
let healthCache: { value: Awaited<ReturnType<typeof snapshotHealth>>; at: number } | undefined
const HEALTH_TTL_MS = 15_000

async function snapshotHealth() {
  const [fassets, registry, fdc] = await Promise.all([
    fassetsHealth(),
    registryHealth(),
    fdcHealth(),
  ])
  return { fassets, registry, fdc }
}

async function health() {
  if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.value
  const value = await snapshotHealth()
  healthCache = { value, at: Date.now() }
  return value
}

export async function findRoutes(
  request: RouteRequest,
  context: RouterContext,
): Promise<PaymentRoute[]> {
  const status = await health()

  const routes = await Promise.all(
    request.acceptedAssets.map((assetId) => buildRoute(assetId, request, context, status)),
  )

  return routes
    .filter((route): route is PaymentRoute => route !== undefined)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "available" ? -1 : 1
      return (b.score ?? 0) - (a.score ?? 0)
    })
}

export function selectBestRoute(routes: PaymentRoute[]): PaymentRoute | undefined {
  return routes.find((route) => route.status === "available")
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

async function buildRoute(
  assetId: string,
  request: RouteRequest,
  context: RouterContext,
  status: Awaited<ReturnType<typeof snapshotHealth>>,
): Promise<PaymentRoute | undefined> {
  const asset = getAsset(assetId)
  if (!asset) return undefined

  const base: PaymentRoute = {
    id: `route_${request.paymentId}_${asset.id.toLowerCase()}`,
    sourceAsset: asset.id,
    sourceChain: asset.chain,
    destinationChain: CHAINS.COSTON2,
    estimatedInputAmount: "0",
    estimatedOutputAmount: "0",
    estimatedFee: "0",
    estimatedTimeSeconds: 0,
    verificationMethod: "unknown",
    status: "unavailable",
    reasons: [],
    supported: asset.supportsPayment && asset.enabled,
  }

  if (!base.supported) {
    return {
      ...base,
      unavailableReason: asset.note ?? `${asset.id} is not supported for payment.`,
      reasons: [`${asset.id} has no implemented payment path in PayFlux.`],
    }
  }

  // Quote first — with no price there is no route, whatever the chain says.
  let quote
  try {
    quote = await createQuote(request.fiatAmount, request.fiatCurrency, asset.id)
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      unavailableReason:
        error instanceof QuoteUnavailableError
          ? error.message
          : `Pricing failed: ${error instanceof Error ? error.message : String(error)}`,
      reasons: ["No live FTSOv2 price is available, so PayFlux will not quote this asset."],
    }
  }

  switch (asset.id) {
    case "XRP":
      return buildXrpRoute(base, asset, quote, request, context, status)
    case "FXRP":
      return buildFxrpRoute(base, asset, quote, context, status)
    case "C2FLR":
      return buildFlareNativeRoute(base, asset, quote, context, status)
    default:
      return {
        ...base,
        unavailableReason: `No route builder implemented for ${asset.id}.`,
        reasons: [],
      }
  }
}

/**
 * XRP on XRPL Testnet -> FXRP on Coston2.
 *
 * The flagship path: FDC-verified, FAssets-settled. Availability is gated on live agent capacity
 * and on the payment amount clearing a whole lot.
 */
async function buildXrpRoute(
  base: PaymentRoute,
  asset: PaymentAsset,
  quote: Awaited<ReturnType<typeof createQuote>>,
  request: RouteRequest,
  context: RouterContext,
  status: Awaited<ReturnType<typeof snapshotHealth>>,
): Promise<PaymentRoute> {
  const reasons: string[] = []
  const blockers: string[] = []

  if (!context.merchantXrplAddress) {
    blockers.push(
      "No XRPL destination address is set for this account. Add one in Settings — " +
        "without it there is nowhere for customers to send XRP.",
    )
  }
  if (!status.fdc.reachable) {
    blockers.push("FDC contracts could not be resolved on Coston2.")
  } else {
    reasons.push("FDC Payment attestation available for testXRP")
  }
  if (!status.fdc.verifierConfigured) {
    blockers.push("No FDC verifier API key is configured, so attestations cannot be prepared.")
  }
  if (!status.registry.available) {
    blockers.push(status.registry.detail ?? "PaymentRegistry is unavailable.")
  } else {
    reasons.push("Verified payments are recorded on-chain in PaymentRegistry")
  }

  const desiredDrops = xrpToDrops(quote.assetAmount)

  // Settlement into FXRP: check the real FAssets constraints, not an assumption.
  let settlementMethod: string | undefined
  let inputAmount = quote.assetAmount
  let priceImpact: string | undefined

  try {
    const check = await preflight(desiredDrops)
    if (check.ok) {
      settlementMethod = "fassets-mint"
      inputAmount = check.requiredXrp
      reasons.push(
        `Settles to FXRP by FAssets minting (${check.lots} lot${check.lots === 1 ? "" : "s"} of ${
          check.lotSizeXrp
        } XRP)`,
      )
      if (check.roundingDrops > 0n) {
        // Lot quantisation is a real cost to the customer. Surface it, do not bury it.
        priceImpact = `+${formatXrp(check.roundingDrops)} XRP rounded up to the FAssets lot boundary`
        reasons.push(priceImpact)
      }
    } else {
      // The payment still works and is still FDC-verified — only settlement is degraded.
      blockers.push(...check.blockers.map((b) => `Settlement: ${b}`))
    }
  } catch (error) {
    blockers.push(
      `Settlement: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const hardBlockers = blockers.filter((b) => !b.startsWith("Settlement:"))
  const settlementBlocked = blockers.some((b) => b.startsWith("Settlement:"))

  let routeStatus: PaymentRoute["status"] = "available"
  let unavailableReason: string | undefined

  if (hardBlockers.length > 0) {
    routeStatus = "unavailable"
    unavailableReason = hardBlockers[0]
  } else if (settlementBlocked) {
    // Honest middle ground: payment + verification work, settlement does not.
    routeStatus = "degraded"
    unavailableReason = blockers.find((b) => b.startsWith("Settlement:"))
    reasons.push(
      "Payment is verifiable now, but automatic FXRP settlement is unavailable — the merchant is credited once capacity returns.",
    )
  }

  return {
    ...base,
    destinationAsset: "FXRP",
    destinationChain: CHAINS.COSTON2,
    estimatedInputAmount: inputAmount,
    estimatedOutputAmount: quote.assetAmount,
    estimatedFee: quote.fee,
    // XRPL finality is ~4s; the FDC round is the real cost of trust-minimised verification.
    estimatedTimeSeconds: 200,
    priceImpact,
    verificationMethod: "fdc-payment",
    settlementMethod,
    status: routeStatus,
    unavailableReason,
    reasons,
    supported: true,
    paymentInstructions: context.merchantXrplAddress
      ? {
          chain: CHAINS.XRPL_TESTNET,
          asset: "XRP",
          destinationAddress: context.merchantXrplAddress,
          reference: request.paymentId,
          referenceEncoding: "xrpl-memo-hex",
          amount: inputAmount,
          amountUnit: "XRP",
        }
      : undefined,
    score: routeStatus === "unavailable" ? undefined : scoreRoute({
      status: routeStatus,
      feeBps: 30,
      timeSeconds: 200,
      verification: "fdc-payment",
      settles: Boolean(settlementMethod),
      priceImpact: Boolean(priceImpact),
    }),
  }
}

/** FXRP paid directly on Coston2. Already a Flare-native asset, so no attestation is needed. */
async function buildFxrpRoute(
  base: PaymentRoute,
  asset: PaymentAsset,
  quote: Awaited<ReturnType<typeof createQuote>>,
  context: RouterContext,
  status: Awaited<ReturnType<typeof snapshotHealth>>,
): Promise<PaymentRoute> {
  const reasons = [
    "Paid natively on Coston2 — final on arrival, no external attestation required",
    "Merchant settlement asset matches the payment asset, so no conversion is needed",
  ]
  const blockers: string[] = []

  if (!context.merchantFlareAddress) {
    blockers.push(
      "No Coston2 settlement address is set for this account. Add one in Settings — " +
        "without it there is nowhere to deliver the settled asset.",
    )
  }
  if (!status.fassets.available && !status.fassets.fxrp) {
    blockers.push("The FXRP token address could not be resolved via the FAssets AssetManager.")
  }
  if (!status.registry.available) {
    blockers.push(status.registry.detail ?? "PaymentRegistry is unavailable.")
  }

  return {
    ...base,
    destinationAsset: "FXRP",
    estimatedInputAmount: quote.assetAmount,
    estimatedOutputAmount: quote.assetAmount,
    estimatedFee: quote.fee,
    estimatedTimeSeconds: 10,
    verificationMethod: "flare-native",
    settlementMethod: blockers.length ? undefined : "direct-transfer",
    status: blockers.length ? "unavailable" : "available",
    unavailableReason: blockers[0],
    reasons,
    supported: true,
    paymentInstructions: context.merchantFlareAddress
      ? {
          chain: CHAINS.COSTON2,
          asset: "FXRP",
          destinationAddress: context.merchantFlareAddress,
          reference: base.id,
          referenceEncoding: "none",
          amount: quote.assetAmount,
          amountUnit: "FXRP",
        }
      : undefined,
    score: blockers.length
      ? undefined
      : scoreRoute({
          status: "available",
          feeBps: 30,
          timeSeconds: 10,
          verification: "flare-native",
          settles: true,
          priceImpact: false,
        }),
  }
}

/** C2FLR paid natively on Coston2. Fastest and cheapest, but no cross-chain story. */
async function buildFlareNativeRoute(
  base: PaymentRoute,
  asset: PaymentAsset,
  quote: Awaited<ReturnType<typeof createQuote>>,
  context: RouterContext,
  status: Awaited<ReturnType<typeof snapshotHealth>>,
): Promise<PaymentRoute> {
  const blockers: string[] = []
  if (!context.merchantFlareAddress) {
    blockers.push(
      "No Coston2 settlement address is set for this account. Add one in Settings — " +
        "without it there is nowhere to deliver the settled asset.",
    )
  }
  if (!status.registry.available) {
    blockers.push(status.registry.detail ?? "PaymentRegistry is unavailable.")
  }

  return {
    ...base,
    destinationAsset: "C2FLR",
    estimatedInputAmount: quote.assetAmount,
    estimatedOutputAmount: quote.assetAmount,
    estimatedFee: quote.fee,
    estimatedTimeSeconds: 5,
    verificationMethod: "flare-native",
    settlementMethod: blockers.length ? undefined : "direct-transfer",
    status: blockers.length ? "unavailable" : "available",
    unavailableReason: blockers[0],
    reasons: [
      "Native Coston2 transfer — fastest confirmation",
      "Priced from the FTSOv2 FLR/USD feed",
    ],
    supported: true,
    paymentInstructions: context.merchantFlareAddress
      ? {
          chain: CHAINS.COSTON2,
          asset: "C2FLR",
          destinationAddress: context.merchantFlareAddress,
          reference: base.id,
          referenceEncoding: "evm-calldata",
          amount: quote.assetAmount,
          amountUnit: "C2FLR",
        }
      : undefined,
    score: blockers.length
      ? undefined
      : scoreRoute({
          status: "available",
          feeBps: 30,
          timeSeconds: 5,
          verification: "flare-native",
          settles: true,
          priceImpact: false,
        }),
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ScoreInputs {
  status: PaymentRoute["status"]
  feeBps: number
  timeSeconds: number
  verification: string
  settles: boolean
  priceImpact: boolean
}

/**
 * Weighted score, 0-100. Deliberately simple and fully explainable — the checkout shows the
 * reasons list alongside the score, so an arbitrary black-box ranking would be worse than useless.
 */
function scoreRoute(input: ScoreInputs): number {
  let score = 100

  // Executability dominates everything else.
  if (input.status === "degraded") score -= 25
  if (!input.settles) score -= 15

  // Fee: 1 point per 10bps.
  score -= Math.min(20, input.feeBps / 10)

  // Time: gentle penalty, capped, because trust-minimised verification legitimately costs time.
  score -= Math.min(15, input.timeSeconds / 20)

  // Cross-chain verification is the harder guarantee and is worth a bonus.
  if (input.verification === "fdc-payment") score += 8

  if (input.priceImpact) score -= 5

  return Math.max(0, Math.round(score))
}

function formatXrp(drops: bigint): string {
  const whole = drops / 1_000_000n
  const frac = (drops % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")
  return `${whole}${frac ? `.${frac}` : ""}`
}

export const ROUTER_CONFIG = {
  amountToleranceBps: env.AMOUNT_TOLERANCE_BPS,
}
