"use client"

import { useEffect, useRef, useState } from "react"
import { payfluxApi, streamUrl } from "./client"
import type { Payment, PaymentEvent } from "./types"

/**
 * Live payment state over SSE, with polling as the fallback.
 *
 * The important property: this hook never advances the payment itself. It renders whatever the
 * server last said. A stalled connection shows as stale, not as progress.
 */
export function usePaymentStream(paymentId: string | undefined) {
  const [payment, setPayment] = useState<Payment | undefined>()
  const [events, setEvents] = useState<PaymentEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const sourceRef = useRef<EventSource | undefined>(undefined)

  useEffect(() => {
    if (!paymentId) return

    let cancelled = false
    let pollTimer: ReturnType<typeof setInterval> | undefined

    const load = async () => {
      try {
        const [next, eventList] = await Promise.all([
          payfluxApi.getPayment(paymentId),
          payfluxApi.getEvents(paymentId).catch(() => ({ data: [] as PaymentEvent[] })),
        ])
        if (cancelled) return
        setPayment(next)
        setEvents(eventList.data)
        setError(undefined)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }

    void load()

    // EventSource cannot send headers, which is fine — the stream is a public read.
    try {
      const source = new EventSource(streamUrl(paymentId))
      sourceRef.current = source

      source.addEventListener("snapshot", (event) => {
        const data = JSON.parse((event as MessageEvent).data)
        setPayment(data.payment)
        setEvents(data.events ?? [])
        setConnected(true)
        setError(undefined)
      })

      source.addEventListener("update", (event) => {
        const data = JSON.parse((event as MessageEvent).data)
        setPayment(data.payment)
        if (data.event) {
          setEvents((current) =>
            current.some((e) => e.id === data.event.id) ? current : [...current, data.event],
          )
        }
      })

      source.onopen = () => setConnected(true)
      source.onerror = () => {
        setConnected(false)
        // Fall back to polling rather than showing a frozen page.
        if (!pollTimer) pollTimer = setInterval(load, 5_000)
      }
    } catch {
      pollTimer = setInterval(load, 5_000)
    }

    return () => {
      cancelled = true
      sourceRef.current?.close()
      if (pollTimer) clearInterval(pollTimer)
    }
  }, [paymentId])

  return { payment, events, connected, error, setPayment }
}
