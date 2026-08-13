import type React from "react"
import Link from "next/link"
import Image from "next/image"
import { cn } from "@/lib/utils"
import { AmbientBackground, AmbientBloom } from "./ambient"

/**
 * The page shell.
 *
 * Keeps the original landing page's signature: the violet gradient ground and the Spline motion
 * trails behind everything. `ambient={false}` drops the 3D layer for data-dense screens, where a
 * moving background behind a table of hashes is actively hostile — the gradient identity stays.
 */

/**
 * The mark plus wordmark.
 *
 * Deliberately not the full stacked lockup: that version carries the wordmark and the "crypto
 * payments, simplified" tagline beneath the P, which needs vertical room a 40px nav bar does not
 * have. The mark sits beside the existing Audiowide wordmark instead, which keeps the header
 * proportions and lets the type stay live text.
 *
 * The knockout variant is used because the mark's own wine red is nearly invisible against the
 * maroon ground it now shares.
 */
export function BrandMark({ className, subtitle }: { className?: string; subtitle?: string }) {
  return (
    <Link href="/" className={cn("group inline-flex items-center gap-2.5", className)}>
      <Image
        src="/payflux-mark-light.png"
        alt=""
        width={640}
        height={467}
        // Decorative: the wordmark beside it already names the product, so announcing it twice
        // only makes the link more tedious to hear.
        aria-hidden
        priority
        className="h-6 w-auto transition-all duration-300 group-hover:drop-shadow-[0_0_10px_rgba(214,57,79,0.7)]"
      />
      <span className="font-display text-lg tracking-[0.14em] text-white transition-all duration-300 group-hover:text-[color:var(--pf-accent)] group-hover:drop-shadow-[0_0_10px_rgba(214,57,79,0.7)]">
        PAYFLUX
      </span>
      {subtitle ? (
        <span className="self-end pb-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
          {subtitle}
        </span>
      ) : null}
    </Link>
  )
}

export function NetworkPill() {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/60">
      <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--pf-info)]" aria-hidden />
      Coston2 · XRPL Testnet
    </span>
  )
}

export function Shell({
  children,
  ambient = true,
  deep = false,
  className,
}: {
  children: React.ReactNode
  ambient?: boolean
  deep?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative min-h-screen overflow-x-hidden",
        deep ? "pf-gradient-deep" : "pf-gradient",
        className,
      )}
    >
      {ambient ? (
        <AmbientBackground />
      ) : (
        // The same bloom without the 3D scene — keeps the brand's warmth on the quiet screens.
        <AmbientBloom className="pointer-events-none absolute inset-0 z-0 opacity-70" />
      )}

      <div className="relative z-10">{children}</div>
    </div>
  )
}

const NAV_ITEMS = [
  { href: "/docs", label: "Docs" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/store", label: "Demo store" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/diagnostics", label: "Diagnostics" },
]

export function TopNav({ items = NAV_ITEMS }: { items?: Array<{ href: string; label: string }> }) {
  return (
    <nav className="flex flex-wrap items-center justify-between gap-6 px-6 py-7 md:px-12 lg:px-16">
      <div className="flex items-center gap-5">
        <BrandMark />
        <NetworkPill />
      </div>
      <ul className="flex flex-wrap items-center gap-7">
        {items.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="pf-nav-link">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-6 border-b border-white/10 pb-6">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.24em] text-[color:var(--pf-coral)]">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-display text-2xl leading-tight tracking-[0.04em] text-white md:text-3xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
    </header>
  )
}
