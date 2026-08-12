import { API_BASE } from "./client"

/**
 * The key verification sequence, run in the browser.
 *
 * Two deliberate departures from the rest of this directory.
 *
 * 1. `payfluxApi` is documented as never holding an API key, and that stays true — merchant
 *    reads there go through the Next route handlers, which keep the secret server-side. This
 *    module is the one place a key is used from the browser, and it is the developer's *own*
 *    key, in their own tab, sent only to the PayFlux API. It never touches this website's
 *    server, which is the entire reason the checks run client-side rather than through a proxy.
 *
 * 2. The sequence is fixed and read-mostly. It creates exactly one payment intent, because
 *    proving `payments:write` requires actually writing. It never selects an asset: that is the
 *    call that opens the on-chain intent and reserves FAssets collateral, which costs real C2FLR
 *    per run and is non-refundable. A verification tool must not spend the operator's balance.
 */

export type CheckOutcome = "pass" | "fail" | "skip" | "info"

export interface CheckResult {
  label: string
  outcome: CheckOutcome
  detail: string
  /** Extra lines rendered beneath the result, indented — route tables and the like. */
  extra?: string[]
}

export interface KeyCheckReport {
  results: CheckResult[]
  paymentId?: string
  demoMode: boolean
  passed: number
  failed: number
}

interface CallResult<T> {
  status: number
  body: T & { error?: { code?: string; message?: string; requiredScope?: string } }
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { key?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<CallResult<T>> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (options.key) headers["X-API-Key"] = options.key
  if (options.body) headers["Content-Type"] = "application/json"
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : ({} as T) }
}

/**
 * Runs the sequence, reporting each step as it completes.
 *
 * `onResult` fires per check so the terminal can type results out as they land rather than
 * appearing all at once at the end — the waiting is the part that makes it feel real.
 */
