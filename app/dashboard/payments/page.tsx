"use client"

import { useEffect, useState } from "react"
import { PageHeader } from "@/components/payflux/shell"
import { useAuth } from "@/components/payflux/auth-provider"
import { loadScoped, merchantSessionApi } from "@/lib/payflux/api-keys-client"
import { Surface, UnavailableNotice } from "@/components/payflux/primitives"
import { merchantApi } from "@/lib/payflux/client"
import type { Payment, PaymentStatus } from "@/lib/payflux/types"
import { PaymentTable, Loading } from "@/components/payflux/dashboard-ui"
import { cn } from "@/lib/utils"

const FILTERS: Array<{ id: string; label: string; match: (p: Payment) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  {
    id: "open",
    label: "Open",
    match: (p) => ["created", "awaiting_payment", "payment_detected", "verifying", "settling"].includes(p.status),
  },
  { id: "verified", label: "Verified", match: (p) => ["verified", "overpaid"].includes(p.status) },
  { id: "settled", label: "Settled", match: (p) => p.status === "settled" },
  {
    id: "problem",
    label: "Needs attention",
    match: (p) => ["failed", "expired", "partially_paid"].includes(p.status as PaymentStatus),
  },
]

export default function PaymentsPage() {
  const { getToken } = useAuth()
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [filter, setFilter] = useState("all")

  useEffect(() => {
    merchantApi
      .payments()
      .then((result) => setPayments(result.data))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0]
  const visible = payments.filter(active.match)

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Merchant"
        title="Payments"
        description="Every payment intent, in whatever state it actually reached."
      />

      {error ? (
        <UnavailableNotice title="Payments unavailable" detail={error} />
      ) : loading ? (
        <Loading />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((option) => {
              const count = payments.filter(option.match).length
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  className={cn(
                    "rounded-full border px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] transition-all duration-200 hover:shadow-none",
                    filter === option.id
                      ? "border-[color:var(--pf-coral)]/60 bg-[color:var(--pf-coral)]/15 text-white"
                      : "border-white/12 bg-white/[0.03] text-white/45 hover:text-white/80",
                  )}
                >
                  {option.label}
                  <span className="ml-2 text-white/35">{count}</span>
                </button>
              )
            })}
          </div>

          {visible.length === 0 ? (
            <Surface className="p-10 text-center">
              <p className="text-sm text-white/45">No payments match this filter.</p>
            </Surface>
          ) : (
            <PaymentTable payments={visible} />
          )}
        </>
      )}
    </div>
  )
}
