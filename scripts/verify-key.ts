/**
 * Verify a PayFlux API key end to end.
 *
 * Built for the moment right after a developer creates a key in the dashboard: paste it here and
 * see, in about ten seconds, that it authenticates, carries the scopes it should, creates a real
 * payment, and is refused where it should be refused.
 *
 *   npx tsx scripts/verify-key.ts sk_ctn2_...
 *   npx tsx scripts/verify-key.ts sk_ctn2_... --api https://payflux-api.onrender.com
 *
 * Every check reports what it actually observed. A scope the key does not hold is reported as a
 * correct refusal, not a failure — a read-only key being refused a write is the system working.
 */

interface Args {
  key: string
  api: string
}

function parseArgs(argv: string[]): Args {
  let key = process.env.PAYFLUX_SECRET_KEY ?? ""
  let api = process.env.PAYFLUX_API_URL ?? "http://localhost:4000"

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--api") api = argv[++i]
    else if (!argv[i].startsWith("--")) key = argv[i]
  }
  return { key, api: api.replace(/\/$/, "") }
}

const args = parseArgs(process.argv.slice(2))

const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const DIM = "\x1b[2m"
const YELLOW = "\x1b[33m"
const RESET = "\x1b[0m"

let passed = 0
let failed = 0

function pass(label: string, detail?: string) {
  passed += 1
  console.log(`  ${GREEN}PASS${RESET}  ${label}${detail ? `  ${DIM}${detail}${RESET}` : ""}`)
}

function fail(label: string, detail: string) {
  failed += 1
  console.log(`  ${RED}FAIL${RESET}  ${label}  ${RED}${detail}${RESET}`)
}

function note(label: string, detail: string) {
  console.log(`  ${YELLOW}SKIP${RESET}  ${label}  ${DIM}${detail}${RESET}`)
}

function section(title: string) {
  console.log(`\n${title}\n${"─".repeat(64)}`)
}

interface ApiResponse<T = Record<string, unknown>> {
  status: number
  body: T & { error?: { code?: string; message?: string; requiredScope?: string } }
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { body?: unknown; key?: string; idempotencyKey?: string } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (options.key) headers["X-API-Key"] = options.key
  if (options.body) headers["Content-Type"] = "application/json"
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey

