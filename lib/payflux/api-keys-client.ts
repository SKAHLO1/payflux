import { API_BASE, ApiError, ApiUnreachableError } from "./client"
import type { Payment, Settlement } from "./types"

/**
 * Client for the key-management endpoints.
 *
 * These call the PayFlux API directly with the Firebase ID token rather than going through a
 * Next proxy. The API verifies the token itself, so there is exactly one place that decides who
 * you are — a proxy in between would either be redundant or a second, weaker trust boundary.
 */

export type ApiKeyStatus = "active" | "rotating" | "revoked" | "expired"

export interface ApiKey {
  id: string
  name: string
  prefix: string
  status: ApiKeyStatus
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string
  revokedAt?: string
  rotatedToId?: string
  rotatedFromId?: string
  environment: "testnet"
  scopes: ApiScope[]
  /** Predates scopes and is running with implicit full access — rotate to apply real scopes. */
  legacyFullAccess: boolean
  /** Present only in the response that created or rotated it. */
  secret?: string
}

export type ApiScope =
  | "payments:read"
  | "payments:write"
  | "settlements:read"
  | "settlements:write"
  | "webhooks:read"
  | "webhooks:write"

export interface AccountSettings {
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

export interface AuditEvent {
  id: string
  accountId: string
  type: string
  actor: { kind: "user" | "api_key" | "system"; id: string; email?: string }
  target?: { kind: string; id: string }
  metadata: Record<string, unknown>
  requestId?: string
  ip?: string
  userAgent?: string
  createdAt: string
}

export interface AccountProfile {
  account: {
    id?: string
    email?: string
    displayName?: string
    photoUrl?: string
    createdAt?: string
  }
  settlementPreference?: { asset: string; chain: string }
  xrplAddress?: string
  flareAddress?: string
}

async function call<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
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

export const apiKeysApi = {
  me: (token: string) => call<AccountProfile>("/v1/api-keys/me", token),

  list: (token: string) =>
    call<{
      data: ApiKey[]
      limit: number
      defaultGraceHours: number
      availableScopes: Array<{ scope: ApiScope; description: string }>
      defaultScopes: ApiScope[]
    }>("/v1/api-keys", token),

  create: (token: string, name: string, scopes: ApiScope[]) =>
    call<{ data: ApiKey; warning: string }>("/v1/api-keys", token, {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    }),

  rotate: (token: string, id: string, graceHours?: number, scopes?: ApiScope[]) =>
    call<{ data: ApiKey; previous: ApiKey; graceHours: number; warning: string }>(
      `/v1/api-keys/${id}/rotate`,
      token,
      { method: "POST", body: JSON.stringify({ graceHours, scopes }) },
    ),

  revoke: (token: string, id: string) =>
    call<{ data: ApiKey }>(`/v1/api-keys/${id}/revoke`, token, { method: "POST" }),
}

/**
 * Merchant data, read with the signed-in developer's own session.
 *
 * These call the API directly rather than going through a Next proxy holding one server-side
 * key. On a shared deployment that proxy would show every developer the key owner's account —
 * their own data invisible, someone else's on screen.
 */
export const merchantSessionApi = {
  payments: (token: string, limit = 50) =>
    call<{ data: Payment[] }>(`/v1/payments?limit=${limit}`, token),

  settlements: (token: string) => call<{ data: Settlement[] }>("/v1/settlements", token),

  webhooks: (token: string) =>
    call<{ endpoint?: string; secretConfigured: boolean; data: unknown[] }>("/v1/webhooks", token),
}

/**
 * Reads with the developer's session when signed in, otherwise through the shared-key proxy.
 *
 * The fallback keeps a local, single-operator deployment working with no Firebase configured —
 * there is only one account there, so a shared key shows the right data. On a deployment where
 * developers sign up, the session path is the only correct one.
 */
export async function loadScoped<T>(
  getToken: () => Promise<string | undefined>,
  withSession: (token: string) => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  const token = await getToken()
  return token ? withSession(token) : fallback()
}

export const accountApi = {
  settings: (token: string) => call<{ data: AccountSettings }>("/v1/account/settings", token),

  updateSettings: (token: string, patch: Partial<Record<string, string>>) =>
    call<{ data: AccountSettings; changed: string[] }>("/v1/account/settings", token, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  audit: (token: string, limit = 100) =>
    call<{ data: AuditEvent[] }>(`/v1/account/audit?limit=${limit}`, token),
}
