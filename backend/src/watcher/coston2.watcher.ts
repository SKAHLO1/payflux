import type { Merchant, PaymentIntent } from "../domain/types.js"
import { getStore } from "../store/index.js"
import * as coston2 from "../verification/coston2.payment.js"
import * as payments from "../payments/payment.service.js"
import { verifyNativePayment } from "../payments/verify.service.js"

/**
 * Watches Coston2 for FXRP and C2FLR payments to merchant addresses.
 *
 * The counterpart to the XRPL watcher, and it follows the same rule: it only ever *detects*. The
 * decision that a payment is valid is made by `verifyNativePayment`, which re-reads the
 * transaction from the chain and records it on PaymentRegistry.
 *
 * Two differences from the XRPL side:
 *
 *   - Scanning is incremental. Native transfers have no logs, so they require walking blocks;
 *     tracking the last scanned block keeps each poll proportional to elapsed time rather than to
 *     the window length.
 *   - It only runs when there is something to find. With no open native intents there is nothing
 *     a scan could match, so it skips entirely rather than burning RPC calls on every tick.
 */

const POLL_INTERVAL_MS = 8_000
const MERCHANT_REFRESH_MS = 60_000
/** Cold-start lookback. Roughly the default payment window at ~1.8s blocks. */
const INITIAL_LOOKBACK_BLOCKS = 600
const MAX_WATCHED_ADDRESSES = 25

const OPEN_STATUSES = ["created", "awaiting_payment", "payment_detected", "partially_paid"]

export function startCoston2Watcher() {
  let watched: Merchant[] = []
  let lastRefresh = 0
  let lastScannedBlock = 0
  let running = false
  const handled = new Set<string>()

  const refreshMerchants = async () => {
    const store = await getStore()
    const merchants = await store.listMerchants()

    const byAddress = new Map<string, Merchant>()
    for (const merchant of merchants) {
      if (merchant.flareAddress && !byAddress.has(merchant.flareAddress.toLowerCase())) {
        byAddress.set(merchant.flareAddress.toLowerCase(), merchant)
      }
    }
    watched = [...byAddress.values()].slice(0, MAX_WATCHED_ADDRESSES)
    lastRefresh = Date.now()

    if (byAddress.size > MAX_WATCHED_ADDRESSES) {
      console.warn(
        `[payflux] ${byAddress.size} merchant Coston2 addresses configured but only ` +
          `${MAX_WATCHED_ADDRESSES} are polled. The rest can still be verified by submitting a ` +
          `transaction hash to POST /v1/payments/:id/verify.`,
      )
    }
  }

  const openNativePayments = async (): Promise<PaymentIntent[]> => {
    const store = await getStore()
    const all: PaymentIntent[] = []
    for (const merchant of watched) {
      const list = await store.listPayments(merchant.id, 100)
      all.push(
        ...list.filter(
          (payment) =>
            OPEN_STATUSES.includes(payment.status) &&
            ["FXRP", "C2FLR"].includes(payment.selectedAsset?.toUpperCase() ?? ""),
        ),
      )
    }
    return all
  }

  const tick = async () => {
    if (running) return
    running = true
    try {
      if (Date.now() - lastRefresh > MERCHANT_REFRESH_MS) await refreshMerchants()
      if (watched.length === 0) return

      const open = await openNativePayments()
      if (open.length === 0) {
        // Nothing to match. Keep the cursor current so the next real intent does not trigger a
        // huge catch-up scan.
        lastScannedBlock = await coston2.currentBlock()
        return
      }

      const head = await coston2.currentBlock()
      if (lastScannedBlock === 0) lastScannedBlock = Math.max(0, head - INITIAL_LOOKBACK_BLOCKS)
      if (head <= lastScannedBlock) return

      const store = await getStore()

      for (const payment of open) {
        if (handled.has(payment.id)) continue

        const merchant = await store.getMerchant(payment.merchantId)
        if (!merchant?.flareAddress) continue

        const asset = payment.selectedAsset!.toUpperCase() as "FXRP" | "C2FLR"

        // verifyNativePayment does its own scan and matching; the watcher's job is only to
        // decide it is worth asking. Duplicating the match here would be a second source of
        // truth for the same question.
        const outcome = await verifyNativePayment(payment.id, merchant, asset).catch((error) => {
          console.error(`[payflux] native verification failed for ${payment.id}:`, error)
          return undefined
        })

        if (outcome && outcome.status !== "no_payment_found") {
          handled.add(payment.id)
        }
      }

      lastScannedBlock = head
    } catch (error) {
      console.error("[payflux] Coston2 watcher error:", error)
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, POLL_INTERVAL_MS)
  timer.unref?.()

  void refreshMerchants()
    .then(() => {
      console.log(
        `[payflux] Coston2 watcher polling ${watched.length} address(es) every ` +
          `${POLL_INTERVAL_MS / 1000}s for FXRP and C2FLR payments`,
      )
      return tick()
    })
    .catch((error) => console.error("[payflux] Coston2 watcher failed to start:", error))

  return () => clearInterval(timer)
}
