import { createHmac, timingSafeEqual, randomUUID } from "node:crypto"

/**
 * Webhook signing, modelled on the scheme payment processors have converged on: sign the
 * timestamp and body together so a captured payload cannot be replayed later, and compare in
 * constant time.
 */

export const SIGNATURE_HEADER = "X-PayFlux-Signature"
export const REQUEST_ID_HEADER = "X-PayFlux-Delivery"

export interface SignedPayload {
  body: string
  signature: string
  timestamp: number
  deliveryId: string
}

export function signWebhook(payload: unknown, secret: string, now = Date.now()): SignedPayload {
  const timestamp = Math.floor(now / 1000)
  const body = JSON.stringify(payload)
  const signature = computeSignature(timestamp, body, secret)
  return {
    body,
    signature: `t=${timestamp},v1=${signature}`,
    timestamp,
    deliveryId: `whd_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
  }
}

function computeSignature(timestamp: number, body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
}

export interface VerifyOptions {
  /** Reject signatures older than this, in seconds. */
  toleranceSeconds?: number
  now?: number
}

/**
 * Reference verifier — shipped in the SDK and used by the demo store, so the signing scheme is
 * exercised by a real consumer rather than only asserted in tests.
 */
export function verifyWebhookSignature(
  header: string,
  body: string,
  secret: string,
  options: VerifyOptions = {},
): { valid: boolean; reason?: string } {
  const tolerance = options.toleranceSeconds ?? 300
  const now = Math.floor((options.now ?? Date.now()) / 1000)

  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=")
      return [key, rest.join("=")]
    }),
  )

  const timestamp = Number(parts.t)
  const provided = parts.v1

  if (!Number.isFinite(timestamp) || !provided) {
    return { valid: false, reason: "malformed signature header" }
  }
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: "signature timestamp outside tolerance window" }
  }

  const expected = computeSignature(timestamp, body, secret)
  const a = Buffer.from(expected, "hex")
  const b = Buffer.from(provided, "hex")
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "signature mismatch" }
  }
  return { valid: true }
}
