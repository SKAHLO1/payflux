"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { PageHeader } from "@/components/payflux/shell"
import { PrimaryButton, GhostButton, SectionLabel, Surface } from "@/components/payflux/primitives"
import { API_BASE } from "@/lib/payflux/client"
import { runKeyCheck, type CheckResult, type KeyCheckReport } from "@/lib/payflux/key-check"

/**
 * Key playground.
 *
 * The question this answers is "does the key I just created actually work?", and the honest way
 * to answer it is to use the key against the real API rather than to describe what would happen.
 *
 * The key is sent from this browser straight to the PayFlux API and never to this website's
 * server — there is no route handler in the middle, which is the whole point. That claim is only
 * true because the checks run client-side, so it is stated on the page where a developer pasting
 * a secret can read it.
 */

type Phase = "idle" | "running" | "done"

export default function PlaygroundPage() {
  const [key, setKey] = useState("")
  const [reveal, setReveal] = useState(false)
  const [phase, setPhase] = useState<Phase>("idle")
  const [lines, setLines] = useState<CheckResult[]>([])
  const [report, setReport] = useState<KeyCheckReport | undefined>()

  const run = async () => {
    setPhase("running")
    setLines([])
    setReport(undefined)

    try {
      const result = await runKeyCheck(key.trim(), (line) =>
        setLines((previous) => [...previous, line]),
      )
      setReport(result)
    } catch (error) {
      setLines((previous) => [
        ...previous,
        {
          label: "Verification crashed",
          outcome: "fail",
          detail: error instanceof Error ? error.message : String(error),
        },
      ])
    } finally {
      setPhase("done")
    }
  }

  const canRun = key.trim().length > 12 && phase !== "running"

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Developer tools"
        title="Key playground"
        description="Paste a secret key and watch it authenticate against the live API. Every check below is a real request — nothing here is simulated."
      />

      <Surface className="p-6">
        <SectionLabel>Secret key</SectionLabel>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <input
              type={reveal ? "text" : "password"}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canRun) run()
              }}
              placeholder="sk_ctn2_…"
              spellCheck={false}
              autoComplete="off"
              // Keeps password managers from offering to save someone's API key.
              data-1p-ignore
              className="pf-hash w-full rounded-lg border border-white/12 bg-black/30 px-3.5 py-2.5 text-[13px] text-white/90 outline-none transition-colors placeholder:text-white/25 focus:border-[color:var(--pf-coral)]/60"
            />
            <button
              type="button"
              onClick={() => setReveal((value) => !value)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35 transition-colors hover:text-white/70"
            >
              {reveal ? "Hide" : "Show"}
            </button>
          </div>

          <PrimaryButton onClick={run} disabled={!canRun}>
            {phase === "running" ? "Running…" : "Verify key"}
          </PrimaryButton>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-white/40">
          Sent from your browser directly to{" "}
          <span className="pf-hash text-white/60">{API_BASE}</span>. It is never sent to this
          website&rsquo;s server, never stored, and never logged. Verification is capped at ten
          attempts a minute.
        </p>
      </Surface>

      <Terminal lines={lines} phase={phase} report={report} />

      <Surface className="p-6">
        <SectionLabel>What this runs</SectionLabel>
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-white/55">
          <li>
            <span className="text-white/80">Reads</span> — health, key identity and scopes, your
            payment list, and the routing table with live FTSOv2 quotes.
          </li>
          <li>
            <span className="text-white/80">One write</span> — a single $5.00 payment intent, so{" "}
            <span className="pf-hash">payments:write</span> is proven rather than assumed. It costs
            nothing on-chain and expires on its own.
          </li>
          <li>
            <span className="text-white/80">Never</span> — selecting a route. That opens the
            on-chain intent and reserves FAssets collateral, which spends real C2FLR that is not
            refunded if nobody pays.
          </li>
        </ul>
        <p className="mt-4 text-[12px] leading-relaxed text-white/35">
          A scope your key does not hold is reported as a correct refusal, not a failure — a
          read-only key being denied a write is the system working. For the full suite, including
          the destructive checks, run{" "}
          <span className="pf-hash text-white/55">npm run verify:key</span> against your own
          account.
        </p>
      </Surface>
    </div>
  )
}

function Terminal({
  lines,
  phase,
  report,
}: {
  lines: CheckResult[]
  phase: Phase
  report?: KeyCheckReport
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Follow the output as it lands, the way a terminal does.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [lines])

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-black/45">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="ml-2 pf-hash text-[11px] text-white/35">payflux verify-key</span>
      </div>

      <div ref={scrollRef} className="max-h-[26rem] overflow-y-auto px-4 py-4">
        {lines.length === 0 && phase === "idle" ? (
          <p className="pf-hash text-[12px] text-white/25">
            Waiting for a key. Results appear here as each request completes.
          </p>
        ) : null}

        <div className="space-y-2">
          {lines.map((line, index) => (
            <Line key={`${line.label}-${index}`} result={line} />
          ))}
        </div>

        {phase === "running" ? (
          <p className="pf-hash mt-2 text-[12px] text-white/40">
            <span className="inline-block animate-pulse">▍</span>
          </p>
        ) : null}

        {report ? <Summary report={report} /> : null}
      </div>
    </div>
  )
}

const OUTCOME_STYLE: Record<CheckResult["outcome"], { label: string; className: string }> = {
  pass: { label: "PASS", className: "text-emerald-400" },
  fail: { label: "FAIL", className: "text-[color:var(--pf-coral)]" },
  skip: { label: "SKIP", className: "text-amber-400" },
  info: { label: "NOTE", className: "text-sky-400" },
}

function Line({ result }: { result: CheckResult }) {
  const style = OUTCOME_STYLE[result.outcome]

  return (
    <div className="pf-hash text-[12px] leading-relaxed">
      <div className="flex gap-3">
        <span className={`shrink-0 font-semibold ${style.className}`}>{style.label}</span>
        <span className="min-w-0">
          <span className="text-white/85">{result.label}</span>{" "}
          <span className="text-white/40">{result.detail}</span>
        </span>
      </div>
      {result.extra?.length ? (
        <div className="mt-1 space-y-0.5 pl-[3.4rem]">
          {result.extra.map((extra, index) => (
            <p key={index} className="whitespace-pre text-[11px] text-white/30">
              {extra}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Summary({ report }: { report: KeyCheckReport }) {
  return (
    <div className="mt-4 border-t border-white/10 pt-3">
      <p className="pf-hash text-[12px]">
        <span className="text-emerald-400">{report.passed} passed</span>
        {report.failed > 0 ? (
          <span className="text-[color:var(--pf-coral)]">, {report.failed} failed</span>
        ) : (
          <span className="text-white/40"> — this key is working</span>
        )}
      </p>

      {report.paymentId ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Link
            href={`/dashboard/payments/${report.paymentId}`}
            className="pf-hash text-[11px] text-[color:var(--pf-coral)] underline-offset-4 hover:underline"
          >
            Inspect the payment it created →
          </Link>
          <span className="pf-hash text-[11px] text-white/25">
            expires on its own · nothing was spent on-chain
          </span>
        </div>
      ) : null}
    </div>
  )
}
