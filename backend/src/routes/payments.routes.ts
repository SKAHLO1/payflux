import { Router } from "express"
import { z } from "zod"
import {
  asyncHandler,
  authenticate,
  authenticateSessionOrKey,
  idempotency,
  optionalAuth,
  requireScope,
  validate,
} from "../middleware/index.js"
import * as payments from "../payments/payment.service.js"
import * as verification from "../payments/verify.service.js"
import * as settlements from "../settlement/settlement.service.js"
import { getStore } from "../store/index.js"
import { buildMemo } from "../verification/xrpl.payment.js"
import { encodeReferenceCalldata } from "../verification/coston2.payment.js"
import { paymentBus } from "../events/bus.js"
import { NETWORKS } from "../config/env.js"
import type { PaymentIntent } from "../domain/types.js"

export const paymentsRouter = Router()

const createSchema = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "amount must be a decimal string with at most 2 decimal places"),
  currency: z.string().length(3).default("USD"),
  acceptedAssets: z.array(z.string().min(2).max(12)).min(1).max(8),
  settlementAsset: z.string().min(2).max(12).optional(),
  orderId: z.string().max(128).optional(),
  metadata: z.record(z.string(), z.string().max(512)).optional(),
  expiresInSeconds: z.number().int().min(60).max(86_400).optional(),
})

// Note: there is deliberately no `status` field anywhere in this schema. The API offers no way
// for a client to move a payment's state (master prompt §7).

paymentsRouter.post(
  "/",
  authenticate,
  requireScope("payments:write"),
  idempotency(),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const payment = await payments.createPayment({
      merchantId: req.merchantId!,
      ...req.body,
    })
    res.status(201).json(serializePayment(payment))
  }),
)

paymentsRouter.get(
  "/",
  authenticateSessionOrKey("payments:read"),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200)
    const list = await payments.listPayments(req.merchantId!, limit)
    res.json({ data: list.map(serializePayment), hasMore: list.length === limit })
  }),
)

paymentsRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const payment = await payments.getPayment(req.params.id)
    // Public reads (the customer's status page) get the same object; nothing here is secret.
    res.json(serializePayment(payment))
  }),
)

paymentsRouter.get(
  "/:id/events",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const events = await payments.listEvents(req.params.id)
    res.json({ data: events })
  }),
)

paymentsRouter.get(
  "/:id/routes",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const payment = await payments.getPayment(req.params.id)
    const store = await getStore()
    const merchant = await store.getMerchant(payment.merchantId)
    if (!merchant) {
      return res.status(404).json({ error: { code: "MERCHANT_NOT_FOUND", message: "Unknown merchant." } })
    }

    const routes = await payments.getRoutes(payment, merchant)
    res.json({
      data: routes,
      recommended: routes.find((r) => r.status === "available")?.id,
    })
  }),
)

const selectSchema = z.object({ asset: z.string().min(2).max(12) })

/** Customer-facing: choosing how to pay. Public, because the checkout page is public. */
paymentsRouter.post(
  "/:id/select-asset",
  validate(selectSchema),
  asyncHandler(async (req, res) => {
    const payment = await payments.getPayment(req.params.id)
    const store = await getStore()
    const merchant = await store.getMerchant(payment.merchantId)
    if (!merchant) {
      return res.status(404).json({ error: { code: "MERCHANT_NOT_FOUND", message: "Unknown merchant." } })
    }
    const updated = await payments.selectAsset(payment.id, req.body.asset, merchant)
    res.json(serializePayment(updated))
  }),
)

const verifySchema = z.object({
  // Explicitly named a hint. The backend re-derives everything from the chain regardless.
  transactionHashHint: z.string().min(16).max(80).optional(),
})

paymentsRouter.post(
  "/:id/verify",
  validate(verifySchema),
  asyncHandler(async (req, res) => {
    const payment = await payments.getPayment(req.params.id)
    const store = await getStore()
    const merchant = await store.getMerchant(payment.merchantId)
    if (!merchant) {
      return res.status(404).json({ error: { code: "MERCHANT_NOT_FOUND", message: "Unknown merchant." } })
    }

    const outcome = await verification.verifyPayment(payment.id, merchant, {
      transactionHashHint: req.body.transactionHashHint,
      waitForFinalization: false,
    })

    res.status(outcome.status === "failed" ? 409 : 202).json({
      status: outcome.status,
      detail: outcome.detail,
      payment: serializePayment(outcome.payment),
    })
  }),
)

