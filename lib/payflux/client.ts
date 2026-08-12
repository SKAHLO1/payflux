import type {
  HealthReport,
  Payment,
  PaymentAsset,
  PaymentEvent,
  PaymentRoute,
  Settlement,
} from "./types"

/**
 * Browser-side API client.
 *
 * Deliberately thin, and deliberately never given an API key: the merchant secret lives on the
 * server. Public reads (a customer's own payment, its routes, its status stream) are
 * unauthenticated by design; merchant reads go through the Next route handlers in app/api, which
 * hold the key server-side.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_PAYFLUX_API_URL?.replace(/\/$/, "") ?? "http://localhost:4000"

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/** Distinguishes "the API is not running" from "the API said no" — the UI renders these differently. */
export class ApiUnreachableError extends Error {
  readonly code = "API_UNREACHABLE"
  constructor(readonly detail: string) {
    super(
      `The PayFlux API at ${API_BASE} could not be reached. Start it with \`npm run dev:api\`.`,
    )
    this.name = "ApiUnreachableError"
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    })
  } catch (error) {
    throw new ApiUnreachableError(error instanceof Error ? error.message : String(error))
  }

  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}

  if (!response.ok) {
    throw new ApiError(
      payload?.error?.code ?? "REQUEST_FAILED",
      payload?.error?.message ?? `HTTP ${response.status}`,
      response.status,
    )
  }
  return payload as T
}

export const payfluxApi = {
  health: () => call<HealthReport>("/v1/health"),

  assets: () => call<{ data: PaymentAsset[] }>("/v1/assets"),

  previewRoutes: (amount: string, assets: string[], currency = "USD") =>
    call<{ data: PaymentRoute[]; recommended?: string }>(
      `/v1/routes?amount=${encodeURIComponent(amount)}&currency=${currency}&assets=${assets.join(",")}`,
    ),

  getPayment: (id: string) => call<Payment>(`/v1/payments/${id}`),

  getRoutes: (id: string) =>
    call<{ data: PaymentRoute[]; recommended?: string }>(`/v1/payments/${id}/routes`),

  getEvents: (id: string) => call<{ data: PaymentEvent[] }>(`/v1/payments/${id}/events`),

  selectAsset: (id: string, asset: string) =>
    call<Payment>(`/v1/payments/${id}/select-asset`, {
      method: "POST",
      body: JSON.stringify({ asset }),
    }),

  /**
   * Asks the backend to re-check the chain. The hash is explicitly a hint — the backend
   * re-derives the truth from XRPL and FDC regardless of what is passed here.
   */
  verify: (id: string, transactionHashHint?: string) =>
    call<{ status: string; detail?: string; payment: Payment }>(`/v1/payments/${id}/verify`, {
      method: "POST",
      body: JSON.stringify({ transactionHashHint }),
    }),

  getSettlement: (id: string) => call<{ data: Settlement }>(`/v1/settlements/${id}`),
}

/**
 * Same-origin fetch for routes hosted by the Next app itself.
 *
 * These must NOT go through `call()`, which prefixes `API_BASE` — that would send them to the
 * Express backend, which has no `/api/merchant/*` routes and answers with its own 404.
 */
async function callLocal<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    })
  } catch (error) {
    throw new ApiError(
      "NETWORK_ERROR",
      error instanceof Error ? error.message : String(error),
      0,
    )
  }

  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}

  if (!response.ok) {
    throw new ApiError(
      payload?.error?.code ?? "REQUEST_FAILED",
      payload?.error?.message ?? `HTTP ${response.status}`,
      response.status,
    )
  }
  return payload as T
}

/**
 * Merchant-scoped reads, proxied through Next route handlers so the API key stays server-side.
 * Relative paths on purpose — see `callLocal`.
 */
export const merchantApi = {
  payments: () => callLocal<{ data: Payment[] }>("/api/merchant/payments"),
  settlements: () => callLocal<{ data: Settlement[] }>("/api/merchant/settlements"),
  webhooks: () =>
    callLocal<{ endpoint?: string; secretConfigured: boolean; data: unknown[] }>(
      "/api/merchant/webhooks",
    ),
}

export function streamUrl(paymentId: string): string {
  return `${API_BASE}/v1/payments/${paymentId}/stream`
}
