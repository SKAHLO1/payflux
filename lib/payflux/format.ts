import type { PaymentStatus } from "./types"

/** Presentation helpers shared by checkout, status and dashboard. */

export function truncateHash(hash?: string, lead = 10, tail = 8): string {
  if (!hash) return "—"
  if (hash.length <= lead + tail + 1) return hash
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`
}

export function formatFiat(amount: string, currency: string): string {
  const value = Number(amount)
  if (!Number.isFinite(value)) return `${amount} ${currency}`
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

/** Trims trailing zeros without lying about precision. */
export function formatAsset(amount?: string, maxDecimals = 6): string {
  if (!amount) return "—"
  const value = Number(amount)
  if (!Number.isFinite(value)) return amount
  return value
    .toFixed(maxDecimals)
    .replace(/0+$/, "")
    .replace(/\.$/, "")
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `~${seconds}s`
  const minutes = Math.round(seconds / 60)
  return `~${minutes} min`
}

export function timeAgo(iso?: string): string {
  if (!iso) return "—"
  const delta = Date.now() - new Date(iso).getTime()
  const seconds = Math.round(delta / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

export function countdown(iso: string, now = Date.now()): string {
  const remaining = Math.max(0, new Date(iso).getTime() - now)
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

export const CHAIN_LABELS: Record<string, string> = {
  "xrpl-testnet": "XRPL Testnet",
  coston2: "Flare Coston2",
  "bitcoin-testnet": "Bitcoin Testnet",
  "dogecoin-testnet": "Dogecoin Testnet",
}

export function chainLabel(chain?: string): string {
  if (!chain) return "—"
  return CHAIN_LABELS[chain] ?? chain
}

export const VERIFICATION_LABELS: Record<string, string> = {
  "fdc-payment": "Flare Data Connector",
  "flare-native": "Native on Coston2",
  unknown: "—",
}

export const SETTLEMENT_LABELS: Record<string, string> = {
  "fassets-mint": "FAssets minting",
  "direct-transfer": "Direct transfer",
}

interface StatusPresentation {
  label: string
  tone: "idle" | "working" | "success" | "warning" | "danger"
  description: string
}

/**
 * One place that decides how a status reads to a human. The descriptions state what is actually
 * true at that moment — no status is described as more settled than it is.
 */
export const STATUS_PRESENTATION: Record<PaymentStatus, StatusPresentation> = {
  created: {
    label: "Created",
    tone: "idle",
    description: "Payment intent created. The customer has not chosen an asset yet.",
  },
  awaiting_payment: {
    label: "Awaiting payment",
    tone: "idle",
    description: "Waiting for the customer's transfer to appear on the source chain.",
  },
  payment_detected: {
    label: "Payment detected",
    tone: "working",
    description: "A candidate transaction was seen. It has not been verified yet.",
  },
  verifying: {
    label: "Verifying",
    tone: "working",
    description: "An FDC attestation has been requested. Waiting for the voting round to finalize.",
  },
  verified: {
    label: "Verified",
    tone: "success",
    description: "Flare independently verified the payment and it is recorded on Coston2.",
  },
  settling: {
    label: "Settling",
    tone: "working",
    description: "Moving value into the merchant's settlement asset.",
  },
  settled: {
    label: "Settled",
    tone: "success",
    description: "The merchant holds the settlement asset. Confirmed on-chain.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    description: "This payment did not complete. See the reason below.",
  },
  expired: {
    label: "Expired",
    tone: "danger",
    description: "The payment window closed before a matching payment arrived.",
  },
  partially_paid: {
    label: "Partially paid",
    tone: "warning",
    description: "Less than the expected amount arrived. The balance is still outstanding.",
  },
  overpaid: {
    label: "Overpaid",
    tone: "warning",
    description: "More than the expected amount arrived. The excess is recorded.",
  },
  refunded: {
    label: "Refunded",
    tone: "idle",
    description: "This payment was refunded.",
  },
}

export const TONE_CLASSES: Record<StatusPresentation["tone"], string> = {
  idle: "text-white/70 border-white/25 bg-white/5",
  working: "text-[color:var(--pf-pending)] border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/10",
  success: "text-[color:var(--pf-success)] border-[color:var(--pf-success)]/40 bg-[color:var(--pf-success)]/10",
  warning: "text-[color:var(--pf-pending)] border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/10",
  danger: "text-[color:var(--pf-danger)] border-[color:var(--pf-danger)]/40 bg-[color:var(--pf-danger)]/10",
}

/** Human labels for the raw event-log types, so the timeline reads as a story. */
export const EVENT_LABELS: Record<string, string> = {
  "payment.created": "Payment created",
  "payment.asset_selected": "Customer chose an asset",
  "payment.awaiting_payment": "Awaiting customer payment",
  "payment.detected": "Transaction detected on the source chain",
  "payment.payment_detected": "Transaction detected on the source chain",
  "payment.verifying": "Verification started",
  "fdc.requested": "FDC attestation request prepared",
  "fdc.submitted": "Attestation request submitted on Coston2",
  "fdc.awaiting_finalization": "Waiting for the FDC voting round to finalize",
  "fdc.finalized": "FDC proof retrieved",
  "payment.verified": "Payment verified",
  "payment.overpaid": "Payment verified — overpaid",
  "payment.partially_paid": "Payment verified — underpaid",
  "registry.intent_opened": "Intent commitment written to PaymentRegistry",
  "registry.intent_failed": "Intent commitment could not be written",
  "registry.intent_closed": "Intent closed on PaymentRegistry",
  "registry.payment_verified": "Payment recorded on PaymentRegistry",
  "payment.settling": "Settlement started",
  "fassets.minting": "FAssets minting in progress",
  "fassets.minted": "FXRP minted",
  "fassets.settled": "FXRP delivered to the merchant",
  "native.confirmed": "Merchant balance confirmed on Coston2",
  "payment.settled": "Settlement complete",
  "payment.failed": "Payment failed",
  "payment.expired": "Payment expired",
}

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type
}
