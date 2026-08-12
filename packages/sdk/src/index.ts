import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * @payflux/node — the merchant-facing SDK.
 *
 * The point of this package is that nothing below leaks upward. A merchant integrating PayFlux
 * writes no chain code: no RPC URLs, no ABIs, no attestation types, no lot sizes. They express a
 * price and the assets they will accept, and they receive one normalized confirmation.
 *
 *   const payflux = new PayFlux({ apiKey: process.env.PAYFLUX_SECRET_KEY })
 *
 *   const payment = await payflux.payments.create({
 *     amount: "50",
 *     currency: "USD",
 *     acceptedAssets: ["XRP", "FXRP", "C2FLR"],
 *     settlementAsset: "FXRP",
 *   })
 */

export interface PayFluxOptions {
  apiKey: string
  /** Defaults to the local API. Point this at your deployment. */
  baseUrl?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export class PayFluxError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = "PayFluxError"
  }
}

export type PaymentStatus =
  | "created"
  | "awaiting_payment"
  | "payment_detected"
  | "verifying"
  | "verified"
  | "settling"
  | "settled"
  | "failed"
  | "expired"
  | "partially_paid"
  | "overpaid"
  | "refunded"

export interface CreatePaymentParams {
  amount: string
  currency?: string
  acceptedAssets: string[]
  settlementAsset?: string
  orderId?: string
  metadata?: Record<string, string>
  expiresInSeconds?: number
  /** Passed through as the Idempotency-Key header. */
  idempotencyKey?: string
}

export interface Payment {
  id: string
  status: PaymentStatus
  amount: string
  currency: string
  acceptedAssets: string[]
  selectedAsset?: string
  paymentReference: string
  expiresAt: string
  createdAt: string
  orderId?: string
  metadata?: Record<string, string>
  verification?: Record<string, unknown>
  settlement?: Record<string, unknown>
  reconciliation?: Record<string, unknown>
  paymentInstructions?: {
    chain: string
    asset: string
    destinationAddress: string
    amount: string
    amountUnit: string
    memoDataHex?: string
  }
  links: {
    status: string
    sourceTransaction?: string
    verificationTransaction?: string
    settlementTransaction?: string
    registry?: string
    intentTransaction?: string
  }
}

export interface Route {
  id: string
  sourceAsset: string
  sourceChain: string
  destinationAsset?: string
  destinationChain: string
  estimatedInputAmount: string
  estimatedFee: string
  estimatedTimeSeconds: number
  verificationMethod: string
  settlementMethod?: string
  status: "available" | "unavailable" | "degraded"
  score?: number
  reasons: string[]
  supported: boolean
  unavailableReason?: string
}

export class PayFlux {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly doFetch: typeof fetch

  constructor(private readonly options: PayFluxOptions) {
    if (!options.apiKey) throw new Error("PayFlux requires an apiKey.")
    this.baseUrl = (options.baseUrl ?? "http://localhost:4000").replace(/\/$/, "")
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.doFetch = options.fetch ?? globalThis.fetch
  }

  readonly payments = {
    create: (params: CreatePaymentParams): Promise<Payment> => {
      const { idempotencyKey, ...body } = params
      return this.request<Payment>("POST", "/v1/payments", {
        body: { currency: "USD", ...body },
        idempotencyKey,
      })
    },

    retrieve: (id: string): Promise<Payment> => this.request<Payment>("GET", `/v1/payments/${id}`),

    list: (limit = 50): Promise<{ data: Payment[]; hasMore: boolean }> =>
      this.request("GET", `/v1/payments?limit=${limit}`),

    routes: (id: string): Promise<{ data: Route[]; recommended?: string }> =>
      this.request("GET", `/v1/payments/${id}/routes`),

    events: (id: string): Promise<{ data: Array<{ type: string; timestamp: string }> }> =>
      this.request("GET", `/v1/payments/${id}/events`),

    /** Asks PayFlux to re-check the chain. The hash is a hint; the backend re-verifies from scratch. */
    verify: (id: string, transactionHashHint?: string) =>
      this.request<{ status: string; detail?: string; payment: Payment }>(
        "POST",
        `/v1/payments/${id}/verify`,
        { body: { transactionHashHint } },
      ),

    settle: (id: string) => this.request<{ data: unknown }>("POST", `/v1/payments/${id}/settle`),
  }

  readonly assets = {
    list: () => this.request<{ data: unknown[] }>("GET", "/v1/assets"),
  }

