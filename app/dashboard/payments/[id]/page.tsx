"use client"

import { use } from "react"
import Link from "next/link"
import { PageHeader } from "@/components/payflux/shell"
import {
  DataRow,
  Figure,
  GhostLink,
  HashLink,
  SectionLabel,
  StatusBadge,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { EventTimeline, LifecycleRail } from "@/components/payflux/lifecycle"
import { ProofOfPayment } from "@/components/payflux/proof-view"
import { usePaymentStream } from "@/lib/payflux/use-payment-stream"
import {
  chainLabel,
  formatAsset,
  formatFiat,
  SETTLEMENT_LABELS,
  STATUS_PRESENTATION,
  VERIFICATION_LABELS,
} from "@/lib/payflux/format"
import { Loading } from "@/components/payflux/dashboard-ui"

const EXPLORER = {
  flare: "https://coston2-explorer.flare.network",
  xrpl: "https://testnet.xrpl.org",
}

/**
 * Payment detail — the page a merchant opens when a customer says "did my payment go through?".
 *
 * Ordered so the answer comes first (status, proof chain), the story second (timeline), and the
 * raw material last (verification, settlement, quote, route).
 */
export default function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { payment, events, connected, error } = usePaymentStream(id)

  if (error && !payment) {
    return <UnavailableNotice title="Payment unavailable" detail={error} />
  }
  if (!payment) return <Loading label="Loading payment…" />

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={payment.orderId ?? "Payment"}
        title={payment.paymentReference}
        description={STATUS_PRESENTATION[payment.status].description}
        actions={
          <>
            <span className="hidden text-[10px] uppercase tracking-[0.14em] text-white/30 sm:inline">
              {connected ? "Live" : "Polling"}
            </span>
            <GhostLink href={`/status/${payment.id}`}>Public status</GhostLink>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-4">
        <StatusBadge status={payment.status} />
        <Figure className="text-2xl text-white">
          {formatFiat(payment.amount, payment.currency)}
        </Figure>
        {payment.selectedAsset ? (
          <span className="text-sm text-white/50">
            paid in {payment.selectedAsset} on {chainLabel(payment.selectedRoute?.sourceChain)}
          </span>
        ) : null}
      </div>

      <LifecycleRail status={payment.status} />

      {payment.failureDetail ? (
        <Surface className="border-[color:var(--pf-danger)]/30 bg-[color:var(--pf-danger)]/[0.07] p-5">
          <SectionLabel>Failure</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-white/80">{payment.failureDetail}</p>
          {payment.failureCode ? (
            <p className="mt-2 pf-hash text-white/40">{payment.failureCode}</p>
          ) : null}
        </Surface>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="space-y-6">
          <ProofOfPayment payment={payment} explorer={EXPLORER} />
        </div>

        <div className="space-y-6">
          <Surface className="p-6">
            <SectionLabel>Timeline</SectionLabel>
            <div className="mt-5">
              <EventTimeline events={events} payment={payment} explorer={EXPLORER} />
            </div>
          </Surface>

          {payment.reconciliation ? (
            <Surface className="p-6">
              <SectionLabel>Amount reconciliation</SectionLabel>
              <div className="mt-3 divide-y divide-white/[0.07]">
                <DataRow label="Expected">
                  {formatAsset(payment.reconciliation.expectedAmount)} {payment.reconciliation.asset}
                </DataRow>
                <DataRow label="Received (attested)">
                  {formatAsset(payment.reconciliation.receivedAmount)} {payment.reconciliation.asset}
                </DataRow>
                <DataRow label="Difference">
                  {formatAsset(payment.reconciliation.differenceAmount)} {payment.reconciliation.asset}
                </DataRow>
                <DataRow label="Tolerance applied">
                  {formatAsset(payment.reconciliation.toleranceApplied)} {payment.reconciliation.asset}
                </DataRow>
                <DataRow label="Outcome">
                  <span
                    className={
                      payment.reconciliation.outcome === "exact"
                        ? "text-[color:var(--pf-success)]"
                        : "text-[color:var(--pf-pending)]"
                    }
                  >
                    {payment.reconciliation.outcome}
                  </span>
                </DataRow>
              </div>
            </Surface>
          ) : null}

          {payment.quote ? (
            <Surface className="p-6">
              <SectionLabel>Quote</SectionLabel>
              <div className="mt-3 divide-y divide-white/[0.07]">
                <DataRow label="Quote ID">
                  <span className="pf-hash">{payment.quote.id}</span>
                </DataRow>
                <DataRow label="Rate">
                  {payment.quote.rate} {payment.quote.fiatCurrency} / {payment.quote.asset}
                </DataRow>
                <DataRow label="Asset amount">
                  {formatAsset(payment.quote.assetAmount)} {payment.quote.asset}
                </DataRow>
                <DataRow label="PayFlux fee">
                  {formatAsset(payment.quote.fee)} {payment.quote.asset}
                </DataRow>
                <DataRow label="Rate source">
                  <span className="text-[12px] text-white/60">
                    {payment.quote.rateSourceDetail ?? payment.quote.rateSource}
                  </span>
                </DataRow>
              </div>
            </Surface>
          ) : null}

          {payment.selectedRoute ? (
            <Surface className="p-6">
              <SectionLabel>Route</SectionLabel>
              <div className="mt-3 divide-y divide-white/[0.07]">
                <DataRow label="Route">
                  {payment.selectedRoute.sourceAsset} → {payment.selectedRoute.destinationAsset}
                </DataRow>
                <DataRow label="Verification">
                  {VERIFICATION_LABELS[payment.selectedRoute.verificationMethod] ??
                    payment.selectedRoute.verificationMethod}
                </DataRow>
                <DataRow label="Settlement">
                  {payment.selectedRoute.settlementMethod
                    ? (SETTLEMENT_LABELS[payment.selectedRoute.settlementMethod] ??
                      payment.selectedRoute.settlementMethod)
                    : "—"}
                </DataRow>
                <DataRow label="Router score">
                  {payment.selectedRoute.score ?? "—"}
                </DataRow>
                {payment.selectedRoute.priceImpact ? (
                  <DataRow label="Price impact">{payment.selectedRoute.priceImpact}</DataRow>
                ) : null}
              </div>
              {payment.selectedRoute.reasons.length > 0 ? (
                <ul className="mt-4 space-y-1.5 border-t border-white/10 pt-4">
                  {payment.selectedRoute.reasons.map((reason) => (
                    <li key={reason} className="text-[12px] leading-relaxed text-white/50">
                      · {reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Surface>
          ) : null}

          {payment.settlement ? (
            <Surface className="p-6">
              <SectionLabel>Settlement</SectionLabel>
              <div className="mt-3 divide-y divide-white/[0.07]">
                <DataRow label="Settlement ID">
                  <span className="pf-hash">{payment.settlement.id}</span>
                </DataRow>
                <DataRow label="Provider">{payment.settlement.provider ?? "—"}</DataRow>
                <DataRow label="Input">
                  {formatAsset(payment.settlement.inputAmount)} {payment.settlement.sourceAsset}
                </DataRow>
                <DataRow label="Output">
                  {formatAsset(payment.settlement.outputAmount)}{" "}
                  {payment.settlement.destinationAsset}
                </DataRow>
                <DataRow label="Status">{payment.settlement.status}</DataRow>
                <DataRow label="Transaction">
                  <HashLink
                    hash={payment.settlement.transactionHash}
                    href={payment.links.settlementTransaction}
                  />
                </DataRow>
              </div>
              {payment.settlement.failureDetail ? (
                <p className="mt-4 border-t border-white/10 pt-4 text-[12px] leading-relaxed text-[color:var(--pf-danger)]/90">
                  {payment.settlement.failureDetail}
                </p>
              ) : null}
            </Surface>
          ) : null}

          {payment.metadata && Object.keys(payment.metadata).length > 0 ? (
            <Surface className="p-6">
              <SectionLabel>Metadata</SectionLabel>
              <div className="mt-3 divide-y divide-white/[0.07]">
                {Object.entries(payment.metadata).map(([key, value]) => (
                  <DataRow key={key} label={key}>
                    {value}
                  </DataRow>
                ))}
              </div>
            </Surface>
          ) : null}
        </div>
      </div>

      <p className="text-[11px] text-white/30">
        <Link
          href="/dashboard/payments"
          className="underline underline-offset-4 hover:text-white/60"
        >
          Back to payments
        </Link>
      </p>
    </div>
  )
}
