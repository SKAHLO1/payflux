import Link from "next/link"
import { Twitter, Linkedin, Github, ArrowRight } from "lucide-react"
import { Shell, TopNav } from "@/components/payflux/shell"
import {
  CheckItem,
  Figure,
  GhostLink,
  PrimaryLink,
  SectionLabel,
  Surface,
} from "@/components/payflux/primitives"

/**
 * The landing page.
 *
 * Keeps the original design's identity — violet gradient, Spline motion trails, Audiowide
 * display type, coral glow on the primary action — and repoints the message from a generic
 * "pay your bills" headline to the actual product thesis.
 */

const FLOW = [
  {
    step: "01",
    title: "Customer pays",
    chain: "XRPL Testnet",
    body: "The customer sends testXRP with a memo that binds the transfer to the payment intent. For FXRP settlement they pay the FAssets agent directly, so the payment itself backs the mint.",
  },
  {
    step: "02",
    title: "Flare verifies",
    chain: "Flare Data Connector",
    body: "PayFlux requests a Payment attestation for testXRP. Flare's attestation providers vote, and a Merkle proof is published.",
  },
  {
    step: "03",
    title: "Coston2 records",
    chain: "PaymentRegistry",
    body: "The proof is submitted on-chain. The contract re-verifies it against FdcVerification — it never takes our word for it.",
  },
  {
    step: "04",
    title: "Merchant settles",
    chain: "FAssets · FXRP",
    body: "The attested payment executes an FAssets mint, and FXRP lands in the merchant's wallet. A real balance change, with a hash.",
  },
]

const ASSETS = [
  {
    symbol: "XRP",
    chain: "XRPL Testnet",
    status: "Payment",
    note: "Verified through an FDC Payment attestation. The flagship cross-ecosystem path.",
    live: true,
  },
  {
    symbol: "FXRP",
    chain: "Flare Coston2",
    status: "Payment · Settlement",
    note: "The FAssets representation of XRP. PayFlux's default settlement asset.",
    live: true,
  },
  {
    symbol: "C2FLR",
    chain: "Flare Coston2",
    status: "Payment · Settlement",
    note: "Native Coston2 payments. Final on arrival, so no external attestation is needed.",
    live: true,
  },
  {
    symbol: "BTC · DOGE",
    chain: "Bitcoin · Dogecoin Testnet",
    status: "Not supported",
    note: "FDC attests these chains, but PayFlux has no watcher or settlement path for them yet — so they are listed as unsupported.",
    live: false,
  },
]

