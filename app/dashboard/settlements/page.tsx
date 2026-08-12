"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { PageHeader } from "@/components/payflux/shell"
import { useAuth } from "@/components/payflux/auth-provider"
import { loadScoped, merchantSessionApi } from "@/lib/payflux/api-keys-client"
import {
  Figure,
  HashLink,
  SectionLabel,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { merchantApi } from "@/lib/payflux/client"
import { chainLabel, formatAsset, timeAgo } from "@/lib/payflux/format"
import type { Settlement } from "@/lib/payflux/types"
import { Loading } from "@/components/payflux/dashboard-ui"
import { cn } from "@/lib/utils"

const EXPLORER = "https://coston2-explorer.flare.network"

const STATUS_STYLES: Record<Settlement["status"], string> = {
  completed: "text-[color:var(--pf-success)] border-[color:var(--pf-success)]/40 bg-[color:var(--pf-success)]/10",
  processing: "text-[color:var(--pf-pending)] border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/10",
  pending: "text-[color:var(--pf-pending)] border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/10",
  quoted: "text-white/60 border-white/20 bg-white/5",
  failed: "text-[color:var(--pf-danger)] border-[color:var(--pf-danger)]/40 bg-[color:var(--pf-danger)]/10",
}

export default function SettlementsPage() {
  const { getToken } = useAuth()
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    merchantApi
      .settlements()
      .then((result) => setSettlements(result.data))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Merchant"
        title="Settlements"
        description="Value actually delivered to the merchant. A settlement appears as completed only when a confirmed transaction moved it and the destination balance changed."
      />

      {error ? (
        <UnavailableNotice title="Settlements unavailable" detail={error} />
      ) : loading ? (
        <Loading />
      ) : settlements.length === 0 ? (
        <Surface className="p-10 text-center">
          <p className="text-sm text-white/45">
            No settlements yet. They appear once a verified payment has been settled into the
            merchant&apos;s chosen asset.
          </p>
        </Surface>
      ) : (
        <div className="space-y-4">
          {settlements.map((settlement) => (
            <Surface key={settlement.id} className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <SectionLabel>Settlement</SectionLabel>
                  <p className="pf-hash mt-1.5 text-white/70">{settlement.id}</p>
                </div>
                <span
                  className={cn(
                    "rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]",
                    STATUS_STYLES[settlement.status],
                  )}
                >
                  {settlement.status}
                </span>
              </div>

              <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                <Cell label="Source">
                  <Figure className="text-base text-white">
                    {formatAsset(settlement.inputAmount)}
                  </Figure>{" "}
                  <span className="text-[12px] text-white/50">{settlement.sourceAsset}</span>
                  <p className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-white/30">
                    {chainLabel(settlement.sourceChain)}
                  </p>
                </Cell>
                <Cell label="Destination">
                  <Figure className="text-base text-white">
                    {formatAsset(settlement.outputAmount)}
                  </Figure>{" "}
                  <span className="text-[12px] text-white/50">{settlement.destinationAsset}</span>
                  <p className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-white/30">
                    {chainLabel(settlement.destinationChain)}
                  </p>
                </Cell>
                <Cell label="Provider">
                  <span className="text-[13px] text-white/70">{settlement.provider ?? "—"}</span>
                  <p className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-white/30">
                    {timeAgo(settlement.completedAt ?? settlement.createdAt)}
                  </p>
                </Cell>
                <Cell label="Transaction">
                  <HashLink
                    hash={settlement.transactionHash}
                    href={
                      settlement.transactionHash
                        ? `${EXPLORER}/tx/${settlement.transactionHash}`
                        : undefined
                    }
                  />
                </Cell>
              </div>

              {settlement.failureDetail ? (
                <p className="mt-5 border-t border-white/10 pt-4 text-[12px] leading-relaxed text-[color:var(--pf-danger)]/90">
                  {settlement.failureDetail}
                </p>
              ) : null}

              <Link
                href={`/dashboard/payments/${settlement.paymentId}`}
                className="mt-4 inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-white/45 underline underline-offset-4 transition-colors hover:text-[color:var(--pf-coral)]"
              >
                View payment
              </Link>
            </Surface>
          ))}
        </div>
      )}
    </div>
  )
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/35">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}