  readonly routes = {
    preview: (amount: string, assets: string[], currency = "USD") =>
      this.request<{ data: Route[]; recommended?: string }>(
        "GET",
        `/v1/routes?amount=${amount}&currency=${currency}&assets=${assets.join(",")}`,
      ),
  }

  readonly settlements = {
    quote: (body: {
      paymentId: string
      sourceAsset: string
      destinationAsset: string
      amount: string
    }) => this.request<{ data: unknown }>("POST", "/v1/settlements/quote", { body }),

    create: (paymentId: string) =>
      this.request<{ data: unknown }>("POST", "/v1/settlements", { body: { paymentId } }),

    retrieve: (id: string) => this.request<{ data: unknown }>("GET", `/v1/settlements/${id}`),
  }

  readonly webhooks = {
    list: () => this.request<{ data: unknown[] }>("GET", "/v1/webhooks"),
    test: () => this.request<{ delivered: boolean }>("POST", "/v1/webhooks/test"),
  }

  /** Which parts of the stack are live right now. Worth calling before a demo. */
  health() {
    return this.request<Record<string, unknown>>("GET", "/v1/health")
  }

  /**
   * Waits for a payment to reach a terminal state.
   *
   * Polls rather than sleeping-then-assuming: the resolved payment is always the server's actual
   * view, and a payment that fails resolves as failed rather than throwing after a fixed delay.
   */
  async waitForPayment(
    id: string,
    options: { timeoutMs?: number; intervalMs?: number; onUpdate?: (p: Payment) => void } = {},
  ): Promise<Payment> {
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000)
    const interval = options.intervalMs ?? 4_000
    let lastStatus: PaymentStatus | undefined

    while (Date.now() < deadline) {
      const payment = await this.payments.retrieve(id)
      if (payment.status !== lastStatus) {
        lastStatus = payment.status
        options.onUpdate?.(payment)
      }
      if (["settled", "failed", "expired", "refunded"].includes(payment.status)) return payment
      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    throw new PayFluxError("TIMEOUT", `Payment ${id} did not settle within the timeout.`, 408)
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    const headers: Record<string, string> = {
      "X-API-Key": this.options.apiKey,
      Accept: "application/json",
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json"
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey

    try {
      const response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })

      const text = await response.text()
      const payload = text ? JSON.parse(text) : {}

      if (!response.ok) {
        throw new PayFluxError(
          payload?.error?.code ?? "REQUEST_FAILED",
          payload?.error?.message ?? `HTTP ${response.status}`,
          response.status,
          payload?.requestId,
        )
      }

      return payload as T
    } catch (error) {
      if (error instanceof PayFluxError) throw error
      if (error instanceof Error && error.name === "AbortError") {
        throw new PayFluxError("TIMEOUT", `${method} ${path} timed out.`, 408)
      }
      throw new PayFluxError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : String(error),
        0,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

/**
 * Verify an incoming PayFlux webhook.
 *
 * Shipping this in the SDK matters: a signing scheme nobody can verify is security theatre. The
 * demo store uses this exact function on every incoming webhook.
 *
 *   app.post("/webhooks/payflux", express.raw({ type: "application/json" }), (req, res) => {
 *     const result = verifyWebhookSignature(
 *       req.header("X-PayFlux-Signature")!,
 *       req.body.toString("utf8"),
 *       process.env.PAYFLUX_WEBHOOK_SECRET!,
 *     )
 *     if (!result.valid) return res.status(400).send(result.reason)
 *   })
 *
 * Note the *raw* body. Verifying a re-serialized object will fail, because key order and spacing
 * do not survive a JSON round trip.
 *
 * Kept in this file rather than its own module so the package stays a single entry point that
 * resolves identically under Node ESM, bundlers and TypeScript — see packages/sdk/package.json.
 */
export function verifyWebhookSignature(
  header: string,
  rawBody: string,
  secret: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): { valid: boolean; reason?: string } {
  const tolerance = options.toleranceSeconds ?? 300
  const now = Math.floor((options.now ?? Date.now()) / 1000)

  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=")
      return [key, rest.join("=")]
    }),
  )

  const timestamp = Number(parts.t)
  const provided = parts.v1

  if (!Number.isFinite(timestamp) || !provided) {
    return { valid: false, reason: "malformed signature header" }
  }
  // Bounds the replay window for a captured payload.
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: "signature timestamp outside tolerance window" }
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
  const a = Buffer.from(expected, "hex")
  const b = Buffer.from(provided, "hex")

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "signature mismatch" }
  }
  return { valid: true }
}

export default PayFlux