export default function Home() {
  return (
    <Shell>
      <TopNav />

      {/* ---------------------------------------------------------------- hero */}
      <section className="grid items-center gap-12 px-6 pb-20 pt-8 md:px-12 lg:grid-cols-[1.05fr_0.95fr] lg:px-16">
        <div className="max-w-2xl">
          <p className="mb-5 text-[11px] font-bold uppercase tracking-[0.28em] text-[color:var(--pf-coral)] pf-text-glow">
            Interoperable asset payments
          </p>

          <h1 className="font-display text-4xl leading-[1.12] tracking-[0.02em] text-white sm:text-5xl lg:text-6xl">
            ONE PAYMENT API
            <br />
            FOR ASSETS
            <br />
            ACROSS CHAINS
          </h1>

          <p className="mt-7 max-w-xl text-base leading-relaxed text-white/70">
            Blockchain assets are fragmented. Developers shouldn&apos;t have to integrate every
            ecosystem individually just to accept payment. PayFlux normalizes payment, verification
            and settlement behind one interface — the merchant thinks in{" "}
            <span className="text-white">$50</span>, not{" "}
            <span className="text-white">73.21 XRP</span>.
          </p>

          <div className="mt-10 flex flex-wrap gap-4">
            <PrimaryLink href="/store">
              Try the demo store
              <ArrowRight className="h-3.5 w-3.5" />
            </PrimaryLink>
            <GhostLink href="/docs">Read the docs</GhostLink>
          </div>

          <div className="mt-12 flex flex-wrap items-center gap-x-10 gap-y-4">
            <Metric value="XRPL" label="Source chain" />
            <Metric value="FDC" label="Verification" />
            <Metric value="FAssets" label="Settlement" />
            <Metric value="Coston2" label="Record of truth" />
          </div>
        </div>

        {/* The integration is the product. Show the code, not a hero image. */}
        <Surface strong className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <span className="pf-hash text-white/45">checkout.ts</span>
            <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-white/50">
              payflux-sdk
            </span>
          </div>
          <pre className="overflow-x-auto px-5 py-5 text-[12.5px] leading-relaxed">
            <code className="font-mono text-white/80">
              <span className="text-[color:var(--pf-violet-400)]">import</span>{" "}
              {"{ PayFlux }"} <span className="text-[color:var(--pf-violet-400)]">from</span>{" "}
              <span className="text-[color:var(--pf-info)]">&quot;payflux-sdk&quot;</span>
              {"\n\n"}
              <span className="text-[color:var(--pf-violet-400)]">const</span> payflux ={" "}
              <span className="text-[color:var(--pf-violet-400)]">new</span> PayFlux({"{"}
              {"\n  "}apiKey: process.env.PAYFLUX_SECRET_KEY,
              {"\n"}
              {"}"});
              {"\n\n"}
              <span className="text-[color:var(--pf-violet-400)]">const</span> payment ={" "}
              <span className="text-[color:var(--pf-violet-400)]">await</span>{" "}
              payflux.payments.create({"{"}
              {"\n  "}amount: <span className="text-[color:var(--pf-info)]">&quot;50.00&quot;</span>,
              {"\n  "}currency: <span className="text-[color:var(--pf-info)]">&quot;USD&quot;</span>,
              {"\n  "}acceptedAssets: [
              <span className="text-[color:var(--pf-info)]">&quot;XRP&quot;</span>,{" "}
              <span className="text-[color:var(--pf-info)]">&quot;FXRP&quot;</span>,{" "}
              <span className="text-[color:var(--pf-info)]">&quot;C2FLR&quot;</span>],
              {"\n  "}settlementAsset:{" "}
              <span className="text-[color:var(--pf-info)]">&quot;FXRP&quot;</span>,
              {"\n"}
              {"}"});
            </code>
          </pre>
          <div className="border-t border-white/10 px-5 py-4">
            <p className="text-[12px] leading-relaxed text-white/50">
              No XRPL SDK. No FDC client. No FAssets lot arithmetic. No transaction watcher. The
              merchant integrates PayFlux — adding a chain later means adding an adapter, not
              rewriting the payment engine.
            </p>
          </div>
        </Surface>
      </section>

      {/* --------------------------------------------------------- how it works */}
      <section
        id="how-it-works"
        className="border-t border-white/10 px-6 py-20 md:px-12 lg:px-16"
      >
        <div className="mb-12 max-w-2xl">
          <SectionLabel>The lifecycle</SectionLabel>
          <h2 className="font-display mt-3 text-2xl leading-tight tracking-[0.04em] text-white md:text-3xl">
            A PAYMENT THAT CROSSES ECOSYSTEMS,
            <br />
            AND PROVES IT
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-white/60">
            Each stage produces something a third party can check. That is the difference between a
            payment gateway and an interoperability layer.
          </p>
        </div>

        <ol className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {FLOW.map((stage) => (
            <li key={stage.step}>
              <Surface className="h-full p-6">
                <div className="flex items-baseline justify-between">
                  <Figure className="text-3xl text-[color:var(--pf-coral)]">{stage.step}</Figure>
                  <span className="text-[10px] uppercase tracking-[0.14em] text-white/40">
                    {stage.chain}
                  </span>
                </div>
                <h3 className="font-display mt-5 text-base tracking-[0.06em] text-white">
                  {stage.title}
                </h3>
                <p className="mt-2.5 text-[13px] leading-relaxed text-white/55">{stage.body}</p>
              </Surface>
            </li>
          ))}
        </ol>
      </section>

      {/* ------------------------------------------------------------- assets */}
      <section id="assets" className="border-t border-white/10 px-6 py-20 md:px-12 lg:px-16">
        <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <SectionLabel>Asset registry</SectionLabel>
            <h2 className="font-display mt-3 text-2xl leading-tight tracking-[0.04em] text-white md:text-3xl">
              SUPPORTED MEANS
              <br />
              IMPLEMENTED
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-white/60">
              An asset appears as supported only when the whole path exists — watcher,
              verification and settlement. The router then answers a second, separate question on
              every checkout: is it available <em>right now</em>?
            </p>
            <ul className="mt-6 space-y-2.5">
              <CheckItem>Prices come from FTSOv2 feeds read on Coston2</CheckItem>
              <CheckItem>FAssets capacity is checked live, per payment</CheckItem>
              <CheckItem>No route is offered that PayFlux cannot execute</CheckItem>
            </ul>
          </div>

          <ul className="space-y-3">
            {ASSETS.map((asset) => (
              <li key={asset.symbol}>
                <Surface className="flex flex-wrap items-center gap-x-6 gap-y-3 p-5">
                  <div className="min-w-[7rem]">
                    <p className="font-display text-lg tracking-[0.08em] text-white">
                      {asset.symbol}
                    </p>
                    <p className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-white/40">
                      {asset.chain}
                    </p>
                  </div>
                  <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-white/55">
                    {asset.note}
                  </p>
                  <span
                    className={
                      asset.live
                        ? "shrink-0 rounded-full border border-[color:var(--pf-success)]/40 bg-[color:var(--pf-success)]/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--pf-success)]"
                        : "shrink-0 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40"
                    }
                  >
                    {asset.status}
                  </span>
                </Surface>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* -------------------------------------------------------------- thesis */}
      <section className="border-t border-white/10 px-6 py-20 md:px-12 lg:px-16">
        <Surface strong className="p-8 md:p-12">
          <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <SectionLabel>The abstraction</SectionLabel>
              <p className="font-display mt-4 text-xl leading-relaxed tracking-[0.03em] text-white md:text-2xl">
                Source asset and source chain go in. A verified payment comes out, in the
                settlement asset the merchant asked for.
              </p>
              <p className="mt-5 text-sm leading-relaxed text-white/60">
                The API stays constant while the chains underneath change. That is the whole
                proposition — and the reason PayFlux refuses to list an asset it cannot actually
                move, or claim a verification it cannot actually prove.
              </p>
              <div className="mt-8 flex flex-wrap gap-4">
                <PrimaryLink href="/store">See it end to end</PrimaryLink>
                <GhostLink href="/dashboard/diagnostics">Check what&apos;s live</GhostLink>
              </div>
            </div>

            <div className="rounded-2xl border border-white/12 bg-black/15 p-6">
              <pre className="overflow-x-auto text-[12px] leading-[1.9] text-white/60">
                <code className="font-mono">
                  {`  Source asset
  Source chain
        │
        ▼
     PayFlux
        │
        ▼
  Verified payment
        │
        ▼
  Settlement asset
  Settlement chain`}
                </code>
              </pre>
            </div>
          </div>
        </Surface>
      </section>

      {/* -------------------------------------------------------------- footer */}
      <footer className="border-t border-white/10 px-6 py-10 md:px-12 lg:px-16">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex gap-6">
            <Twitter className="h-4 w-4 cursor-pointer text-white/60 transition-all duration-300 hover:text-[color:var(--pf-coral)] hover:drop-shadow-[0_0_12px_rgba(239,68,68,0.9)]" />
            <Linkedin className="h-4 w-4 cursor-pointer text-white/60 transition-all duration-300 hover:text-[color:var(--pf-coral)] hover:drop-shadow-[0_0_12px_rgba(239,68,68,0.9)]" />
            <Github className="h-4 w-4 cursor-pointer text-white/60 transition-all duration-300 hover:text-[color:var(--pf-coral)] hover:drop-shadow-[0_0_12px_rgba(239,68,68,0.9)]" />
          </div>

          <p className="text-[11px] leading-relaxed text-white/35">
            PayFlux runs on Flare Coston2 and XRPL Testnet. Testnet only — no mainnet value is ever
            moved.{" "}
            <Link href="/dashboard/diagnostics" className="underline underline-offset-4 hover:text-white/60">
              Live capability report
            </Link>
          </p>
        </div>
      </footer>
    </Shell>
  )
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <Figure className="block text-lg text-white">{value}</Figure>
      <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-white/40">{label}</p>
    </div>
  )
}