paymentsRouter.post(
  "/:id/settle",
  authenticate,
  requireScope("settlements:write"),
  asyncHandler(async (req, res) => {
    const payment = await payments.getPayment(req.params.id)
    const store = await getStore()
    const merchant = await store.getMerchant(payment.merchantId)
    if (!merchant) {
      return res.status(404).json({ error: { code: "MERCHANT_NOT_FOUND", message: "Unknown merchant." } })
    }
    const settlement = await settlements.executeSettlement({ payment, merchant })
    res.json({ data: settlement })
  }),
)

/** Server-sent events (master prompt §45). */
paymentsRouter.get("/:id/stream", async (req, res) => {
  const paymentId = req.params.id

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  try {
    const payment = await payments.getPayment(paymentId)
    send("snapshot", {
      payment: serializePayment(payment),
      events: await payments.listEvents(paymentId),
    })
  } catch {
    send("error", { message: `Payment ${paymentId} not found` })
    return res.end()
  }

  const unsubscribe = paymentBus.subscribe(paymentId, (update) => {
    send("update", {
      payment: serializePayment(update.payment),
      event: update.event,
    })
  })

  // Proxies drop idle connections; a comment frame keeps the stream alive without being an event.
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 20_000)

  req.on("close", () => {
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  })
})

/**
 * Adds the derived, presentation-oriented fields the UI needs, so the checkout and dashboard do
 * not have to re-implement encoding rules or explorer URL formats.
 */
export function serializePayment(payment: PaymentIntent) {
  const route = payment.selectedRoute
  // The finalization claim is internal bookkeeping. It says which worker is mid-write, which is
  // no part of the payment's public shape and would only invite clients to poll on it.
  const { processingClaim: _internal, ...publicFields } = payment

  /*
   * The memo the customer must attach.
   *
   * With an FAssets reservation the AssetManager dictates the reference, and only that value
   * will mint. Falling back to the PayFlux reference here would send the customer away with a
   * memo that verifies but can never be minted — the payment would succeed and the settlement
   * would be impossible.
   */
  const memoDataHex =
    payment.selectedAsset === "XRP"
      ? payment.fassetsReservation
        ? payment.fassetsReservation.paymentReference.replace(/^0x/, "").toUpperCase()
        : buildMemo(payment.paymentReference).memoDataHex
      : undefined

  return {
    ...publicFields,
    links: {
      status: `/status/${payment.id}`,
      sourceTransaction: payment.verification?.sourceTransactionId
        ? NETWORKS.xrpl.txUrl(payment.verification.sourceTransactionId)
        : undefined,
      verificationTransaction: payment.verification?.coston2TransactionHash
        ? NETWORKS.flare.txUrl(payment.verification.coston2TransactionHash)
        : undefined,
      settlementTransaction: payment.settlement?.transactionHash
        ? NETWORKS.flare.txUrl(payment.settlement.transactionHash)
        : undefined,
      registry: payment.verification?.registryAddress
        ? NETWORKS.flare.addressUrl(payment.verification.registryAddress)
        : undefined,
      intentTransaction: payment.onChainIntentTransactionHash
        ? NETWORKS.flare.txUrl(payment.onChainIntentTransactionHash)
        : undefined,
    },
    paymentInstructions: route?.paymentInstructions
      ? {
          ...route.paymentInstructions,
          memoDataHex,
          // C2FLR payers can attach the reference as calldata, which binds the transfer to this
          // intent exactly. FXRP cannot — ERC-20 transfer has no memo field — so it is matched
          // on amount and window instead.
          referenceCalldata:
            payment.selectedAsset === "C2FLR"
              ? encodeReferenceCalldata(payment.paymentReference)
              : undefined,
        }
      : undefined,
  }
}
