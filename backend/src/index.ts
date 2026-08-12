import { createApp } from "./app.js"
import { capabilities, env, NETWORKS } from "./config/env.js"
import { assertCoston2 } from "./chain/provider.js"
import { getStore } from "./store/index.js"
import { startXrplWatcher } from "./watcher/xrpl.watcher.js"
import { startCoston2Watcher } from "./watcher/coston2.watcher.js"
import { startWebhookSweeper } from "./webhooks/dispatcher.js"
import { startExpirySweeper } from "./payments/payment.service.js"
import { findMatchingXrplPayment, startFdcFinalizationSweeper } from "./payments/verify.service.js"
import type { Merchant } from "./domain/types.js"

/**
 * Boot sequence.
 *
 * The server verifies it is really talking to Coston2 before accepting traffic, then prints a
 * capability report. Anything not configured is announced as UNAVAILABLE at startup rather than
 * failing mysteriously on the first request.
 */

const DEMO_MERCHANT_ID = "merchant_demo"

/**
 * Never let a stray rejection kill the API.
 *
 * Node's default is to exit on an unhandled rejection. In a payment system that means one
 * fire-and-forget write — an audit line, an idempotency record, a webhook attempt — can take the
 * process down mid-verification, stranding payments that were partway through an FDC round.
 *
 * Logging loudly and staying up is the right trade here. These are logged at error level
 * precisely so they get fixed rather than tolerated.
 */
function installCrashGuards() {
  process.on("unhandledRejection", (reason) => {
    console.error("[payflux] unhandled rejection (server kept running):", reason)
  })
  process.on("uncaughtException", (error) => {
    console.error("[payflux] uncaught exception (server kept running):", error)
  })
}

async function bootstrap() {
  installCrashGuards()
  await assertCoston2()

  const store = await getStore()

  const merchant: Merchant = {
    id: DEMO_MERCHANT_ID,
    name: "PayFlux Demo Merchant",
    settlementPreference: { asset: "FXRP", chain: "coston2" },
    xrplAddress: env.MERCHANT_XRPL_ADDRESS,
    flareAddress: env.MERCHANT_FLARE_ADDRESS,
    webhookUrl: env.MERCHANT_WEBHOOK_URL,
    webhookSecret: env.MERCHANT_WEBHOOK_SECRET,
  }
  await store.saveMerchant(merchant)

  const app = createApp()

  const server = app.listen(env.PORT, () => {
    printBanner()
  })

  // Watches every account's own address, not just this one — see the watcher modules.
  const stopWatcher = startXrplWatcher()
  const stopCoston2Watcher = startCoston2Watcher()
  // Completes payments whose FDC round has finalized — without this they stall in `verifying`.
  const stopFinalization = startFdcFinalizationSweeper()

  const stopWebhooks = startWebhookSweeper(async (merchantId) => {
    const record = await store.getMerchant(merchantId)
    return record?.webhookSecret
  })

  // Before expiring an intent, check the chain once more — a payment that landed in the last
  // few seconds must not be lost to our own clock. Uses the payment's *own* merchant, so an
  // account with its own XRPL address is checked against that address.
  const stopExpiry = startExpirySweeper(async (payment) => {
    const owner = await store.getMerchant(payment.merchantId)
    if (!owner?.xrplAddress) return false
    const tx = await findMatchingXrplPayment(payment, owner).catch(() => undefined)
    return Boolean(tx)
  })

  const shutdown = (signal: string) => {
    console.log(`\n[payflux] ${signal} received, shutting down.`)
    stopWatcher()
    stopCoston2Watcher()
    stopFinalization()
    stopWebhooks()
    stopExpiry()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

function printBanner() {
  const caps = capabilities()
  const line = (label: string, ok: boolean, note?: string) =>
    `  ${ok ? "OK        " : "UNAVAILABLE"} ${label}${note ? ` — ${note}` : ""}`

  console.log(`
PayFlux API listening on http://localhost:${env.PORT}
  Flare:  ${NETWORKS.flare.name} (chainId ${NETWORKS.flare.chainId})
  XRPL:   ${NETWORKS.xrpl.name}
  Mode:   ${caps.demoMode ? "DEMO — not for the verification demonstration" : "LIVE"}

Capabilities
${line("Coston2 RPC", caps.coston2Rpc)}
${line("Coston2 signer", caps.coston2Signer, caps.coston2Signer ? undefined : "set COSTON2_PRIVATE_KEY")}
${line("PaymentRegistry", caps.paymentRegistry, caps.paymentRegistry ? undefined : "deploy contracts and set PAYMENT_REGISTRY_ADDRESS")}
${line("FDC verifier", caps.fdcVerifier, caps.fdcVerifier ? undefined : "set FDC_VERIFIER_API_KEY")}
${line("FDC data availability", caps.fdcDataAvailability)}
${line("XRPL watcher", caps.xrplWatcher, caps.xrplWatcher ? undefined : "set MERCHANT_XRPL_ADDRESS")}
${line("FTSOv2 pricing", caps.ftsoPricing)}
${line("FAssets settlement", caps.fassetsSettlement, "live capacity is checked per request")}
${line("Firestore", caps.firestore, caps.firestore ? undefined : "using in-memory store")}
${line("Google sign-in", caps.googleSignIn, caps.googleSignIn ? undefined : "set FIREBASE_* to let developers sign in and manage their own API keys")}
`)
}

bootstrap().catch((error) => {
  console.error("[payflux] failed to start:", error)
  process.exit(1)
})
