"use client"

import { useEffect, useState } from "react"
import { PageHeader } from "@/components/payflux/shell"
import {
  GhostButton,
  SectionLabel,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { RouteCard } from "@/components/payflux/route-card"
import { payfluxApi } from "@/lib/payflux/client"
import type { PaymentRoute } from "@/lib/payflux/types"
import { Loading } from "@/components/payflux/dashboard-ui"

const ASSETS = ["XRP", "FXRP", "C2FLR"]

/**
 * Route explorer.
 *
 * Live, not a mock: it hits the same router the checkout uses, so what a merchant sees here is
 * exactly what a customer would be offered for that amount right now — including the routes that
 * are supported but currently unavailable, with the reason.
 */
export default function RoutesPage() {
  const [amount, setAmount] = useState("50.00")
  const [routes, setRoutes] = useState<PaymentRoute[]>([])
  const [recommended, setRecommended] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()

  const load = (value: string) => {
    setLoading(true)
    setError(undefined)
    payfluxApi
      .previewRoutes(value, ASSETS)
      .then((result) => {
        setRoutes(result.data)
        setRecommended(result.recommended)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load(amount)
    // Intentionally only on mount; re-running is driven by the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Router"
        title="Routes"
        description="What PayFlux would offer a customer right now, and why. Availability is recomputed against live FTSOv2 prices and live FAssets capacity on every request."
      />

      <Surface className="flex flex-wrap items-end gap-4 p-5">
        <label className="min-w-[10rem] flex-1">
          <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
            Amount (USD)
          </span>
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            className="w-full rounded-xl border border-white/15 bg-black/20 px-4 py-2.5 font-display text-lg text-white outline-none transition-colors focus:border-[color:var(--pf-coral)]/60"
          />
        </label>
        <GhostButton onClick={() => load(amount)} disabled={loading}>
          Recalculate
        </GhostButton>
      </Surface>

      {error ? (
        <UnavailableNotice title="Routes unavailable" detail={error} />
      ) : loading ? (
        <Loading label="Checking prices and settlement capacity…" />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {routes.map((route) => (
              <RouteCard key={route.id} route={route} recommended={route.id === recommended} />
            ))}
          </div>

          <Surface className="p-6">
            <SectionLabel>How the router scores</SectionLabel>
            <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-white/55">
              Executability dominates: a route that cannot run right now is never recommended,
              whatever its fee. After that the score weighs the estimated fee, the confirmation
              time, whether a settlement path exists, and any price impact from FAssets lot
              rounding. Cross-chain routes verified by FDC receive a bonus, because a
              trust-minimised proof is a stronger guarantee than a same-chain transfer — and it is
              worth the extra seconds.
            </p>
            <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-white/40">
              A route marked <em>supported but unavailable</em> means PayFlux implements the path
              and something upstream is blocking it — most often FAssets agent capacity. That
              distinction is kept explicit rather than collapsed into a shorter list.
            </p>
          </Surface>
        </>
      )}
    </div>
  )
}
