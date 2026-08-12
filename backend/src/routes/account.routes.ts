import { Router } from "express"
import { z } from "zod"
import { asyncHandler, authenticateUser, validate } from "../middleware/index.js"
import { getStore } from "../store/index.js"
import { env } from "../config/env.js"
import { listAuditEvents, recordAudit, actorFor } from "../audit/audit.service.js"
import { checkAccountExists, XRPL_ADDRESS_PATTERN } from "../verification/xrpl.payment.js"
import { validateSettlementAsset, UnsupportedAssetError } from "../registry/assets.js"
import type { Merchant } from "../domain/types.js"

/**
 * Account settings and audit trail.
 *
 * Settlement addresses are per-account: a developer's customers pay *their* XRPL address, and
 * their FXRP lands in *their* Coston2 wallet. Where a value is unset the deployment default is
 * used, and the response says which is which so nobody has to guess where their money is going.
 *
 * Session-authenticated only. Changing where funds settle is an act by a person, not something
 * an integration key should be able to do.
 */
export const accountRouter = Router()

accountRouter.use(authenticateUser)

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

interface SettingsView {
  xrplAddress?: string
  flareAddress?: string
  settlementAsset: string
  webhookUrl?: string
  webhookSecretConfigured: boolean
  /** Settings still needed before payments can be accepted. */
  unset: string[]
  /** True once this account can actually receive money. */
  readyToAcceptPayments: boolean
}

/**
 * Reports only what this account has set.
 *
 * Deliberately no fallback to the deployment's addresses: showing the operator's XRPL address
 * in a developer's settings form reads as "this is yours" and invites them to leave it. Blank
 * with a clear prompt is the honest presentation.
 */
function toSettingsView(merchant: Merchant | undefined): SettingsView {
  const unset: string[] = []
  if (!merchant?.xrplAddress) unset.push("xrplAddress")
  if (!merchant?.flareAddress) unset.push("flareAddress")

  return {
    xrplAddress: merchant?.xrplAddress,
    flareAddress: merchant?.flareAddress,
    settlementAsset: merchant?.settlementPreference?.asset ?? "FXRP",
    webhookUrl: merchant?.webhookUrl,
    webhookSecretConfigured: Boolean(merchant?.webhookSecret),
    unset,
    // Webhooks are optional; addresses are not — without them there is nowhere for money to go.
    readyToAcceptPayments: Boolean(merchant?.xrplAddress && merchant?.flareAddress),
  }
}

accountRouter.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const store = await getStore()
    const merchant = await store.getMerchant(req.accountId!)
    res.json({ data: toSettingsView(merchant) })
  }),
)

const updateSchema = z.object({
  xrplAddress: z
    .string()
    .regex(XRPL_ADDRESS_PATTERN, "Not a valid XRPL classic address (starts with r).")
    .optional()
    .or(z.literal("")),
  flareAddress: z
    .string()
    .regex(EVM_ADDRESS, "Not a valid Coston2 address (0x followed by 40 hex characters).")
    .optional()
    .or(z.literal("")),
  settlementAsset: z.string().min(2).max(12).optional(),
  webhookUrl: z.string().url().optional().or(z.literal("")),
  webhookSecret: z.string().min(16).max(200).optional().or(z.literal("")),
})

accountRouter.patch(
  "/settings",
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const store = await getStore()
    const accountId = req.accountId!
    const existing = await store.getMerchant(accountId)
    const body = req.body as z.infer<typeof updateSchema>

    // An empty string is "clear this and fall back to the deployment default", which is a
    // different intent from omitting the field entirely.
    const clear = (value: string | undefined) => (value === "" ? undefined : value)

    const changed: string[] = []
    const next: Merchant = {
      id: accountId,
      name: existing?.name ?? req.user?.email ?? accountId,
      settlementPreference: existing?.settlementPreference ?? { asset: "FXRP", chain: "coston2" },
      xrplAddress: existing?.xrplAddress,
      flareAddress: existing?.flareAddress,
      webhookUrl: existing?.webhookUrl,
      webhookSecret: existing?.webhookSecret,
    }

    if (body.xrplAddress !== undefined) {
      const value = clear(body.xrplAddress)
      if (value) {
        const check = await checkAccountExists(value)
        if (!check.exists) {
          return res.status(422).json({
            error: { code: "XRPL_ACCOUNT_NOT_FOUND", message: check.detail },
            requestId: req.requestId,
          })
        }
      }
      if (value !== next.xrplAddress) changed.push("xrplAddress")
      next.xrplAddress = value
    }

    if (body.flareAddress !== undefined) {
      const value = clear(body.flareAddress)
      if (value !== next.flareAddress) changed.push("flareAddress")
      next.flareAddress = value
    }

    if (body.settlementAsset !== undefined) {
      try {
        validateSettlementAsset(body.settlementAsset)
      } catch (error) {
        if (error instanceof UnsupportedAssetError) {
          return res.status(400).json({
            error: { code: error.code, message: error.message },
            requestId: req.requestId,
          })
        }
        throw error
      }
      if (body.settlementAsset.toUpperCase() !== next.settlementPreference.asset) {
        changed.push("settlementAsset")
      }
      next.settlementPreference = {
        asset: body.settlementAsset.toUpperCase(),
        chain: "coston2",
      }
    }

    if (body.webhookUrl !== undefined) {
      const value = clear(body.webhookUrl)
      if (value !== next.webhookUrl) changed.push("webhookUrl")
      next.webhookUrl = value
    }

    if (body.webhookSecret !== undefined) {
      const value = clear(body.webhookSecret)
      if (value !== next.webhookSecret) changed.push("webhookSecret")
      next.webhookSecret = value
    }

    const saved = await store.saveMerchant(next)

    if (changed.length > 0) {
      await recordAudit({
        accountId,
        type: "settings.updated",
        actor: actorFor(req),
        target: { kind: "settings", id: accountId },
        // Field names and non-sensitive values only — the webhook secret is recorded as having
        // changed and never as a value.
        metadata: {
          changed,
          xrplAddress: changed.includes("xrplAddress") ? saved.xrplAddress : undefined,
          flareAddress: changed.includes("flareAddress") ? saved.flareAddress : undefined,
          settlementAsset: changed.includes("settlementAsset")
            ? saved.settlementPreference.asset
            : undefined,
          webhookUrl: changed.includes("webhookUrl") ? saved.webhookUrl : undefined,
        },
        request: req,
      })
    }

    res.json({ data: toSettingsView(saved), changed })
  }),
)

accountRouter.get(
  "/audit",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 250)
    res.json({ data: await listAuditEvents(req.accountId!, limit) })
  }),
)