export async function runKeyCheck(
  key: string,
  onResult: (result: CheckResult) => void,
): Promise<KeyCheckReport> {
  const results: CheckResult[] = []
  let paymentId: string | undefined
  let demoMode = false

  const record = (result: CheckResult) => {
    results.push(result)
    onResult(result)
  }

  // --- Reachability ---------------------------------------------------
  let health: CallResult<Record<string, any>>
  try {
    health = await call("GET", "/v1/health")
  } catch (error) {
    record({
      label: "API reachable",
      outcome: "fail",
      detail:
        `Could not reach ${API_BASE}. If the API is deployed, check that this site's origin ` +
        `is listed in ALLOWED_ORIGINS.`,
    })
    return { results, demoMode, passed: 0, failed: 1 }
  }

  if (health.status === 200) {
    demoMode = health.body.mode === "DEMO"
    const caps = health.body.capabilities ?? {}
    const live = Object.values(caps).filter(Boolean).length
    record({
      label: "API reachable",
      outcome: "pass",
      detail: `mode ${health.body.mode ?? "LIVE"} · ${live}/${Object.keys(caps).length} capabilities live`,
    })
    if (demoMode) {
      record({
        label: "DEMO MODE",
        outcome: "info",
        detail: "This instance serves demo data. Results are not real verifications.",
      })
    }
  } else {
    record({ label: "API reachable", outcome: "fail", detail: `HTTP ${health.status}` })
  }

  // --- Identity -------------------------------------------------------
  const self = await call<Record<string, any>>("GET", "/v1/keys/self", { key })

  if (self.status === 401) {
    record({
      label: "Key recognised",
      outcome: "fail",
      detail: "401 — this deployment does not recognise the key. Check you pasted it in full.",
    })
    return { results, demoMode, passed: count(results, "pass"), failed: count(results, "fail") }
  }
  if (self.status === 429) {
    record({
      label: "Key recognised",
      outcome: "fail",
      detail: "Rate limited. Key verification is capped at 10 attempts a minute — wait and retry.",
    })
    return { results, demoMode, passed: count(results, "pass"), failed: count(results, "fail") }
  }
  if (self.status !== 200) {
    record({
      label: "Key recognised",
      outcome: "fail",
      detail: `HTTP ${self.status}: ${self.body.error?.message ?? "unexpected response"}`,
    })
    return { results, demoMode, passed: count(results, "pass"), failed: count(results, "fail") }
  }

  const scopes: string[] = self.body.scopes ?? []
  record({
    label: "Key recognised",
    outcome: "pass",
    detail: `${self.body.keyId} · ${self.body.status} · ${self.body.source}`,
    extra: [
      `scopes    ${scopes.join(", ") || "(none)"}`,
      `merchant  ${self.body.merchantId ?? "—"}`,
      self.body.lastUsedAt ? `last used ${self.body.lastUsedAt}` : "last used never until now",
    ],
  })

  if (self.body.legacyKey) {
    record({
      label: "Legacy key",
      outcome: "info",
      detail: "Issued before scopes existed, so it runs with full access. Rotate to narrow it.",
    })
  }
  if (self.body.expiresAt) {
    record({
      label: "Rotation grace period",
      outcome: "info",
      detail: `This key was rotated and stops working at ${self.body.expiresAt}.`,
    })
  }

  // --- Read scope -----------------------------------------------------
  const list = await call<{ data: unknown[] }>("GET", "/v1/payments", { key })
  record({
    label: "payments:read",
    outcome: list.status === 200 || list.status === 403 ? "pass" : "fail",
    detail:
      list.status === 200
        ? `granted · ${list.body.data?.length ?? 0} payment(s) visible`
        : list.status === 403
          ? "not held by this key — correctly refused"
          : `HTTP ${list.status}`,
  })

  // --- Write scope, with one real payment -----------------------------
  const draft = {
    amount: "5.00",
    currency: "USD",
    acceptedAssets: ["XRP"],
    settlementAsset: "FXRP",
    orderId: `playground_${Date.now()}`,
  }

  const created = await call<{ id: string; paymentReference: string; status: string }>(
    "POST",
    "/v1/payments",
    { key, body: draft, idempotencyKey: draft.orderId },
  )

  if (created.status === 201) {
    paymentId = created.body.id
    record({
      label: "payments:write",
      outcome: "pass",
      detail: `created ${created.body.paymentReference} · status ${created.body.status}`,
      extra: [`id        ${created.body.id}`],
    })
  } else if (created.status === 403) {
    record({
      label: "payments:write",
      outcome: "pass",
      detail: `not held by this key — correctly refused (needs ${created.body.error?.requiredScope})`,
    })
  } else {
    record({
      label: "payments:write",
      outcome: "fail",
      detail: `HTTP ${created.status}: ${created.body.error?.message ?? "unexpected response"}`,
    })
  }

  // --- Behaviour, only if something was actually created ---------------
  if (paymentId) {
    const replay = await call<{ id: string }>("POST", "/v1/payments", {
      key,
      body: draft,
      idempotencyKey: draft.orderId,
    })
    record({
      label: "Idempotency",
      outcome: replay.body.id === paymentId ? "pass" : "fail",
      detail:
        replay.body.id === paymentId
          ? "replaying the request returned the same payment, not a duplicate"
          : `expected ${paymentId}, got ${replay.body.id}`,
    })

    const routes = await call<{ data: any[] }>("GET", `/v1/payments/${paymentId}/routes`)
    if (routes.status === 200) {
      const available = routes.body.data.filter((r) => r.status === "available")
      record({
        label: "Routing engine",
        outcome: "pass",
        detail: `${available.length}/${routes.body.data.length} route(s) available · quoted from FTSOv2`,
        extra: routes.body.data.map(
          (r) =>
            `${String(r.sourceAsset).padEnd(6)} ${String(r.status).padEnd(12)} ` +
            `${r.estimatedInputAmount ?? "—"} → ${r.destinationAsset ?? "—"}`,
        ),
      })
    } else {
      record({ label: "Routing engine", outcome: "fail", detail: `HTTP ${routes.status}` })
    }

    record({
      label: "Asset selection",
      outcome: "skip",
      detail:
        "Not run. Selecting a route opens the on-chain intent and reserves FAssets collateral, " +
        "which costs real C2FLR — deliberately left to a genuine checkout.",
    })
  }

  return {
    results,
    paymentId,
    demoMode,
    passed: count(results, "pass"),
    failed: count(results, "fail"),
  }
}

function count(results: CheckResult[], outcome: CheckOutcome): number {
  return results.filter((r) => r.outcome === outcome).length
}
