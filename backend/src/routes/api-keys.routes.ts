import { Router } from "express"
import { z } from "zod"
import { asyncHandler, authenticateUser, validate } from "../middleware/index.js"
import {
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  toView,
} from "../auth/api-keys.js"
import { getStore } from "../store/index.js"
import { env } from "../config/env.js"
import { actorFor, recordAudit } from "../audit/audit.service.js"
import { API_SCOPES, DEFAULT_SCOPES, SCOPE_DESCRIPTIONS } from "../domain/types.js"

/**
 * API key management.
 *
 * Every route here requires a signed-in human (`authenticateUser`), never an API key. The secret
 * is returned exactly once, in the response that creates it — there is no endpoint that reveals
 * an existing key, because the server does not have it to reveal.
 *
 * Every mutation writes an audit event before responding, so the trail cannot fall behind the
 * state it describes.
 */
export const apiKeysRouter = Router()

apiKeysRouter.use(authenticateUser)

/** The signed-in developer's own profile. Lets the dashboard render who it thinks you are. */
apiKeysRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const store = await getStore()
    const account = await store.getAccount(req.accountId!)
    const merchant = await store.getMerchant(req.accountId!)

    res.json({
      account: {
        id: account?.id,
        email: account?.email,
        displayName: account?.displayName,
        photoUrl: account?.photoUrl,
        createdAt: account?.createdAt,
      },
      settlementPreference: merchant?.settlementPreference,
      xrplAddress: merchant?.xrplAddress ?? env.MERCHANT_XRPL_ADDRESS,
      flareAddress: merchant?.flareAddress ?? env.MERCHANT_FLARE_ADDRESS,
    })
  }),
)

apiKeysRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({
      data: await listApiKeys(req.accountId!),
      limit: env.MAX_API_KEYS_PER_ACCOUNT,
      defaultGraceHours: env.API_KEY_ROTATION_GRACE_HOURS,
      availableScopes: API_SCOPES.map((scope) => ({
        scope,
        description: SCOPE_DESCRIPTIONS[scope],
      })),
      defaultScopes: DEFAULT_SCOPES,
    })
  }),
)

const createSchema = z.object({
  name: z.string().min(1).max(64).default("Default key"),
  /** Omitted means the minimum needed to accept a payment, not full access. */
  scopes: z.array(z.string()).max(API_SCOPES.length).optional(),
})

apiKeysRouter.post(
  "/",
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const issued = await issueApiKey(req.accountId!, req.body.name, { scopes: req.body.scopes })

    await recordAudit({
      accountId: req.accountId!,
      type: "api_key.created",
      actor: actorFor(req),
      target: { kind: "api_key", id: issued.record.id },
      metadata: { name: issued.record.name, scopes: issued.record.scopes },
      request: req,
    })

    res.status(201).json({
      data: toView(issued.record, issued.secret),
      warning:
        "This is the only time the secret is shown. Store it now — PayFlux keeps only a hash and cannot recover it.",
    })
  }),
)

const rotateSchema = z.object({
  /**
   * Grace window for the old key. The default lets a developer deploy the new key and confirm
   * traffic has moved before the old one stops working. Zero means revoke immediately, which is
   * what you want for a leaked key.
   */
  graceHours: z.number().int().min(0).max(168).optional(),
  /** Omitted means inherit the predecessor's scopes. */
  scopes: z.array(z.string()).max(API_SCOPES.length).optional(),
})

apiKeysRouter.post(
  "/:id/rotate",
  validate(rotateSchema),
  asyncHandler(async (req, res) => {
    const graceHours = req.body.graceHours ?? env.API_KEY_ROTATION_GRACE_HOURS
    const result = await rotateApiKey(
      req.accountId!,
      req.params.id,
      graceHours,
      req.body.scopes,
    )

    await recordAudit({
      accountId: req.accountId!,
      type: "api_key.rotated",
      actor: actorFor(req),
      target: { kind: "api_key", id: result.previous.id },
      metadata: {
        successorId: result.issued.record.id,
        graceHours,
        expiresAt: result.previous.expiresAt,
        scopes: result.issued.record.scopes,
      },
      request: req,
    })

    res.status(201).json({
      data: toView(result.issued.record, result.issued.secret),
      previous: toView(result.previous),
      graceHours,
      warning:
        graceHours > 0
          ? `The previous key keeps working until ${result.previous.expiresAt}. Deploy this one, then let the old key lapse.`
          : "The previous key was revoked immediately and will now be rejected.",
    })
  }),
)

apiKeysRouter.post(
  "/:id/revoke",
  asyncHandler(async (req, res) => {
    const revoked = await revokeApiKey(req.accountId!, req.params.id)

    await recordAudit({
      accountId: req.accountId!,
      type: "api_key.revoked",
      actor: actorFor(req),
      target: { kind: "api_key", id: revoked.id },
      metadata: { name: revoked.name },
      request: req,
    })

    res.json({ data: toView(revoked) })
  }),
)
