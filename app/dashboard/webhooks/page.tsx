"use client"

import { useEffect, useState } from "react"
import { PageHeader } from "@/components/payflux/shell"
import {
  DataRow,
  GhostButton,
  SectionLabel,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { merchantApi } from "@/lib/payflux/client"
import { timeAgo } from "@/lib/payflux/format"
import { Loading } from "@/components/payflux/dashboard-ui"
import { cn } from "@/lib/utils"

interface Delivery {
  id: string
  event: string
  paymentId: string
  status: "pending" | "delivered" | "failed"
  attempts: number
  lastAttemptAt?: string
  deliveredAt?: string
  lastError?: string
  nextAttemptAt?: string
}

const EVENTS = [
  "payment.created",
  "payment.detected",
  "payment.verifying",
  "payment.verified",
  "payment.settling",
  "payment.settled",
  "payment.failed",
  "payment.expired",
  "payment.partially_paid",
  "payment.overpaid",
  "settlement.completed",
  "settlement.failed",
]

export default function WebhooksPage() {
  const [data, setData] = useState<{
    endpoint?: string
    secretConfigured: boolean
    data: Delivery[]
  }>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | undefined>()

  const load = () => {
    setLoading(true)
    merchantApi
      .webhooks()
      .then((result) => setData(result as never))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const sendTest = async () => {
    setTesting(true)
    setTestResult(undefined)
    try {
      const response = await fetch("/api/merchant/webhooks/test", { method: "POST" })
      const body = await response.json()
      setTestResult(
        response.ok
          ? body.delivered
            ? `Delivered (HTTP ${body.httpStatus}).`
            : `Endpoint responded HTTP ${body.httpStatus}.`
          : (body.error?.message ?? "Test failed."),
      )
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
      load()
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Integration"
        title="Webhooks"
        description="Signed, retried notifications for every state change. The signature covers the timestamp and the raw body, so a captured payload cannot be replayed."
        actions={
          <GhostButton onClick={sendTest} disabled={testing}>
            {testing ? "Sending…" : "Send test event"}
          </GhostButton>
        }
      />

      {error ? (
        <UnavailableNotice title="Webhooks unavailable" detail={error} />
      ) : loading || !data ? (
        <Loading />
      ) : (
        <>
          <Surface className="p-6">
            <SectionLabel>Endpoint</SectionLabel>
            <div className="mt-3 divide-y divide-white/[0.07]">
              <DataRow label="URL">
                {data.endpoint ? (
                  <span className="pf-hash break-all">{data.endpoint}</span>
                ) : (
                  <span className="text-white/35">
                    Not configured — set MERCHANT_WEBHOOK_URL
                  </span>
                )}
              </DataRow>
              <DataRow label="Signing secret">
                {data.secretConfigured ? (
                  <span className="text-[color:var(--pf-success)]">Configured</span>
                ) : (
                  <span className="text-white/35">Not configured</span>
                )}
              </DataRow>
            </div>
            <p className="mt-4 text-[12px] leading-relaxed text-white/40">
              The secret is never returned by the API and never rendered here — only whether one
              exists.
            </p>
            {testResult ? (
              <p className="mt-4 text-[13px] text-white/70">{testResult}</p>
            ) : null}
          </Surface>

          <Surface className="p-6">
            <SectionLabel>Subscribed events</SectionLabel>
            <ul className="mt-4 flex flex-wrap gap-2">
              {EVENTS.map((event) => (
                <li
                  key={event}
                  className="rounded-full border border-white/12 bg-white/[0.03] px-3 py-1 pf-hash text-white/55"
                >
                  {event}
                </li>
              ))}
            </ul>
          </Surface>

          <section>
            <SectionLabel>Recent deliveries</SectionLabel>
            {data.data.length === 0 ? (
              <Surface className="mt-4 p-10 text-center">
                <p className="text-sm text-white/45">No deliveries yet.</p>
              </Surface>
            ) : (
              <Surface className="mt-4 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[44rem] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-white/10">
                        {["Event", "Payment", "Status", "Attempts", "Last attempt"].map((h) => (
                          <th
                            key={h}
                            className="px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.data.map((delivery) => (
                        <tr
                          key={delivery.id}
                          className="border-b border-white/[0.06] last:border-0"
                        >
                          <td className="px-5 py-3.5 pf-hash text-white/75">{delivery.event}</td>
                          <td className="px-5 py-3.5 pf-hash text-white/45">
                            {delivery.paymentId}
                          </td>
                          <td className="px-5 py-3.5">
                            <span
                              className={cn(
                                "rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                                delivery.status === "delivered" &&
                                  "border-[color:var(--pf-success)]/40 bg-[color:var(--pf-success)]/10 text-[color:var(--pf-success)]",
                                delivery.status === "pending" &&
                                  "border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/10 text-[color:var(--pf-pending)]",
                                delivery.status === "failed" &&
                                  "border-[color:var(--pf-danger)]/40 bg-[color:var(--pf-danger)]/10 text-[color:var(--pf-danger)]",
                              )}
                            >
                              {delivery.status}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-[12px] tabular-nums text-white/55">
                            {delivery.attempts}
                          </td>
                          <td className="px-5 py-3.5 text-[12px] text-white/45">
                            {timeAgo(delivery.lastAttemptAt)}
                            {delivery.lastError ? (
                              <p className="mt-0.5 text-[11px] text-[color:var(--pf-danger)]/80">
                                {delivery.lastError}
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Surface>
            )}
          </section>
        </>
      )}
    </div>
  )
}
