"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { PageHeader } from "@/components/payflux/shell"
import { useAuth } from "@/components/payflux/auth-provider"
import { loadScoped, merchantSessionApi } from "@/lib/payflux/api-keys-client"
import {
  DemoModeBanner,
  Figure,
  SectionLabel,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { Loading, PaymentTable } from "@/components/payflux/dashboard-ui"
import { merchantApi, payfluxApi } from "@/lib/payflux/client"
import { formatFiat } from "@/lib/payflux/format"
import type { HealthReport, Payment } from "@/lib/payflux/types"

export default function DashboardOverview() {
  const { getToken } = useAuth()
  const [payments, setPayments] = useState<Payment[]>([])
  const [health, setHealth] = useState<HealthReport | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    Promise.all([
      loadScoped(getToken, (t) => merchantSessionApi.payments(t), () => merchantApi.payments()).catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
        return { data: [] as Payment[] }
      }),
      payfluxApi.health().catch(() => undefined),
    ])
      .then(([paymentList, healthReport]) => {
        setPayments(paymentList.data)
        setHealth(healthReport)
      })
      .finally(() => setLoading(false))
  }, [])

  const stats = useMemo(() => {
    const settled = payments.filter((p) => p.status === "settled")
    const verified = payments.filter((p) =>
      ["verified", "settling", "settled", "overpaid"].includes(p.status),
    )
    const failed = payments.filter((p) => ["failed", "expired"].includes(p.status))
    const volume = settled.reduce((sum, p) => sum + Number(p.amount), 0)

    return [
      { label: "Payments", value: String(payments.length) },
      { label: "Verified", value: String(verified.length) },
      { label: "Settled volume", value: formatFiat(String(volume), "USD") },
      { label: "Failed / expired", value: String(failed.length) },
    ]
  }, [payments])

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Merchant"
        title="Overview"
        description="Every payment PayFlux has handled for this merchant, with the live state of the infrastructure underneath."
      />

      {health?.mode === "DEMO" ? <DemoModeBanner /> : null}

      {error ? (
        <UnavailableNotice title="Merchant data unavailable" detail={error} />
      ) : loading ? (
        <Loading />
      ) : (
        <>
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map((stat) => (
              <Surface key={stat.label} className="p-5">
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
                  {stat.label}
                </dt>
                <dd className="mt-2">
                  <Figure className="text-2xl text-white">{stat.value}</Figure>
                </dd>
              </Surface>
            ))}
          </dl>

          {health ? <InfrastructureStrip health={health} /> : null}

          <section>
            <div className="mb-4 flex items-baseline justify-between">
              <SectionLabel>Recent payments</SectionLabel>
              <Link
                href="/dashboard/payments"
                className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45 underline underline-offset-4 transition-colors hover:text-white"
              >
                View all
              </Link>
            </div>

            {payments.length === 0 ? (
              <Surface className="p-8 text-center">
                <p className="text-sm text-white/50">
                  No payments yet.{" "}
                  <Link href="/store" className="underline underline-offset-4 hover:text-white">
                    Create one from the demo store
                  </Link>
                  .
                </p>
              </Surface>
            ) : (
              <PaymentTable payments={payments.slice(0, 8)} />
            )}
          </section>
        </>
      )}
    </div>
  )
}

function InfrastructureStrip({ health }: { health: HealthReport }) {
  const items = [
    { label: "FDC", ok: health.fdc.reachable, detail: health.fdc.detail },
    {
      label: "PaymentRegistry",
      ok: health.paymentRegistry.available,
      detail: health.paymentRegistry.detail,
    },
    { label: "FAssets / FXRP", ok: health.fassets.available, detail: health.fassets.detail },
    {
      label: "FTSOv2 pricing",
      ok: health.priceFeeds.every((f) => f.ok),
      detail: health.priceFeeds.find((f) => !f.ok)?.detail,
    },
  ]

  return (
    <Surface className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel>Infrastructure</SectionLabel>
        <Link
          href="/dashboard/diagnostics"
          className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45 underline underline-offset-4 transition-colors hover:text-white"
        >
          Full report
        </Link>
      </div>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-2.5" title={item.detail}>
            <span
              className={
                item.ok
                  ? "h-2 w-2 shrink-0 rounded-full bg-[color:var(--pf-success)]"
                  : "h-2 w-2 shrink-0 rounded-full bg-white/25"
              }
            />
            <span className="text-xs text-white/70">{item.label}</span>
            <span className="ml-auto text-[10px] uppercase tracking-[0.12em] text-white/35">
              {item.ok ? "Live" : "Unavailable"}
            </span>
          </li>
        ))}
      </ul>
    </Surface>
  )
}
