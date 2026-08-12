import type { Merchant } from "../domain/types.js"
import { getStore } from "../store/index.js"
import { getIncomingPayments, decodeStandardPaymentReference } from "../verification/xrpl.payment.js"
import * as payments from "../payments/payment.service.js"
import * as verification from "../payments/verify.service.js"
import { startSweeper } from "../util/sweeper.js"
import { env } from "../config/env.js"

/**
 * Polls XRPL Testnet for payments carrying a PayFlux reference and kicks off verification.
 *
 * The watcher only ever *detects*. It never decides a payment is valid — that is FDC's job. Its
 * output is "there is a candidate transaction for intent X", which the verification pipeline then
 * has to prove.
 *
 * Because settlement addresses are per-account, this polls **every** distinct merchant address,
 * not just the deployment default. The address set is refreshed periodically so a developer who
 * sets their address in the dashboard starts being watched without a restart — otherwise
 * per-account addresses would be a setting that silently does nothing.
 *
 * Polling rather than subscribing keeps this resilient to reconnects at the cost of a few seconds
 * of latency, which is irrelevant next to the FDC round time.
 */

const POLL_INTERVAL_MS = 6_000
const MERCHANT_REFRESH_MS = 60_000
/** Bounded so one deployment with many accounts cannot melt the XRPL endpoint. */
const MAX_WATCHED_ADDRESSES = 25

export function startXrplWatcher() {
  // Transaction hashes already handed to the verifier, so a slow FDC round is not retried.
  const seen = new Set<string>()
  /** Addresses XRPL rejects outright — skipped until the merchant set is refreshed. */
  const unwatchable = new Set<string>()
  let watched: Merchant[] = []
  let lastRefresh = 0

  const refreshMerchants = async () => {
    const store = await getStore()
    const merchants = await store.listMerchants()

    // One address may back several accounts (they all inherit the deployment default). Poll it
    // once and resolve the owning account from the payment reference, not the address.
    const byAddress = new Map<string, Merchant>()
    for (const merchant of merchants) {
      if (merchant.xrplAddress && !byAddress.has(merchant.xrplAddress)) {
        byAddress.set(merchant.xrplAddress, merchant)
      }
    }

    watched = [...byAddress.values()].slice(0, MAX_WATCHED_ADDRESSES)
    lastRefresh = Date.now()
    // Give previously-bad addresses another chance in case one was corrected.
    unwatchable.clear()

    if (byAddress.size > MAX_WATCHED_ADDRESSES) {
      console.warn(
        `[payflux] ${byAddress.size} merchant XRPL addresses configured but only ` +
          `${MAX_WATCHED_ADDRESSES} are polled. Payments to the rest will not be detected ` +
          `automatically — they can still be verified via POST /v1/payments/:id/verify.`,
      )
    }
  }

  const tick = async () => {
    // Work found this pass, which keeps the loop at full speed. A watcher with nothing to see
    // is the normal state, and backing off there is the entire point.
    let detected = false

    {
      if (Date.now() - lastRefresh > MERCHANT_REFRESH_MS) {
        await refreshMerchants()
      }
      if (watched.length === 0) return false

      const store = await getStore()

      for (const merchant of watched) {
        if (unwatchable.has(merchant.xrplAddress!)) continue

        const incoming = await getIncomingPayments(merchant.xrplAddress!, 25).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          // A malformed address will never become valid. Retrying it every 6 seconds forever
          // buries real failures in noise, so drop it until the merchant set is refreshed.
          if (/malformed|actNotFound/i.test(message)) {
            unwatchable.add(merchant.xrplAddress!)
            console.warn(
              `[payflux] not watching ${merchant.xrplAddress} (${merchant.id}): ${message}`,
            )
          } else {
            console.error(`[payflux] XRPL poll failed for ${merchant.xrplAddress}:`, message)
          }
          return []
        })

        for (const tx of incoming) {
          if (seen.has(tx.hash) || !tx.successful || !tx.isXrp) continue
          if (!tx.standardPaymentReference) continue

          const reference = decodeStandardPaymentReference(tx.standardPaymentReference)
          if (!reference.startsWith("pay_")) continue

          const payment = await store.getPaymentByReference(reference)
          if (!payment) continue

          seen.add(tx.hash)
          detected = true

          if (!["created", "awaiting_payment", "partially_paid"].includes(payment.status)) continue

          // The reference decides which account owns this payment; the address only decides
          // where we looked. Verification uses the payment's own merchant.
          const owner = await store.getMerchant(payment.merchantId)
          if (!owner) continue

          await payments.recordEvent(payment.id, "payment.detected", "xrpl-watcher", {
            transactionHash: tx.hash,
            ledgerIndex: tx.ledgerIndex,
            deliveredDrops: tx.deliveredDrops.toString(),
            watchedAddress: merchant.xrplAddress,
          })

          void verification
            .verifyPayment(payment.id, owner, { transactionHashHint: tx.hash })
            .catch((error) => {
              console.error(`[payflux] verification failed for ${payment.id}:`, error)
            })
        }
      }

      return detected
    }
  }

  const stop = startSweeper({
    name: "XRPL watcher",
    intervalMs: POLL_INTERVAL_MS * env.PAYFLUX_POLL_SCALE,
    tick,
  })

  void refreshMerchants()
    .then(() =>
      console.log(
        `[payflux] XRPL watcher polling ${watched.length} address(es) every ` +
          `${(POLL_INTERVAL_MS * env.PAYFLUX_POLL_SCALE) / 1000}s when busy, ` +
          `refreshing the set every ${MERCHANT_REFRESH_MS / 1000}s`,
      ),
    )
    .catch((error) => console.error("[payflux] XRPL watcher failed to start:", error))

  return stop
}