  const response = await fetch(`${args.api}${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : ({} as T) }
}

async function main() {
  console.log(`\n${"═".repeat(64)}`)
  console.log("  PayFlux — API key verification")
  console.log("═".repeat(64))
  console.log(`  API:  ${args.api}`)
  console.log(`  Key:  ${args.key ? `${args.key.slice(0, 24)}…` : "(none)"}`)

  if (!args.key) {
    console.error(
      `\n  ${RED}No key supplied.${RESET} Pass it as an argument or set PAYFLUX_SECRET_KEY.\n`,
    )
    process.exit(1)
  }

  // -- Reachability ---------------------------------------------------
  section("Infrastructure")
  let health: ApiResponse<Record<string, any>>
  try {
    health = await call("GET", "/v1/health")
  } catch (error) {
    console.error(
      `\n  ${RED}Could not reach ${args.api}.${RESET} ${error instanceof Error ? error.message : error}\n`,
    )
    process.exit(1)
  }

  if (health.status === 200) {
    const mode = health.body.mode
    pass("API reachable", `mode ${mode}`)
    if (mode === "DEMO") {
      console.log(
        `  ${YELLOW}NOTE${RESET}  This instance is in DEMO mode — results are not real verifications.`,
      )
    }
    const caps = health.body.capabilities ?? {}
    const live = Object.entries(caps).filter(([, v]) => v).length
    pass("Capabilities reported", `${live}/${Object.keys(caps).length} live`)
    if (!health.body.paymentRegistry?.available) {
      note("PaymentRegistry", health.body.paymentRegistry?.detail ?? "unavailable")
    } else {
      pass("PaymentRegistry deployed", health.body.paymentRegistry.address)
    }
  } else {
    fail("API reachable", `HTTP ${health.status}`)
  }

  // -- Authentication -------------------------------------------------
  section("Authentication")

  const noKey = await call("GET", "/v1/payments")
  noKey.status === 401
    ? pass("Rejects a request with no key", "401")
    : fail("Rejects a request with no key", `got ${noKey.status}`)

  const badKey = await call("GET", "/v1/payments", { key: `${args.key}tampered` })
  badKey.status === 401
    ? pass("Rejects a tampered key", "401")
    : fail("Rejects a tampered key", `got ${badKey.status}`)

  const readList = await call<{ data: unknown[] }>("GET", "/v1/payments", { key: args.key })
  let canRead = false
  if (readList.status === 200) {
    canRead = true
    pass("Key authenticates", `payments:read granted, ${readList.body.data?.length ?? 0} payment(s)`)
  } else if (readList.status === 403) {
    pass("Key authenticates", "payments:read not granted — correctly refused")
  } else if (readList.status === 401) {
    fail("Key authenticates", "401 — the key is not recognised by this deployment")
    summary()
    return
  } else {
    fail("Key authenticates", `HTTP ${readList.status}: ${readList.body.error?.message}`)
  }

  // -- Scopes ----------------------------------------------------------
  section("Scopes")

  const draft = {
    amount: "5.00",
    currency: "USD",
    acceptedAssets: ["XRP"],
    settlementAsset: "FXRP",
    orderId: `keycheck_${Date.now()}`,
  }

  const created = await call<{ id: string; paymentReference: string; status: string }>(
    "POST",
    "/v1/payments",
    { key: args.key, body: draft, idempotencyKey: draft.orderId },
  )

  let paymentId: string | undefined

  if (created.status === 201) {
    paymentId = created.body.id
    pass("payments:write", `created ${created.body.paymentReference} (${created.body.status})`)
  } else if (created.status === 403) {
    pass(
      "payments:write correctly refused",
      `requires ${created.body.error?.requiredScope}`,
    )
  } else {
    fail("payments:write", `HTTP ${created.status}: ${created.body.error?.message}`)
  }

  const settlements = await call("GET", "/v1/settlements", { key: args.key })
  if (settlements.status === 200) pass("settlements:read", "granted")
  else if (settlements.status === 403) pass("settlements:read correctly refused", "scope not held")
  else fail("settlements:read", `HTTP ${settlements.status}`)

  const webhooks = await call("GET", "/v1/webhooks", { key: args.key })
  if (webhooks.status === 200) pass("webhooks:read", "granted")
  else if (webhooks.status === 403) pass("webhooks:read correctly refused", "scope not held")
  else fail("webhooks:read", `HTTP ${webhooks.status}`)

  // A key must never be able to mint another key, whatever scopes it holds.
  const keyMgmt = await call("GET", "/v1/api-keys", { key: args.key })
  keyMgmt.status === 401
    ? pass("Cannot manage API keys", "key management requires a signed-in session")
    : fail("Cannot manage API keys", `got ${keyMgmt.status} — a key should never manage keys`)

  // -- Behaviour -------------------------------------------------------
  if (paymentId) {
    section("Payment behaviour")

    const replay = await call<{ id: string }>("POST", "/v1/payments", {
      key: args.key,
      body: draft,
      idempotencyKey: draft.orderId,
    })
    replay.body.id === paymentId
      ? pass("Idempotency", "same key + body returned the same payment")
      : fail("Idempotency", `got a different payment (${replay.body.id})`)

    const conflict = await call("POST", "/v1/payments", {
      key: args.key,
      body: { ...draft, amount: "99.00" },
      idempotencyKey: draft.orderId,
    })
    conflict.status === 409
      ? pass("Idempotency conflict", "same key + different body rejected with 409")
      : fail("Idempotency conflict", `expected 409, got ${conflict.status}`)

    const statusAttempt = await call<{ status: string }>("POST", "/v1/payments", {
      key: args.key,
      body: { ...draft, orderId: `keycheck_status_${Date.now()}`, status: "settled" },
    })
    statusAttempt.body.status === "created"
      ? pass("Client cannot set status", `ignored, payment is "${statusAttempt.body.status}"`)
      : fail("Client cannot set status", `payment came back as "${statusAttempt.body.status}"`)

    const routes = await call<{ data: any[]; recommended?: string }>(
      "GET",
      `/v1/payments/${paymentId}/routes`,
    )
    if (routes.status === 200) {
      const available = routes.body.data.filter((r) => r.status === "available")
      pass(
        "Routing engine",
        `${available.length}/${routes.body.data.length} route(s) available`,
      )
      for (const route of routes.body.data) {
        const mark = route.status === "available" ? GREEN : DIM
        console.log(
          `        ${mark}${route.sourceAsset.padEnd(6)}${RESET} ${DIM}${route.status.padEnd(12)}` +
            `${route.estimatedInputAmount} → ${route.destinationAsset ?? "-"}${RESET}`,
        )
        if (route.unavailableReason) {
          console.log(`        ${DIM}       ${route.unavailableReason.slice(0, 80)}${RESET}`)
        }
      }
    } else {
      fail("Routing engine", `HTTP ${routes.status}`)
    }

    const invalid = await call("POST", "/v1/payments", {
      key: args.key,
      body: { ...draft, acceptedAssets: ["DOGE"], orderId: `keycheck_bad_${Date.now()}` },
    })
    invalid.status === 400 && invalid.body.error?.code === "ASSET_UNSUPPORTED"
      ? pass("Rejects unsupported assets", "DOGE refused — not silently accepted")
      : fail("Rejects unsupported assets", `expected 400 ASSET_UNSUPPORTED, got ${invalid.status}`)

    console.log(`\n  ${DIM}Checkout for the payment just created:${RESET}`)
    console.log(`  ${DIM}${args.api.replace(/\/$/, "")} → payment ${paymentId}${RESET}`)
  } else if (canRead) {
    note("Payment behaviour", "key lacks payments:write, so nothing was created")
  }

  summary()
}

function summary() {
  console.log(`\n${"═".repeat(64)}`)
  const verdict =
    failed === 0
      ? `${GREEN}${passed} passed${RESET} — this key is working`
      : `${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`
  console.log(`  ${verdict}`)
  console.log(`${"═".repeat(64)}\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`\n  ${RED}Verification crashed:${RESET}`, error)
  process.exit(1)
})
