import { NextResponse } from "next/server"
import { PayFlux, PayFluxError } from "payflux-sdk"

export const dynamic = "force-dynamic"

/**
 * The demo store's checkout endpoint.
 *
 * This is the whole point of the demo: it uses the published SDK exactly the way an external
 * developer would. There is no privileged path, no special-casing inside PayFlux for the store,
 * and no chain code here — the store knows about dollars and products, nothing else.
 */

const PRODUCTS: Record<string, { name: string; price: string }> = {
  hoodie: { name: "Developer Hoodie", price: "50.00" },
  keycaps: { name: "Mechanical Keycap Set", price: "35.00" },
  stickers: { name: "Sticker Pack", price: "12.00" },
}

export async function POST(request: Request) {
  const secret = process.env.PAYFLUX_SECRET_KEY
  if (!secret) {
    return NextResponse.json(
      {
        error: {
          code: "API_KEY_NOT_CONFIGURED",
          message:
            "The demo store has no PAYFLUX_SECRET_KEY configured, so checkout is UNAVAILABLE. " +
            "Add it to .env.local.",
        },
      },
      { status: 503 },
    )
  }

  let body: { productId?: string; idempotencyKey?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_BODY", message: "Expected a JSON body." } },
      { status: 400 },
    )
  }

  const product = PRODUCTS[body.productId ?? ""]
  if (!product) {
    return NextResponse.json(
      { error: { code: "UNKNOWN_PRODUCT", message: `No product "${body.productId}".` } },
      { status: 404 },
    )
  }

  const payflux = new PayFlux({
    apiKey: secret,
    baseUrl: process.env.PAYFLUX_API_URL ?? "http://localhost:4000",
  })

  try {
    const payment = await payflux.payments.create({
      amount: product.price,
      currency: "USD",
      acceptedAssets: ["XRP", "FXRP", "C2FLR"],
      settlementAsset: "FXRP",
      orderId: `demo_${body.productId}_${Date.now()}`,
      metadata: { product: product.name, storefront: "payflux-demo-store" },
      // Guards against a double-submitted form creating two payments for one order.
      idempotencyKey: body.idempotencyKey,
    })

    return NextResponse.json({
      paymentId: payment.id,
      checkoutUrl: `/checkout/${payment.id}`,
      amount: payment.amount,
      currency: payment.currency,
    })
  } catch (error) {
    if (error instanceof PayFluxError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status || 502 },
      )
    }
    return NextResponse.json(
      {
        error: {
          code: "CHECKOUT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 502 },
    )
  }
}
