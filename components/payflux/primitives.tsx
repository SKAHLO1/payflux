import type React from "react"
import Link from "next/link"
import { AlertTriangle, ArrowUpRight, Check, Copy, Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { STATUS_PRESENTATION, TONE_CLASSES, truncateHash } from "@/lib/payflux/format"
import type { PaymentStatus, RouteStatus } from "@/lib/payflux/types"

/**
 * The PayFlux component vocabulary.
 *
 * Everything here inherits the original design language — violet glass, coral for the one thing
 * that matters on a screen, Audiowide for figures — but the information design follows the rule
 * from the spec: blockchain detail is present and linkable, never in the customer's face.
 */

export function Surface({
  className,
  strong,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { strong?: boolean }) {
  return (
    <div
      className={cn(
        strong ? "pf-surface-strong" : "pf-surface",
        "rounded-2xl",
        className,
      )}
      {...props}
    />
  )
}

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[10px] font-bold uppercase tracking-[0.22em] text-white/45", className)}>
      {children}
    </p>
  )
}

export function Figure({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <span className={cn("font-display pf-figure", className)}>{children}</span>
  )
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function StatusBadge({ status, className }: { status: PaymentStatus; className?: string }) {
  const presentation = STATUS_PRESENTATION[status]
  const working = presentation.tone === "working"

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]",
        TONE_CLASSES[presentation.tone],
        className,
      )}
      title={presentation.description}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full bg-current",
          working && "pf-pulse-dot",
        )}
        aria-hidden
      />
      {presentation.label}
    </span>
  )
}

const ROUTE_STATUS_STYLES: Record<RouteStatus, string> = {
  available: "text-[color:var(--pf-success)] border-[color:var(--pf-success)]/40 bg-[color:var(--pf-success)]/10",
  degraded: "text-[color:var(--pf-pending)] border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/10",
  unavailable: "text-white/50 border-white/20 bg-white/5",
}

const ROUTE_STATUS_LABELS: Record<RouteStatus, string> = {
  available: "Available now",
  degraded: "Partly available",
  unavailable: "Unavailable",
}

export function RouteStatusBadge({ status }: { status: RouteStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
        ROUTE_STATUS_STYLES[status],
      )}
    >
      {ROUTE_STATUS_LABELS[status]}
    </span>
  )
}

/**
 * The honesty badge. Rendered wherever a capability is not wired up, so an unconfigured stack
 * reads as UNAVAILABLE rather than quietly showing nothing.
 */
export function CapabilityBadge({
  available,
  label,
  detail,
}: {
  available: boolean
  label: string
  detail?: string
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3 py-2.5",
        available
          ? "border-[color:var(--pf-success)]/30 bg-[color:var(--pf-success)]/[0.07]"
          : "border-white/15 bg-white/[0.03]",
      )}
    >
      <span
        className={cn(
          "mt-0.5 h-2 w-2 shrink-0 rounded-full",
          available ? "bg-[color:var(--pf-success)]" : "bg-white/30",
        )}
        aria-hidden
      />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-white/90">{label}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-white/50">
          {available ? "Live" : "UNAVAILABLE"}
          {detail ? ` — ${detail}` : ""}
        </p>
      </div>
    </div>
  )
}

export function DemoModeBanner() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/10 px-4 py-3">
      <AlertTriangle className="h-4 w-4 shrink-0 text-[color:var(--pf-pending)]" />
      <p className="text-xs leading-relaxed text-white/85">
        <span className="font-bold uppercase tracking-[0.14em] text-[color:var(--pf-pending)]">
          Demo mode
        </span>{" "}
        — this instance is not performing real verification. Nothing on this screen should be
        treated as evidence of an on-chain payment.
      </p>
    </div>
  )
}

export function UnavailableNotice({
  title,
  detail,
  action,
}: {
  title: string
  detail: string
  action?: React.ReactNode
}) {
  return (
    <Surface className="p-6">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-white/50" />
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm uppercase tracking-[0.12em] text-white/80">{title}</p>
          <p className="mt-2 text-sm leading-relaxed text-white/55">{detail}</p>
          {action ? <div className="mt-4">{action}</div> : null}
        </div>
      </div>
    </Surface>
  )
}

// ---------------------------------------------------------------------------
// Hashes and links
// ---------------------------------------------------------------------------

/**
 * Every hash in PayFlux is clickable and copyable. This is the component that makes the claim
 * "independently verifiable" actionable rather than rhetorical.
 */
export function HashLink({
  hash,
  href,
  label,
  full,
}: {
  hash?: string
  href?: string
  label?: string
  full?: boolean
}) {
  if (!hash) {
    return <span className="pf-hash text-white/30">—</span>
  }

  const text = full ? hash : truncateHash(hash)

  const body = (
    <>
      <span className="pf-hash">{text}</span>
      {href ? <ArrowUpRight className="h-3 w-3 shrink-0 opacity-60" /> : null}
    </>
  )

  return (
    <span className="inline-flex items-center gap-2">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          title={label ? `${label}: ${hash}` : hash}
          className="inline-flex items-center gap-1.5 text-white/80 underline decoration-white/20 underline-offset-4 transition-colors hover:text-[color:var(--pf-coral)] hover:decoration-[color:var(--pf-coral)]/50"
        >
          {body}
        </a>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-white/70" title={hash}>
          {body}
        </span>
      )}
      <CopyButton value={hash} />
    </span>
  )
}

export function CopyButton({ value, className }: { value: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value)
      }}
      aria-label="Copy to clipboard"
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-white/35 transition-colors hover:text-white hover:shadow-none",
        className,
      )}
    >
      <Copy className="h-3 w-3" />
    </button>
  )
}

export function DataRow({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5", className)}>
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-white/40">
        {label}
      </span>
      <span className="min-w-0 text-right text-sm text-white/85">{children}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-full px-7 py-3 text-xs font-bold uppercase tracking-[0.14em] transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-40"

export function PrimaryButton({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        BUTTON_BASE,
        "bg-white text-[color:var(--pf-violet-700)] hover:bg-white/90 hover:shadow-[var(--pf-glow)] disabled:hover:shadow-none",
        className,
      )}
      {...props}
    />
  )
}

export function GhostButton({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        BUTTON_BASE,
        "border-2 border-white/70 bg-transparent text-white hover:border-[color:var(--pf-coral)] hover:bg-white/10 hover:text-[color:var(--pf-coral)] hover:shadow-[var(--pf-glow)] disabled:hover:shadow-none",
        className,
      )}
      {...props}
    />
  )
}

export function PrimaryLink({
  href,
  children,
  className,
}: {
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        BUTTON_BASE,
        "bg-white text-[color:var(--pf-violet-700)] hover:bg-white/90 hover:shadow-[var(--pf-glow)]",
        className,
      )}
    >
      {children}
    </Link>
  )
}

export function GhostLink({
  href,
  children,
  className,
}: {
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        BUTTON_BASE,
        "border-2 border-white/70 bg-transparent text-white hover:border-[color:var(--pf-coral)] hover:bg-white/10 hover:text-[color:var(--pf-coral)] hover:shadow-[var(--pf-glow)]",
        className,
      )}
    >
      {children}
    </Link>
  )
}

export function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13px] leading-relaxed text-white/70">
      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--pf-success)]" />
      <span>{children}</span>
    </li>
  )
}
