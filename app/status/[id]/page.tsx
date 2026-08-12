"use client"

import { use } from "react"
import Link from "next/link"
import { Loader2 } from "lucide-react"
import { Shell, BrandMark, NetworkPill } from "@/components/payflux/shell"
import {
  CheckItem,
  SectionLabel,
  StatusBadge,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { ProofOfPayment } from "@/components/payflux/proof-view"
import { LifecycleRail, EventTimeline } from "@/components/payflux/lifecycle"
import { usePaymentStream } from "@/lib/payflux/use-payment-stream"
import { chainLabel, STATUS_PRESENTATION } from "@/lib/payflux/format"

const EXPLORER = {
  flare: "https://coston2-explorer.flare.network",
  xrpl: "https://testnet.xrpl.org",
}

/**
 * The public payment status page.
 *
 * Shareable, unauthenticated, and the page a judge is meant to land on: it says what happened,
 * and every claim it makes carries the hash that backs it.
 */
export default function StatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { payment, events, error } = usePaymentStream(id)

  return (
    <Shell ambient={false} deep>
      <header className="flex items-center justify-between px-6 py-6 md:px-10">
        <BrandMark subtitle="Payment status" />
        <NetworkPill />
      </header>

      <main className="mx-auto w-full max-w-3xl px-6 pb-24 md:px-10">
        {error && !payment ? (
          <UnavailableNotice title="Payment unavailable" detail={error} />
        ) : !payment ? (
          <div className="flex items-center justify-center gap-3 py-24 text-white/50">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-center justify-center gap-3 text-center">
              <StatusBadge status={payment.status} />
              <p className="text-[12px] text-white/45">
                {STATUS_PRESENTATION[payment.status].description}
              </p>
            </div>

            <div className="mb-8">
              <LifecycleRail status={payment.status} />
            </div>

            <ProofOfPayment payment={payment} explorer={EXPLORER} />

            {/* A plain-language restatement, for the reader who does not want to read hashes. */}
            <Surface className="mt-6 p-6">
              <SectionLabel>What this means</SectionLabel>
              <ul className="mt-4 space-y-2.5">
                <CheckItem>
                  The customer paid {payment.selectedAsset ?? "—"} on{" "}
                  {chainLabel(payment.selectedRoute?.sourceChain)}.
                </CheckItem>
                {payment.verification?.status === "verified" ? (
                  <CheckItem>
                    Flare&apos;s Data Connector independently attested that payment, and the
                    PaymentRegistry contract on Coston2 re-verified the proof before recording it.
                  </CheckItem>
                ) : (
                  <li className="flex items-start gap-2.5 text-[13px] leading-relaxed text-white/45">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white/25" />
                    <span>Verification has not completed yet.</span>
                  </li>
                )}
                {payment.settlement?.status === "completed" ? (
                  <CheckItem>
                    The merchant was settled in {payment.settlement.destinationAsset} on Coston2,
                    with a confirmed balance change.
                  </CheckItem>
                ) : (
                  <li className="flex items-start gap-2.5 text-[13px] leading-relaxed text-white/45">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white/25" />
                    <span>Settlement has not completed yet.</span>
                  </li>
                )}
              </ul>
              <p className="mt-5 text-[12px] leading-relaxed text-white/40">
                Every hash above links to a public block explorer. None of it depends on trusting
                PayFlux — read the registry contract directly if you prefer.
              </p>
            </Surface>

            <Surface className="mt-6 p-6">
              <SectionLabel>Audit trail</SectionLabel>
              <div className="mt-5">
                <EventTimeline events={events} payment={payment} explorer={EXPLORER} />
              </div>
            </Surface>

            <p className="mt-8 text-center text-[11px] text-white/30">
              <Link href="/" className="underline underline-offset-4 hover:text-white/60">
                PayFlux
              </Link>{" "}
              · Flare Coston2 and XRPL Testnet · testnet only
            </p>
          </>
        )}
      </main>
    </Shell>
  )
}
