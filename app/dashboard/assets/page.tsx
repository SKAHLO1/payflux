"use client"

import { useEffect, useState } from "react"
import { PageHeader } from "@/components/payflux/shell"
import { SectionLabel, Surface, UnavailableNotice } from "@/components/payflux/primitives"
import { payfluxApi } from "@/lib/payflux/client"
import { chainLabel } from "@/lib/payflux/format"
import type { HealthReport, PaymentAsset } from "@/lib/payflux/types"
import { Loading } from "@/components/payflux/dashboard-ui"
import { cn } from "@/lib/utils"

export default function AssetsPage() {
  const [assets, setAssets] = useState<PaymentAsset[]>([])
  const [health, setHealth] = useState<HealthReport | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    Promise.all([payfluxApi.assets(), payfluxApi.health().catch(() => undefined)])
      .then(([assetList, healthReport]) => {
        setAssets(assetList.data)
        setHealth(healthReport)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Registry"
        title="Assets"
        description="What PayFlux supports, and what it deliberately does not. An asset is listed as supported only when its whole path — watcher, verification, settlement — is implemented."
      />

      {error ? (
        <UnavailableNotice title="Assets unavailable" detail={error} />
      ) : loading ? (
        <Loading />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {assets.map((asset) => (
              <Surface
                key={asset.id}
                className={cn("p-6", !asset.enabled && "opacity-60")}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-display text-xl tracking-[0.08em] text-white">
                      {asset.symbol}
                    </p>
                    <p className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-white/40">
                      {chainLabel(asset.chain)} · {asset.type}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Capability on={asset.supportsPayment} label="Payment" />
                    <Capability on={asset.supportsSettlement} label="Settlement" />
                  </div>
                </div>

                {asset.note ? (
                  <p className="mt-4 text-[13px] leading-relaxed text-white/55">{asset.note}</p>
                ) : null}

                <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-white/10 pt-4 text-[12px]">
                  <div>
                    <dt className="text-[10px] uppercase tracking-[0.12em] text-white/30">
                      Decimals
                    </dt>
                    <dd className="mt-0.5 text-white/70">{asset.decimals}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-[0.12em] text-white/30">
                      Enabled
                    </dt>
                    <dd
                      className={cn(
                        "mt-0.5",
                        asset.enabled ? "text-[color:var(--pf-success)]" : "text-white/40",
                      )}
                    >
                      {asset.enabled ? "Yes" : "No"}
                    </dd>
                  </div>
                </dl>
              </Surface>
            ))}
          </div>

          {health?.fassets ? (
            <Surface className="p-6">
              <SectionLabel>FAssets parameters (live from Coston2)</SectionLabel>
              {health.fassets.available ? (
                <dl className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                  <Param label="Lot size" value={`${health.fassets.lotSizeXrp ?? "—"} XRP`} />
                  <Param label="Free lots" value={String(health.fassets.totalFreeLots ?? "—")} />
                  <Param label="Agents" value={String(health.fassets.agentCount ?? "—")} />
                  <Param
                    label="Max mintable"
                    value={`${health.fassets.maxMintableXrp ?? "—"} XRP`}
                  />
                </dl>
              ) : (
                <p className="mt-3 text-[13px] leading-relaxed text-white/50">
                  <span className="font-semibold uppercase tracking-[0.12em] text-white/70">
                    Unavailable
                  </span>{" "}
                  — {health.fassets.detail ?? "the FAssets AssetManager could not be read."}
                </p>
              )}
              <p className="mt-4 text-[12px] leading-relaxed text-white/40">
                These are read from the AssetManager contract on every request, never hardcoded.
                Lot size is why an XRP payment amount is rounded up: FAssets mints whole lots, and
                PayFlux surfaces the difference as price impact rather than absorbing it silently.
              </p>
            </Surface>
          ) : null}
        </>
      )}
    </div>
  )
}

function Capability({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
        on
          ? "border-[color:var(--pf-success)]/40 bg-[color:var(--pf-success)]/10 text-[color:var(--pf-success)]"
          : "border-white/12 bg-white/[0.03] text-white/30",
      )}
    >
      {label}
    </span>
  )
}

function Param({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.12em] text-white/30">{label}</dt>
      <dd className="font-display mt-1 text-base text-white">{value}</dd>
    </div>
  )
}
