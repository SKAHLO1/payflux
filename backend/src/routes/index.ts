import { Router } from "express"
import { z } from "zod"
import {
  asyncHandler,
  authenticate,
  authenticateSessionOrKey,
  requireScope,
  validate,
} from "../middleware/index.js"
import { paymentsRouter } from "./payments.routes.js"
import { apiKeysRouter } from "./api-keys.routes.js"
import { accountRouter } from "./account.routes.js"
import { isAuthConfigured } from "../auth/firebase.js"
import { listAssets } from "../registry/assets.js"
import { findRoutes } from "../routing/router.js"
import * as settlements from "../settlement/settlement.service.js"
import { getStore } from "../store/index.js"
import { capabilities, env, NETWORKS } from "../config/env.js"
import { fdcHealth } from "../verification/fdc.service.js"
import { fassetsHealth, getMintingLimits } from "../chain/fassets.js"
import { registryHealth } from "../chain/payment-registry.js"
import { feedHealth } from "../pricing/ftso.service.js"
import { signWebhook } from "../webhooks/signer.js"

export const apiRouter = Router()

apiRouter.use("/payments", paymentsRouter)
apiRouter.use("/api-keys", apiKeysRouter)
apiRouter.use("/account", accountRouter)

// ---------------------------------------------------------------------------
// Assets & routes
// ---------------------------------------------------------------------------

apiRouter.get("/assets", (_req, res) => {
  res.json({ data: listAssets() })
})

const routeQuerySchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency: z.string().length(3).default("USD"),
  assets: z.string().min(2),
})

apiRouter.get(
  "/routes",
  validate(routeQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof routeQuerySchema>
    const routes = await findRoutes(
      {
        paymentId: "preview",
        fiatAmount: query.amount,
        fiatCurrency: query.currency,
        acceptedAssets: query.assets.split(",").map((a) => a.trim().toUpperCase()),
      },
      {
        merchantXrplAddress: env.MERCHANT_XRPL_ADDRESS,
        merchantFlareAddress: env.MERCHANT_FLARE_ADDRESS,
      },
    )
    res.json({ data: routes, recommended: routes.find((r) => r.status === "available")?.id })
  }),
)

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

const settlementQuoteSchema = z.object({
  paymentId: z.string().min(3),
  sourceAsset: z.string().min(2).max(12),
  destinationAsset: z.string().min(2).max(12),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
})

apiRouter.post(
  "/settlements/quote",
  authenticate,
  requireScope("settlements:read"),
  validate(settlementQuoteSchema),
  asyncHandler(async (req, res) => {
    const store = await getStore()
    const merchant = await store.getMerchant(req.merchantId!)
    const quote = await settlements.quoteSettlement({
      ...req.body,
      merchantAddress: merchant?.flareAddress ?? "",
    })
    res.json({ data: quote })
  }),
)

apiRouter.post(
  "/settlements",
  authenticate,
  requireScope("settlements:write"),
  validate(z.object({ paymentId: z.string().min(3) })),
  asyncHandler(async (req, res) => {
    const store = await getStore()
    const payment = await store.getPayment(req.body.paymentId)
    const merchant = await store.getMerchant(req.merchantId!)
    if (!payment || !merchant) {
      return res.status(404).json({ error: { code: "PAYMENT_NOT_FOUND", message: "Unknown payment." } })
    }
    const settlement = await settlements.executeSettlement({ payment, merchant })
    res.status(201).json({ data: settlement })
  }),
)

apiRouter.get(
  "/settlements",
  authenticateSessionOrKey("settlements:read"),
  asyncHandler(async (req, res) => {
    const data = await settlements.listSettlements(req.merchantId!, Number(req.query.limit ?? 50))
    res.json({ data })
  }),
)

apiRouter.get(
  "/settlements/:id",
  authenticate,
  requireScope("settlements:read"),
  asyncHandler(async (req, res) => {
    const settlement = await settlements.getSettlement(req.params.id)
    if (!settlement) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown settlement." } })
    }
    res.json({ data: settlement })
  }),
)

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

apiRouter.get(
  "/webhooks",
  authenticateSessionOrKey("webhooks:read"),
  asyncHandler(async (req, res) => {
    const store = await getStore()
    const merchant = await store.getMerchant(req.merchantId!)
    const deliveries = await store.listWebhookDeliveries(req.merchantId!, 50)
    res.json({
      endpoint: merchant?.webhookUrl,
      // The secret is never returned — only whether one is configured.
      secretConfigured: Boolean(merchant?.webhookSecret),
      data: deliveries,
    })
  }),
)

apiRouter.post(
  "/webhooks/test",
  authenticate,
  requireScope("webhooks:write"),
  asyncHandler(async (req, res) => {
    const store = await getStore()
    const merchant = await store.getMerchant(req.merchantId!)
    if (!merchant?.webhookUrl || !merchant.webhookSecret) {
      return res.status(400).json({
        error: {
          code: "WEBHOOK_NOT_CONFIGURED",
          message: "Configure MERCHANT_WEBHOOK_URL and MERCHANT_WEBHOOK_SECRET first.",
        },
      })
    }

    const payload = {
      type: "webhook.test",
      createdAt: new Date().toISOString(),
      merchantId: merchant.id,
      message: "If you can verify this signature, your integration is wired up correctly.",
    }
    const signed = signWebhook(payload, merchant.webhookSecret)

    const response = await fetch(merchant.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PayFlux-Signature": signed.signature,
        "X-PayFlux-Delivery": signed.deliveryId,
      },
      body: signed.body,
    }).catch((error) => ({ ok: false, status: 0, statusText: String(error) }) as Response)

    res.json({
      delivered: response.ok,
      httpStatus: response.status,
      deliveryId: signed.deliveryId,
    })
  }),
)

// ---------------------------------------------------------------------------
// Diagnostics — the honesty surface
// ---------------------------------------------------------------------------

/**
 * Reports exactly which parts of the stack are live. The dashboard renders this verbatim, so an
 * unconfigured capability shows as UNAVAILABLE with its reason instead of silently degrading
 * into plausible-looking fake data.
 */
apiRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const [fdc, fassets, registry, feeds, limits] = await Promise.all([
      fdcHealth().catch((e) => ({ reachable: false, detail: String(e) })),
      fassetsHealth(),
      registryHealth(),
      feedHealth().catch(() => []),
      getMintingLimits().catch(() => undefined),
    ])

    res.json({
      status: "ok",
      mode: env.PAYFLUX_DEMO_MODE ? "DEMO" : "LIVE",
      networks: {
        flare: { name: NETWORKS.flare.name, chainId: NETWORKS.flare.chainId, explorer: NETWORKS.flare.explorer },
        xrpl: { name: NETWORKS.xrpl.name, explorer: NETWORKS.xrpl.explorer },
      },
      capabilities: capabilities(),
      auth: {
        googleSignIn: isAuthConfigured(),
        detail: isAuthConfigured()
          ? undefined
          : "Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY on the API to enable Google sign-in and dashboard-managed API keys.",
      },
      fdc,
      fassets: { ...fassets, limits },
      paymentRegistry: registry,
      priceFeeds: feeds,
      settlementProviders: settlements.listProviders(),
    })
  }),
)
