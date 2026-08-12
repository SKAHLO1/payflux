"use client"

import { ArrowDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { chainLabel, formatAsset, formatFiat } from "@/lib/payflux/format"
import type { Payment } from "@/lib/payflux/types"
import { DataRow, Figure, HashLink, SectionLabel, Surface } from "./primitives"

/**
 * Proof of Payment — the visual centrepiece.
 *
 * One vertical chain of custody from the source transaction to the merchant's balance, where
 * every step carries the hash that proves it. A stage with no hash is drawn as *not yet proven*
 * rather than omitted, so the diagram can never imply more than actually happened.
 */
export function ProofOfPayment({
  payment,
  explorer,
}: {
  payment: Payment
  explorer: { flare: string; xrpl: string }
}) {
  const verification = payment.verification
  const settlement = payment.settlement
  const isXrpl = verification?.method === "fdc-payment"

  return (
    <Surface strong className="overflow-hidden">
      <div className="border-b border-white/10 px-6 py-6 text-center md:px-10">
        <SectionLabel>PayFlux payment</SectionLabel>
        <Figure className="mt-3 block text-4xl text-white md:text-5xl">
          {formatFiat(payment.amount, payment.currency)}
        </Figure>
        <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-white/40">
          Reference {payment.paymentReference}
        </p>
      </div>

      <div className="space-y-0 px-6 py-8 md:px-10">
        <ProofStage
          label="Source"
          title={payment.selectedAsset ?? "—"}
          subtitle={chainLabel(payment.selectedRoute?.sourceChain)}
          proven={Boolean(verification?.sourceTransactionId)}
          rows={[
            {
              label: "Source transaction",
              value: (
                <HashLink
                  hash={verification?.sourceTransactionId}
                  href={payment.links.sourceTransaction}
                  label="XRPL transaction"
                />
              ),
            },
            {
              label: "Amount sent",
              value: payment.reconciliation
                ? `${formatAsset(payment.reconciliation.receivedAmount)} ${payment.reconciliation.asset}`
                : formatAsset(payment.selectedRoute?.estimatedInputAmount),
            },
          ]}
        />

        <Connector />

        <ProofStage
          label="Verification"
          title={isXrpl ? "Flare Data Connector" : "Native on Coston2"}
          subtitle={
            isXrpl
              ? `${verification?.attestationType ?? "Payment"} attestation · testXRP`
              : "Final on arrival — no external attestation required"
          }
          proven={verification?.status === "verified"}
          rows={
            isXrpl
              ? [
                  { label: "FDC request", value: <HashLink hash={verification?.fdcRequestId} /> },
                  {
                    label: "Voting round",
                    value: verification?.votingRound ? String(verification.votingRound) : "—",
                  },
                  {
                    label: "Attested amount",
                    value: verification?.attestedAmount
                      ? `${verification.attestedAmount} drops`
                      : "—",
                  },
                ]
              : []
          }
        />

        <Connector />

        <ProofStage
          label="Recorded on Flare"
          title="PaymentRegistry"
          subtitle="Coston2 · the contract re-verifies the proof before writing"
          proven={Boolean(verification?.coston2TransactionHash)}
          rows={[
            {
              label: "Verification transaction",
              value: (
                <HashLink
                  hash={verification?.coston2TransactionHash}
                  href={payment.links.verificationTransaction}
                  label="Coston2 transaction"
                />
              ),
            },
            {
              label: "Registry contract",
              value: (
                <HashLink
                  hash={verification?.registryAddress}
                  href={payment.links.registry}
                  label="PaymentRegistry"
                />
              ),
            },
            {
              label: "Intent commitment",
              value: (
                <HashLink
                  hash={payment.onChainIntentTransactionHash}
                  href={payment.links.intentTransaction}
                  label="Intent commitment"
                />
              ),
            },
          ]}
        />

        <Connector />

        <ProofStage
          label="Settlement"
          title={settlement?.destinationAsset ?? payment.preferredSettlementAsset ?? "—"}
          subtitle={
            settlement
              ? `${settlement.provider ?? "—"} · ${chainLabel(settlement.destinationChain)}`
              : "Not settled yet"
          }
          proven={settlement?.status === "completed"}
          rows={[
            {
              label: "Settlement transaction",
              value: (
                <HashLink
                  hash={settlement?.transactionHash}
                  href={payment.links.settlementTransaction}
                  label="Settlement transaction"
                />
              ),
            },
            {
              label: "Delivered",
              value: settlement
                ? `${formatAsset(settlement.outputAmount)} ${settlement.destinationAsset}`
                : "—",
            },
          ]}
        />

        <Connector />

        <div
          className={cn(
            "rounded-xl border px-5 py-5 text-center",
            payment.status === "settled"
              ? "border-[color:var(--pf-success)]/40 bg-[color:var(--pf-success)]/10"
              : "border-white/12 bg-white/[0.03]",
          )}
        >
          <SectionLabel>Merchant</SectionLabel>
          <p
            className={cn(
              "font-display mt-2 text-xl tracking-[0.14em]",
              payment.status === "settled"
                ? "text-[color:var(--pf-success)]"
                : "text-white/50",
            )}
          >
            {payment.status === "settled" ? "SETTLED ✓" : payment.status.replace(/_/g, " ").toUpperCase()}
          </p>
        </div>
      </div>
    </Surface>
  )
}

function Connector() {
  return (
    <div className="flex justify-center py-1.5" aria-hidden>
      <ArrowDown className="h-4 w-4 text-white/20" />
    </div>
  )
}

function ProofStage({
  label,
  title,
  subtitle,
  proven,
  rows,
}: {
  label: string
  title: string
  subtitle: string
  proven: boolean
  rows: Array<{ label: string; value: React.ReactNode }>
}) {
  return (
    <div
      className={cn(
        "rounded-xl border px-5 py-4",
        proven
          ? "border-white/15 bg-white/[0.05]"
          : "border-dashed border-white/12 bg-transparent",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        {!proven ? (
          <span className="text-[10px] uppercase tracking-[0.14em] text-white/30">
            Not yet proven
          </span>
        ) : null}
      </div>
      <p className="font-display mt-1.5 text-lg tracking-[0.06em] text-white">{title}</p>
      <p className="mt-0.5 text-[12px] leading-relaxed text-white/45">{subtitle}</p>

      {rows.length > 0 ? (
        <div className="mt-3 divide-y divide-white/[0.07] border-t border-white/[0.07]">
          {rows.map((row) => (
            <DataRow key={row.label} label={row.label}>
              {row.value}
            </DataRow>
          ))}
        </div>
      ) : null}
    </div>
  )
}
