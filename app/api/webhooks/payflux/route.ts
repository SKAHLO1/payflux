import { NextResponse } from "next/server"
import { verifyWebhookSignature } from "@payflux/node"

export const dynamic = "force-dynamic"

/**
 * The demo store's webhook receiver.
 *
 * Exists to prove the signing scheme is usable by a real consumer, not just asserted in a test.
 * Note that the raw body is verified, not a re-serialized object — key order and whitespace do
 * not survive a JSON round trip, and a signature over a re-serialized body would fail.
 */

// In a real store this would be a database. The demo keeps the last few events in memory so the
// store page can show that the merchant genuinely heard back.
const recent: Array<{ type: string; paymentId: string; receivedAt: string }> = []

export async function POST(request: Request) {
  const secret = process.env.PAYFLUX_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: "PAYFLUX_WEBHOOK_SECRET is not configured on the store." },
      { status: 503 },
    )
  }

  const signature = request.headers.get("X-PayFlux-Signature")
  if (!signature) {
    return NextResponse.json({ error: "Missing signature header." }, { status: 400 })
  }

  const rawBody = await request.text()
  const result = verifyWebhookSignature(signature, rawBody, secret)

  if (!result.valid) {
    // A failed signature is rejected outright — never processed "just in case".
    return NextResponse.json({ error: result.reason }, { status: 400 })
  }

  const event = JSON.parse(rawBody) as { type: string; paymentId: string; status?: string }

  recent.unshift({
    type: event.type,
    paymentId: event.paymentId,
    receivedAt: new Date().toISOString(),
  })
  recent.length = Math.min(recent.length, 20)

  // This is where a real store would release the order, email the customer, decrement stock.
  console.log(`[demo-store] ${event.type} for ${event.paymentId} (status: ${event.status})`)

  return NextResponse.json({ received: true })
}

export async function GET() {
  return NextResponse.json({ data: recent })
}
