import { randomUUID } from "node:crypto"
import type { Merchant, PaymentIntent, WebhookDelivery, WebhookEventType } from "../domain/types.js"
import { getStore } from "../store/index.js"
import { signWebhook, SIGNATURE_HEADER, REQUEST_ID_HEADER } from "./signer.js"

/**
 * Webhook delivery with bounded exponential-backoff retries.
 *
 * Deliveries are persisted before the first attempt, so a crash mid-flight leaves a record to
 * retry from rather than a silently dropped notification.
 */

const MAX_ATTEMPTS = 6
const BACKOFF_SECONDS = [5, 30, 120, 600, 3600]
const TIMEOUT_MS = 10_000

export function paymentEventPayload(
  event: WebhookEventType,
  payment: PaymentIntent,
): Record<string, unknown> {
  return {
    type: event,
    createdAt: new Date().toISOString(),
    paymentId: payment.id,
    orderId: payment.orderId,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    sourceAsset: payment.selectedAsset,
    sourceChain: payment.selectedRoute?.sourceChain,
    settlementAsset: payment.settlement?.destinationAsset ?? payment.preferredSettlementAsset,
    destinationChain: payment.selectedRoute?.destinationChain,
    paymentReference: payment.paymentReference,
    verification: payment.verification,
    settlement: payment.settlement,
    reconciliation: payment.reconciliation,
    failureCode: payment.failureCode,
    metadata: payment.metadata,
  }
}

export async function enqueue(
  merchant: Merchant,
  event: WebhookEventType,
  payment: PaymentIntent,
): Promise<WebhookDelivery | undefined> {
  if (!merchant.webhookUrl || !merchant.webhookSecret) return undefined

  const store = await getStore()
  const delivery: WebhookDelivery = {
    id: `whd_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    merchantId: merchant.id,
    event,
    paymentId: payment.id,
    url: merchant.webhookUrl,
    payload: paymentEventPayload(event, payment),
    attempts: 0,
    status: "pending",
    nextAttemptAt: new Date().toISOString(),
  }

  await store.saveWebhookDelivery(delivery)
  // Fire immediately; the sweeper handles anything that fails.
  void attempt(delivery, merchant.webhookSecret)
  return delivery
}

export async function attempt(
  delivery: WebhookDelivery,
  secret: string,
): Promise<WebhookDelivery> {
  const store = await getStore()
  const signed = signWebhook(delivery.payload, secret)
  const attempts = delivery.attempts + 1

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: signed.signature,
        [REQUEST_ID_HEADER]: delivery.id,
        "User-Agent": "PayFlux/0.1 (+https://payflux.dev)",
      },
      body: signed.body,
      signal: controller.signal,
    })

    if (response.ok) {
      const delivered: WebhookDelivery = {
        ...delivery,
        attempts,
        status: "delivered",
        deliveredAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        nextAttemptAt: undefined,
        lastError: undefined,
      }
      await store.saveWebhookDelivery(delivered)
      return delivered
    }

    return await scheduleRetry(delivery, attempts, `HTTP ${response.status}`)
  } catch (error) {
    return await scheduleRetry(
      delivery,
      attempts,
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    clearTimeout(timer)
  }
}

async function scheduleRetry(
  delivery: WebhookDelivery,
  attempts: number,
  reason: string,
): Promise<WebhookDelivery> {
  const store = await getStore()
  const exhausted = attempts >= MAX_ATTEMPTS
  const backoff = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]

  const updated: WebhookDelivery = {
    ...delivery,
    attempts,
    status: exhausted ? "failed" : "pending",
    lastAttemptAt: new Date().toISOString(),
    lastError: reason,
    nextAttemptAt: exhausted ? undefined : new Date(Date.now() + backoff * 1000).toISOString(),
  }

  await store.saveWebhookDelivery(updated)
  return updated
}

/** Periodic sweeper for deliveries whose backoff has elapsed. */
export function startWebhookSweeper(getSecret: (merchantId: string) => Promise<string | undefined>) {
  const timer = setInterval(async () => {
    try {
      const store = await getStore()
      const pending = await store.listPendingWebhookDeliveries(new Date())
      for (const delivery of pending) {
        const secret = await getSecret(delivery.merchantId)
        if (secret) await attempt(delivery, secret)
      }
    } catch (error) {
      console.error("[payflux] webhook sweeper error:", error)
    }
  }, 15_000)

  timer.unref?.()
  return () => clearInterval(timer)
}
