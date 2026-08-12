"use client"

import { use, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ChevronDown, Loader2, ShieldCheck } from "lucide-react"
import { Shell, BrandMark, NetworkPill } from "@/components/payflux/shell"
import {
  CopyButton,
  DataRow,
  Figure,
  GhostButton,
  HashLink,
  PrimaryButton,
  SectionLabel,
  StatusBadge,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { RouteCard } from "@/components/payflux/route-card"
import { LifecycleRail } from "@/components/payflux/lifecycle"
import { payfluxApi, ApiUnreachableError } from "@/lib/payflux/client"
import { usePaymentStream } from "@/lib/payflux/use-payment-stream"
import {
  STATUS_PRESENTATION,
  chainLabel,
  countdown,
  formatAsset,
  formatFiat,
} from "@/lib/payflux/format"
import type { PaymentRoute } from "@/lib/payflux/types"

/**
 * Checkout.
 *
 * The design brief pulls two ways: keep the brand's bold violet-and-glow identity, but make the
 * payment itself feel like fintech infrastructure. The resolution here is to keep the palette and
 * the display type, and spend the restraint on information: one decision per screen, the chain
 * details folded behind "Technical details", and the coral glow reserved for the single primary
 * action.
 */
export default function CheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { payment, connected, error } = usePaymentStream(id)

  const [routes, setRoutes] = useState<PaymentRoute[]>([])
  const [recommended, setRecommended] = useState<string | undefined>()
  const [routesLoading, setRoutesLoading] = useState(true)
  const [routesError, setRoutesError] = useState<string | undefined>()
  const [selecting, setSelecting] = useState<string | undefined>()
  const [selectError, setSelectError] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    payfluxApi
      .getRoutes(id)
      .then((result) => {
        if (cancelled) return
        setRoutes(result.data)
        setRecommended(result.recommended)
      })
      .catch((err) => {
        if (!cancelled) setRoutesError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => !cancelled && setRoutesLoading(false))
    return () => {
      cancelled = true
    }
  }, [id])

  const chooseAsset = async (route: PaymentRoute) => {
    setSelecting(route.sourceAsset)
    setSelectError(undefined)
    try {
      await payfluxApi.selectAsset(id, route.sourceAsset)
    } catch (err) {
      setSelectError(err instanceof Error ? err.message : String(err))
    } finally {
      setSelecting(undefined)
    }
  }

  if (error && !payment) {
    return (
      <CheckoutFrame>
        <UnavailableNotice
          title={error.includes("could not be reached") ? "API unreachable" : "Payment unavailable"}
          detail={error}
        />
      </CheckoutFrame>
    )
  }

  if (!payment) {
    return (
      <CheckoutFrame>
        <div className="flex items-center justify-center gap-3 py-24 text-white/50">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading payment…</span>
        </div>
      </CheckoutFrame>
    )
  }

  const awaitingSelection = payment.status === "created"
  const instructions = payment.paymentInstructions

  return (
    <CheckoutFrame>
      {/* ------------------------------------------------------------ amount */}
      <div className="mb-8 text-center">
        <SectionLabel>Pay</SectionLabel>
        <Figure className="mt-3 block text-5xl text-white md:text-6xl">
          {formatFiat(payment.amount, payment.currency)}
        </Figure>
        {payment.orderId ? (
          <p className="mt-3 text-[11px] uppercase tracking-[0.16em] text-white/40">
            Order {payment.orderId}
          </p>
        ) : null}
      </div>

      <div className="mb-8">
        <LifecycleRail status={payment.status} />
      </div>

      <div className="mb-8 flex flex-wrap items-center justify-center gap-3">
        <StatusBadge status={payment.status} />
        <span className="text-[11px] text-white/40">
          {STATUS_PRESENTATION[payment.status].description}
        </span>
      </div>

      {/* --------------------------------------------------- choose an asset */}
      {awaitingSelection ? (
        <section>
          <div className="mb-5 flex items-baseline justify-between">
            <h2 className="font-display text-sm uppercase tracking-[0.14em] text-white/80">
              Choose how to pay
            </h2>
            <ExpiryCountdown expiresAt={payment.expiresAt} />
          </div>

          {routesLoading ? (
            <div className="flex items-center gap-3 py-12 text-white/45">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Checking live routes, prices and settlement capacity…</span>
            </div>
          ) : routesError ? (
            <UnavailableNotice title="Routes unavailable" detail={routesError} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {routes.map((route) => (
                <RouteCard
                  key={route.id}
                  route={route}
                  recommended={route.id === recommended}
                  disabled={Boolean(selecting)}
                  onSelect={chooseAsset}
                />
              ))}
            </div>
          )}

          {selecting ? (
            <p className="mt-5 flex items-center justify-center gap-2 text-sm text-white/55">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Locking a quote and committing the intent on Coston2…
            </p>
          ) : null}

          {selectError ? (
            <p className="mt-5 rounded-xl border border-[color:var(--pf-danger)]/40 bg-[color:var(--pf-danger)]/10 px-4 py-3 text-sm text-white/85">
              {selectError}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ------------------------------------------------------ send payment */}
      {instructions && payment.status === "awaiting_payment" ? (
        <PaymentInstructionsPanel
          instructions={instructions}
          reference={payment.paymentReference}
          expiresAt={payment.quote?.expiresAt ?? payment.expiresAt}
          onVerify={() => payfluxApi.verify(payment.id)}
        />
      ) : null}

      {/* ------------------------------------------------------- in progress */}
      {["payment_detected", "verifying", "settling"].includes(payment.status) ? (
        <Surface className="p-7 text-center">
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-[color:var(--pf-coral)]" />
          <p className="font-display mt-4 text-base tracking-[0.06em] text-white">
            {payment.status === "verifying" ? "FLARE IS VERIFYING YOUR PAYMENT" : "WORKING"}
          </p>
          <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-white/55">
            {payment.status === "verifying"
              ? "An attestation request is in a Flare voting round. This genuinely takes a few minutes — attestation providers have to observe XRPL and agree before a proof exists."
              : STATUS_PRESENTATION[payment.status].description}
          </p>
          {payment.verification?.votingRound ? (
            <p className="mt-4 text-[11px] uppercase tracking-[0.14em] text-white/35">
              Voting round {payment.verification.votingRound}
            </p>
          ) : null}
        </Surface>
      ) : null}

      {/* --------------------------------------------------------- succeeded */}
      {["verified", "settled", "overpaid"].includes(payment.status) ? (
        <Surface className="border-[color:var(--pf-success)]/30 bg-[color:var(--pf-success)]/[0.07] p-7 text-center">
          <ShieldCheck className="mx-auto h-6 w-6 text-[color:var(--pf-success)]" />
          <p className="font-display mt-4 text-lg tracking-[0.08em] text-white">
            {payment.status === "settled" ? "PAYMENT SETTLED" : "PAYMENT VERIFIED"}
          </p>
          <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-white/60">
            {payment.status === "settled"
              ? "Flare verified your payment and the merchant has been settled."
              : "Flare independently verified your payment. Settlement is in progress."}
          </p>
          <Link
            href={`/status/${payment.id}`}
            className="mt-6 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-white underline decoration-white/30 underline-offset-8 transition-colors hover:text-[color:var(--pf-coral)]"
          >
            View proof of payment
          </Link>
        </Surface>
      ) : null}

      {/* ------------------------------------------------------------ failed */}
      {["failed", "expired", "partially_paid"].includes(payment.status) ? (
        <Surface className="border-[color:var(--pf-danger)]/30 bg-[color:var(--pf-danger)]/[0.07] p-7">
          <p className="font-display text-base tracking-[0.06em] text-white">
            {STATUS_PRESENTATION[payment.status].label.toUpperCase()}
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-white/70">
            {payment.failureDetail ?? STATUS_PRESENTATION[payment.status].description}
          </p>
          {payment.reconciliation && payment.status === "partially_paid" ? (
            <div className="mt-5 divide-y divide-white/10 border-t border-white/10">
              <DataRow label="Expected">
                {formatAsset(payment.reconciliation.expectedAmount)} {payment.reconciliation.asset}
              </DataRow>
              <DataRow label="Received">
                {formatAsset(payment.reconciliation.receivedAmount)} {payment.reconciliation.asset}
              </DataRow>
              <DataRow label="Still outstanding">
                <span className="text-[color:var(--pf-pending)]">
                  {formatAsset(payment.reconciliation.differenceAmount)}{" "}
                  {payment.reconciliation.asset}
                </span>
              </DataRow>
            </div>
          ) : null}
          {payment.failureCode ? (
            <p className="mt-4 pf-hash text-white/35">{payment.failureCode}</p>
          ) : null}
        </Surface>
      ) : null}

      {/* -------------------------------------------- progressive disclosure */}
      <TechnicalDetails payment={payment} connected={connected} />
    </CheckoutFrame>
  )
}

// ---------------------------------------------------------------------------

function CheckoutFrame({ children }: { children: React.ReactNode }) {
  return (
    <Shell ambient={false} deep>
      <header className="flex items-center justify-between px-6 py-6 md:px-10">
        <BrandMark subtitle="Checkout" />
        <NetworkPill />
      </header>
      <main className="mx-auto w-full max-w-3xl px-6 pb-24 pt-6 md:px-10">{children}</main>
    </Shell>
  )
}

function ExpiryCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const remaining = new Date(expiresAt).getTime() - now
  return (
    <span
      className={
        remaining < 120_000
          ? "text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--pf-danger)]"
          : "text-[11px] font-semibold uppercase tracking-[0.14em] text-white/40"
      }
    >
      Expires in {countdown(expiresAt, now)}
    </span>
  )
}

function PaymentInstructionsPanel({
  instructions,
  reference,
  expiresAt,
  onVerify,
}: {
  instructions: NonNullable<import("@/lib/payflux/types").Payment["paymentInstructions"]>
  reference: string
  expiresAt: string
  onVerify: () => Promise<unknown>
}) {
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | undefined>()

  const isXrpl = instructions.chain === "xrpl-testnet"

  return (
    <Surface strong className="p-6 md:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-sm uppercase tracking-[0.14em] text-white/85">
          Send {instructions.asset}
        </h2>
        <ExpiryCountdown expiresAt={expiresAt} />
      </div>

      <div className="mt-5 space-y-3">
        <Field label="Amount">
          <span className="flex items-baseline gap-2">
            <Figure className="text-xl text-white">{formatAsset(instructions.amount)}</Figure>
            <span className="text-[11px] uppercase tracking-[0.14em] text-white/45">
              {instructions.amountUnit}
            </span>
          </span>
          <CopyButton value={instructions.amount} />
        </Field>

        <Field label={isXrpl ? "Destination address" : "Recipient"}>
          <span className="pf-hash break-all text-white/85">{instructions.destinationAddress}</span>
          <CopyButton value={instructions.destinationAddress} />
        </Field>

        {isXrpl && instructions.memoDataHex ? (
          <Field label="Memo (hex) — required">
            <span className="pf-hash break-all text-white/85">{instructions.memoDataHex}</span>
            <CopyButton value={instructions.memoDataHex} />
          </Field>
        ) : null}
      </div>

      {isXrpl ? (
        <p className="mt-4 text-[12px] leading-relaxed text-white/50">
          The memo encodes reference{" "}
          <span className="text-white/80">{reference}</span>. It is how Flare binds your transfer to
          this order — without it the payment cannot be matched, whoever sent it.
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <PrimaryButton
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            setMessage(undefined)
            try {
              const result = (await onVerify()) as { status: string; detail?: string }
              setMessage(
                result.status === "no_payment_found"
                  ? (result.detail ?? "No matching payment found yet.")
                  : "Payment found — verification started.",
              )
            } catch (err) {
              setMessage(err instanceof Error ? err.message : String(err))
            } finally {
              setChecking(false)
            }
          }}
        >
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          I&apos;ve sent it
        </PrimaryButton>
        <p className="text-[12px] text-white/40">
          PayFlux is also watching the chain — you don&apos;t have to click.
        </p>
      </div>

      {message ? <p className="mt-4 text-[13px] text-white/65">{message}</p> : null}
    </Surface>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/12 bg-black/15 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/35">{label}</p>
      <div className="mt-1.5 flex items-start justify-between gap-3">{children}</div>
    </div>
  )
}

/**
 * Everything a developer or a judge wants, and a customer never has to see (master prompt §59).
 */
function TechnicalDetails({
  payment,
  connected,
}: {
  payment: import("@/lib/payflux/types").Payment
  connected: boolean
}) {
  const [open, setOpen] = useState(false)

  const rows = useMemo(
    () =>
      [
        ["Payment ID", payment.id],
        ["Reference", payment.paymentReference],
        ["Status", payment.status],
        ["Source chain", chainLabel(payment.selectedRoute?.sourceChain)],
        ["Verification", payment.verification?.method ?? "—"],
        ["Quote rate", payment.quote ? `${payment.quote.rate} ${payment.quote.fiatCurrency}` : "—"],
        ["Rate source", payment.quote?.rateSourceDetail ?? "—"],
        ["Voting round", payment.verification?.votingRound?.toString() ?? "—"],
        ["Live connection", connected ? "SSE connected" : "Polling"],
      ] as Array<[string, string]>,
    [payment, connected],
  )

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-white/50 transition-colors hover:border-white/20 hover:text-white/80 hover:shadow-none"
      >
        View technical details
        <ChevronDown
          className={`h-4 w-4 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <Surface className="mt-3 p-5">
          <div className="divide-y divide-white/[0.07]">
            {rows.map(([label, value]) => (
              <DataRow key={label} label={label}>
                <span className="pf-hash break-all">{value}</span>
              </DataRow>
            ))}
            <DataRow label="XRPL transaction">
              <HashLink
                hash={payment.verification?.sourceTransactionId}
                href={payment.links.sourceTransaction}
              />
            </DataRow>
            <DataRow label="Coston2 verification">
              <HashLink
                hash={payment.verification?.coston2TransactionHash}
                href={payment.links.verificationTransaction}
              />
            </DataRow>
            <DataRow label="Settlement">
              <HashLink
                hash={payment.settlement?.transactionHash}
                href={payment.links.settlementTransaction}
              />
            </DataRow>
          </div>
        </Surface>
      ) : null}
    </div>
  )
}
