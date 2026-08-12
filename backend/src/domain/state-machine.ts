import type { PaymentStatus, WebhookEventType } from "./types.js"

/**
 * Payment status transitions are enforced here and nowhere else.
 *
 * Nothing outside the payment service may assign a status directly, and the API exposes no route
 * that accepts a status from the client (master prompt §7). A status change is always the
 * *consequence* of an observed fact — a detected transaction, a finalized attestation, a
 * confirmed settlement transaction.
 */
const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  created: ["awaiting_payment", "expired", "failed"],
  awaiting_payment: ["payment_detected", "expired", "failed"],
  payment_detected: ["verifying", "failed", "expired"],
  verifying: ["verified", "partially_paid", "overpaid", "failed", "expired"],
  verified: ["settling", "settled", "failed"],
  // An underpaid intent can still be topped up, and an overpaid one still settles.
  partially_paid: ["payment_detected", "verifying", "verified", "expired", "failed", "refunded"],
  overpaid: ["settling", "settled", "failed", "refunded"],
  settling: ["settled", "failed"],
  settled: ["refunded"],
  failed: [],
  expired: [],
  refunded: [],
}

/** Terminal states never transition again. */
export const TERMINAL_STATUSES: PaymentStatus[] = ["failed", "expired", "refunded", "settled"]

export class InvalidStateTransitionError extends Error {
  readonly code = "INVALID_STATE_TRANSITION"
  constructor(
    readonly from: PaymentStatus,
    readonly to: PaymentStatus,
  ) {
    super(`Illegal payment state transition: ${from} -> ${to}`)
    this.name = "InvalidStateTransitionError"
  }
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) throw new InvalidStateTransitionError(from, to)
}

/** The webhook a status change should announce, if any. */
const STATUS_WEBHOOK: Partial<Record<PaymentStatus, WebhookEventType>> = {
  created: "payment.created",
  payment_detected: "payment.detected",
  verifying: "payment.verifying",
  verified: "payment.verified",
  settling: "payment.settling",
  settled: "payment.settled",
  failed: "payment.failed",
  expired: "payment.expired",
  partially_paid: "payment.partially_paid",
  overpaid: "payment.overpaid",
}

export function webhookForStatus(status: PaymentStatus): WebhookEventType | undefined {
  return STATUS_WEBHOOK[status]
}

/** Ordered lifecycle used by the dashboard timeline and the checkout progress rail. */
export const LIFECYCLE_ORDER: PaymentStatus[] = [
  "created",
  "awaiting_payment",
  "payment_detected",
  "verifying",
  "verified",
  "settling",
  "settled",
]
