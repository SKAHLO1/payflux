"use client"

import Link from "next/link"
import { Loader2 } from "lucide-react"
import { Figure, StatusBadge, Surface } from "./primitives"
import { formatFiat, timeAgo } from "@/lib/payflux/format"
import type { Payment } from "@/lib/payflux/types"

/**
 * Dashboard pieces shared across pages.
 *
 * They live here rather than in a page file because Next restricts what a route module may
 * export — a page can export a default and a small set of known config names, nothing else.
 */

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-20 text-white/45">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export function PaymentTable({ payments }: { payments: Payment[] }) {
  return (
    <Surface className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-white/10">
              {["Payment", "Amount", "Asset", "Status", "Created", ""].map((header, index) => (
                <th
                  key={header || `col-${index}`}
                  className="px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => (
              <tr
                key={payment.id}
                className="border-b border-white/[0.06] transition-colors last:border-0 hover:bg-white/[0.04]"
              >
                <td className="px-5 py-3.5">
                  <span className="pf-hash text-white/80">{payment.paymentReference}</span>
                  {payment.orderId ? (
                    <p className="mt-0.5 text-[10px] text-white/30">{payment.orderId}</p>
                  ) : null}
                </td>
                <td className="px-5 py-3.5">
                  <Figure className="text-sm text-white/90">
                    {formatFiat(payment.amount, payment.currency)}
                  </Figure>
                </td>
                <td className="px-5 py-3.5 text-sm text-white/60">
                  {payment.selectedAsset ?? (
                    // Before the customer chooses, show what they may choose from.
                    <span className="text-white/25">{payment.acceptedAssets.join(" · ")}</span>
                  )}
                </td>
                <td className="px-5 py-3.5">
                  <StatusBadge status={payment.status} />
                </td>
                <td className="px-5 py-3.5 text-[12px] text-white/45">
                  {timeAgo(payment.createdAt)}
                </td>
                <td className="px-5 py-3.5 text-right">
                  <Link
                    href={`/dashboard/payments/${payment.id}`}
                    className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/50 underline underline-offset-4 transition-colors hover:text-[color:var(--pf-coral)]"
                  >
                    Details
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Surface>
  )
}
