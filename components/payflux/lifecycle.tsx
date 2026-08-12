"use client"

import { cn } from "@/lib/utils"
import { eventLabel, timeAgo } from "@/lib/payflux/format"
import type { Payment, PaymentEvent, PaymentStatus } from "@/lib/payflux/types"
import { HashLink } from "./primitives"

/**
 * The payment lifecycle rail and the event timeline.
 *
 * The rail advances only on real status changes reported by the server. There is no animated
 * "progress" between stages, because between stages nothing is progressing — we are waiting on a
 * chain, and pretending otherwise is the exact illusion this product exists to avoid.
 */

const STAGES: Array<{ status: PaymentStatus; label: string; hint: string }> = [
  { status: "created", label: "Created", hint: "Intent created" },
  { status: "awaiting_payment", label: "Awaiting", hint: "Waiting for the customer" },
  { status: "payment_detected", label: "Detected", hint: "Transaction seen on the source chain" },
  { status: "verifying", label: "Verifying", hint: "FDC attestation in flight" },
  { status: "verified", label: "Verified", hint: "Proven by Flare, recorded on Coston2" },
  { status: "settling", label: "Settling", hint: "Moving into the settlement asset" },
  { status: "settled", label: "Settled", hint: "Merchant holds the asset" },
]

const TERMINAL_BAD: PaymentStatus[] = ["failed", "expired"]

export function LifecycleRail({ status }: { status: PaymentStatus }) {
  const failed = TERMINAL_BAD.includes(status)

  // Underpaid/overpaid sit alongside "verified" in the lifecycle rather than after it.
  const effective: PaymentStatus =
    status === "overpaid" || status === "partially_paid" ? "verified" : status

  const currentIndex = STAGES.findIndex((stage) => stage.status === effective)

  return (
    <ol className="flex w-full flex-wrap items-stretch gap-1.5">
      {STAGES.map((stage, index) => {
        const done = currentIndex > index
        const active = currentIndex === index
        const pending = currentIndex < index

        return (
          <li key={stage.status} className="min-w-[92px] flex-1" title={stage.hint}>
            <div
              className={cn(
                "h-1 w-full rounded-full transition-colors duration-500",
                done && "bg-[color:var(--pf-success)]",
                active && !failed && "pf-working",
                active && failed && "bg-[color:var(--pf-danger)]",
                pending && "bg-white/12",
              )}
            />
            <p
              className={cn(
                "mt-2 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors",
                done && "text-white/70",
                active && !failed && "text-[color:var(--pf-coral)]",
                active && failed && "text-[color:var(--pf-danger)]",
                pending && "text-white/25",
              )}
            >
              {stage.label}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The audit trail. Every stage links to the transaction or request it produced, which is what
 * turns "we verified it" into something a reader can check for themselves.
 */
export function EventTimeline({
  events,
  payment,
  explorer,
}: {
  events: PaymentEvent[]
  payment?: Payment
  explorer: { flare: string; xrpl: string }
}) {
  if (events.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-white/40">
        No events recorded yet.
      </p>
    )
  }

  return (
    <ol className="relative space-y-0">
      {events.map((event, index) => {
        const isLast = index === events.length - 1
        const failure = event.type.includes("failed") || event.type === "payment.expired"
        const link = explorerLinkFor(event, explorer)

        return (
          <li key={event.id} className="relative flex gap-4 pb-6 last:pb-0">
            {!isLast ? (
              <span
                className="absolute left-[5px] top-4 h-full w-px bg-white/12"
                aria-hidden
              />
            ) : null}

            <span
              className={cn(
                "relative z-10 mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-[color:var(--pf-violet-700)]/60",
                failure ? "bg-[color:var(--pf-danger)]" : "bg-[color:var(--pf-success)]",
              )}
              aria-hidden
            />

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-sm font-medium text-white/90">{eventLabel(event.type)}</p>
                <time
                  className="text-[11px] tabular-nums text-white/35"
                  dateTime={event.timestamp}
                  title={new Date(event.timestamp).toISOString()}
                >
                  {timeAgo(event.timestamp)}
                </time>
              </div>

              <p className="mt-0.5 text-[11px] uppercase tracking-[0.1em] text-white/30">
                {event.source}
              </p>

              {link ? (
                <div className="mt-2">
                  <HashLink hash={link.hash} href={link.href} label={link.label} />
                </div>
              ) : null}

              {renderDetail(event)}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function explorerLinkFor(
  event: PaymentEvent,
  explorer: { flare: string; xrpl: string },
): { hash: string; href: string; label: string } | undefined {
  const meta = event.metadata ?? {}
  const hash = (meta.transactionHash ?? meta.registryTransaction) as string | undefined
  if (!hash) return undefined

  const isXrpl = event.source === "xrpl-watcher" || event.type === "payment.detected"
  return {
    hash,
    href: isXrpl ? `${explorer.xrpl}/transactions/${hash}` : `${explorer.flare}/tx/${hash}`,
    label: isXrpl ? "XRPL transaction" : "Coston2 transaction",
  }
}

function renderDetail(event: PaymentEvent) {
  const meta = event.metadata ?? {}

  const details: Array<[string, string]> = []
  if (meta.votingRound) details.push(["Voting round", String(meta.votingRound)])
  if (meta.fdcRequestId) details.push(["FDC request", String(meta.fdcRequestId).slice(0, 18) + "…"])
  if (meta.attestedAmount) details.push(["Attested", `${meta.attestedAmount} drops`])
  if (meta.asset) details.push(["Asset", String(meta.asset)])
  if (meta.outputAmount) details.push(["Delivered", String(meta.outputAmount)])
  if (meta.detail) details.push(["Reason", String(meta.detail)])
  if (meta.error) details.push(["Error", String(meta.error)])

  if (details.length === 0) return null

  return (
    <dl className="mt-2 grid gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2">
      {details.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <dt className="shrink-0 uppercase tracking-[0.1em] text-white/30">{label}</dt>
          <dd className="min-w-0 break-words text-white/60">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
