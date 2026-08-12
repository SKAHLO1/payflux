"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Image from "next/image"
import { Loader2 } from "lucide-react"
import { Shell, TopNav } from "@/components/payflux/shell"
import {
  Figure,
  PrimaryButton,
  SectionLabel,
  Surface,
} from "@/components/payflux/primitives"

/**
 * The demo store.
 *
 * A separate application that happens to live in the same repo. It talks to PayFlux exclusively
 * through the published SDK (see app/api/checkout/route.ts) and knows nothing about XRPL, FDC,
 * FAssets or Coston2 — which is the entire claim the product makes.
 */

const PRODUCTS = [
  {
    id: "hoodie",
    name: "Developer Hoodie",
    price: "50.00",
    blurb: "Heavyweight cotton. The one you'll actually wear to the demo.",
    image: "/3d-purple-and-white-e-commerce-illustration-with-s.jpg",
  },
  {
    id: "keycaps",
    name: "Mechanical Keycap Set",
    price: "35.00",
    blurb: "Doubleshot PBT, violet on white. Nothing to do with blockchains.",
    image: "/gaming-headset.png",
  },
  {
    id: "stickers",
    name: "Sticker Pack",
    price: "12.00",
    blurb: "Twelve die-cut vinyl stickers. Cheapest way to test a small payment.",
    image: "/placeholder.jpg",
  },
]

export default function StorePage() {
  const router = useRouter()
  const [pending, setPending] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  const buy = async (productId: string) => {
    setPending(productId)
    setError(undefined)
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          // A stable key per click, so a double-submit cannot create two payments.
          idempotencyKey: `${productId}_${Date.now()}`,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? "Checkout failed.")
      router.push(body.checkoutUrl)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPending(undefined)
    }
  }

  return (
    <Shell>
      <TopNav />

      <section className="px-6 pb-16 pt-6 md:px-12 lg:px-16">
        <div className="max-w-2xl">
          <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.28em] text-[color:var(--pf-coral)] pf-text-glow">
            Demo storefront
          </p>
          <h1 className="font-display text-3xl leading-tight tracking-[0.03em] text-white md:text-4xl">
            AN ORDINARY STORE
            <br />
            THAT ACCEPTS ANY CHAIN
          </h1>
          <p className="mt-5 text-sm leading-relaxed text-white/65">
            This store integrates PayFlux the way any external developer would — one SDK call, no
            chain code. It has no idea XRPL, the Flare Data Connector or FAssets exist. Pick
            something and pay in whichever asset you happen to hold.
          </p>
        </div>

        {error ? (
          <p className="mt-8 max-w-2xl rounded-xl border border-[color:var(--pf-danger)]/40 bg-[color:var(--pf-danger)]/10 px-4 py-3 text-sm text-white/85">
            {error}
          </p>
        ) : null}

        <div className="mt-12 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {PRODUCTS.map((product) => (
            <Surface key={product.id} className="flex flex-col overflow-hidden">
              <div className="relative h-52 overflow-hidden border-b border-white/10 bg-black/20">
                <Image
                  src={product.image}
                  alt=""
                  fill
                  className="object-contain p-6 transition-transform duration-500 hover:scale-105"
                />
              </div>

              <div className="flex flex-1 flex-col p-6">
                <h2 className="font-display text-base tracking-[0.06em] text-white">
                  {product.name}
                </h2>
                <p className="mt-2 flex-1 text-[13px] leading-relaxed text-white/50">
                  {product.blurb}
                </p>

                <div className="mt-6 flex items-center justify-between gap-4">
                  <Figure className="text-2xl text-white">${product.price}</Figure>
                  <PrimaryButton
                    disabled={Boolean(pending)}
                    onClick={() => buy(product.id)}
                    className="px-6 py-2.5"
                  >
                    {pending === product.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Pay with PayFlux
                  </PrimaryButton>
                </div>
              </div>
            </Surface>
          ))}
        </div>
      </section>

      <section className="border-t border-white/10 px-6 py-16 md:px-12 lg:px-16">
        <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <SectionLabel>What the store code looks like</SectionLabel>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-white/60">
              This is the complete integration. No RPC endpoints, no ABIs, no attestation types, no
              lot sizes, no transaction watcher. Adding a new source chain later is PayFlux&apos;s
              problem, not the store&apos;s.
            </p>
          </div>

          <Surface className="overflow-hidden">
            <div className="border-b border-white/10 px-5 py-3">
              <span className="pf-hash text-white/45">app/api/checkout/route.ts</span>
            </div>
            <pre className="overflow-x-auto px-5 py-5 text-[12.5px] leading-relaxed">
              <code className="font-mono text-white/75">
                {`const payflux = new PayFlux({
  apiKey: process.env.PAYFLUX_SECRET_KEY,
})

const payment = await payflux.payments.create({
  amount: product.price,
  currency: "USD",
  acceptedAssets: ["XRP", "FXRP", "C2FLR"],
  settlementAsset: "FXRP",
  orderId: order.id,
  idempotencyKey: order.id,
})

redirect(\`/checkout/\${payment.id}\`)`}
              </code>
            </pre>
          </Surface>
        </div>
      </section>
    </Shell>
  )
}
