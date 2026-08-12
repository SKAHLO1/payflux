"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { CopyButton, SectionLabel, Surface } from "./primitives"

/**
 * Building blocks for the in-app documentation.
 *
 * Docs are part of the product here, not an afterthought bolted on in a different style — they
 * use the same violet glass surfaces and the same coral accent as the dashboard.
 */

export function DocSection({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string
  eyebrow?: string
  title: string
  children: React.ReactNode
}) {
  return (
    // scroll-mt clears the sticky header when jumping to an anchor.
    <section id={id} className="scroll-mt-24 border-t border-white/10 pt-12 first:border-0 first:pt-0">
      {eyebrow ? <SectionLabel>{eyebrow}</SectionLabel> : null}
      <h2 className="font-display mt-3 text-2xl leading-tight tracking-[0.03em] text-white">
        {title}
      </h2>
      <div className="mt-6 space-y-5 text-[14px] leading-relaxed text-white/65">{children}</div>
    </section>
  )
}

export function Code({
  children,
  language,
  filename,
}: {
  children: string
  language?: string
  filename?: string
}) {
  return (
    <Surface className="overflow-hidden">
      {filename || language ? (
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
          <span className="pf-hash text-white/45">{filename ?? language}</span>
          <CopyButton value={children} />
        </div>
      ) : null}
      <pre className="overflow-x-auto px-4 py-4 text-[12.5px] leading-relaxed">
        <code className="font-mono text-white/80">{children}</code>
      </pre>
    </Surface>
  )
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "good"
  title?: string
  children: React.ReactNode
}) {
  const styles = {
    info: "border-white/15 bg-white/[0.04]",
    warn: "border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/[0.08]",
    good: "border-[color:var(--pf-success)]/35 bg-[color:var(--pf-success)]/[0.07]",
  }[tone]

  return (
    <div className={cn("rounded-xl border px-4 py-3.5", styles)}>
      {title ? (
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-white/80">
          {title}
        </p>
      ) : null}
      <div className="text-[13px] leading-relaxed text-white/70">{children}</div>
    </div>
  )
}

export function DocTable({
  headers,
  rows,
}: {
  headers: string[]
  rows: React.ReactNode[][]
}) {
  return (
    <Surface className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-white/10">
              {headers.map((header) => (
                <th
                  key={header}
                  className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-b border-white/[0.06] last:border-0">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-4 py-2.5 align-top text-[13px] text-white/70">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Surface>
  )
}

export function Endpoint({
  method,
  path,
  auth,
  children,
}: {
  method: "GET" | "POST" | "PATCH"
  path: string
  auth: "key" | "session" | "public"
  children?: React.ReactNode
}) {
  const methodStyle = {
    GET: "text-[color:var(--pf-info)] border-[color:var(--pf-info)]/40",
    POST: "text-[color:var(--pf-success)] border-[color:var(--pf-success)]/40",
    PATCH: "text-[color:var(--pf-pending)] border-[color:var(--pf-pending)]/40",
  }[method]

  const authLabel = { key: "API key", session: "Signed in", public: "Public" }[auth]

  return (
    <div className="border-b border-white/[0.06] py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            "rounded border px-2 py-0.5 text-[10px] font-bold tracking-wider",
            methodStyle,
          )}
        >
          {method}
        </span>
        <code className="pf-hash text-white/85">{path}</code>
        <span className="ml-auto text-[10px] uppercase tracking-[0.12em] text-white/35">
          {authLabel}
        </span>
      </div>
      {children ? (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/50">{children}</p>
      ) : null}
    </div>
  )
}

/** Sticky section nav that tracks which heading is on screen. */
export function DocNav({ sections }: { sections: Array<{ id: string; label: string }> }) {
  const [active, setActive] = useState(sections[0]?.id)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible) setActive(visible.target.id)
      },
      // Only count a section as active once it reaches the upper third of the viewport.
      { rootMargin: "-80px 0px -66% 0px" },
    )

    for (const section of sections) {
      const element = document.getElementById(section.id)
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [sections])

  return (
    <nav className="lg:sticky lg:top-8">
      <SectionLabel>On this page</SectionLabel>
      <ul className="mt-4 space-y-0.5">
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className={cn(
                "block rounded-lg px-3 py-1.5 text-[12px] transition-colors",
                active === section.id
                  ? "bg-white/10 text-white"
                  : "text-white/40 hover:text-white/75",
              )}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
