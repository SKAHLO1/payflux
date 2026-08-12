"use client"

import { cn } from "@/lib/utils"
import {
  chainLabel,
  formatAsset,
  formatDuration,
  SETTLEMENT_LABELS,
  VERIFICATION_LABELS,
} from "@/lib/payflux/format"
import type { PaymentRoute } from "@/lib/payflux/types"
import { CheckItem, Figure, RouteStatusBadge } from "./primitives"

/**
 * A payment route, as the customer sees it.
 *
 * Two decisions worth naming:
 *
 *  - The route's reasons are shown, not hidden. "Why this one?" is answered inline, because a
 *    recommendation nobody can interrogate is just an arbitrary default.
 *  - An unavailable route is still rendered, greyed, with its reason. Silently dropping it would
 *    hide the difference between "we don't support this" and "this isn't working right now".
 */
export function RouteCard({
  route,
  recommended,
  selected,
  onSelect,
  disabled,
}: {
  route: PaymentRoute
  recommended?: boolean
  selected?: boolean
  onSelect?: (route: PaymentRoute) => void
  disabled?: boolean
}) {
  const selectable = route.status !== "unavailable" && !disabled

  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={() => selectable && onSelect?.(route)}
      aria-pressed={selected}
      className={cn(
        "group relative w-full rounded-2xl border p-5 text-left transition-all duration-300",
        "hover:shadow-none",
        selectable
          ? "cursor-pointer border-white/15 bg-white/[0.06] backdrop-blur-md hover:border-[color:var(--pf-coral)]/60 hover:bg-white/[0.09]"
          : "cursor-not-allowed border-white/8 bg-white/[0.02] opacity-60",
        selected &&
          "border-[color:var(--pf-coral)] bg-white/[0.11] shadow-[var(--pf-glow-sm)]",
      )}
    >
      {recommended && route.status === "available" ? (
        <span className="absolute -top-2.5 right-5 rounded-full bg-[color:var(--pf-coral)] px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-white shadow-[var(--pf-glow-sm)]">
          Recommended
        </span>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-xl tracking-[0.06em] text-white">{route.sourceAsset}</p>
          <p className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-white/45">
            {chainLabel(route.sourceChain)}
          </p>
        </div>
        <div className="text-right">
          <Figure className="text-lg text-white">
            {formatAsset(route.estimatedInputAmount)}
          </Figure>
          <p className="mt-0.5 text-[11px] uppercase tracking-[0.12em] text-white/45">
            {route.sourceAsset}
          </p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-white/10 pt-3.5">
        <Stat label="Network fee" value={`~${formatAsset(route.estimatedFee, 4)} ${route.sourceAsset}`} />
        <Stat label="Estimated" value={formatDuration(route.estimatedTimeSeconds)} />
        <Stat
          label="Verification"
          value={VERIFICATION_LABELS[route.verificationMethod] ?? route.verificationMethod}
        />
      </dl>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <RouteStatusBadge status={route.status} />
        {route.destinationAsset ? (
          <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-white/55">
            Settles to {route.destinationAsset}
          </span>
        ) : null}
        {route.settlementMethod ? (
          <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-white/55">
            {SETTLEMENT_LABELS[route.settlementMethod] ?? route.settlementMethod}
          </span>
        ) : null}
        {typeof route.score === "number" ? (
          <span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-white/35">
            Score {route.score}
          </span>
        ) : null}
      </div>

      {route.status !== "unavailable" && route.reasons.length > 0 ? (
        <div className="mt-4 border-t border-white/10 pt-3.5">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-white/35">
            Why this route
          </p>
          <ul className="space-y-1.5">
            {route.reasons.slice(0, 4).map((reason) => (
              <CheckItem key={reason}>{reason}</CheckItem>
            ))}
          </ul>
        </div>
      ) : null}

      {route.unavailableReason ? (
        <p
          className={cn(
            "mt-4 border-t border-white/10 pt-3.5 text-[12px] leading-relaxed",
            route.status === "degraded" ? "text-[color:var(--pf-pending)]/90" : "text-white/45",
          )}
        >
          {route.supported ? "Supported, but not available right now: " : ""}
          {route.unavailableReason}
        </p>
      ) : null}
    </button>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-[0.12em] text-white/35">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] text-white/80">{value}</dd>
    </div>
  )
}
