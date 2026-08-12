# API reference

Base URL: `http://localhost:4000`  ·  All endpoints under `/v1`.

Two credentials, not interchangeable:

- **`X-API-Key: sk_ctn2_…`** — integrations. Payments, settlements, webhooks, subject to scopes.
- **`Authorization: Bearer <firebase-id-token>`** — a signed-in developer. Key management,
  account settings and the audit log.

An API key cannot manage API keys or change settlement addresses, and a session cannot create
payments. See [auth-and-api-keys.md](auth-and-api-keys.md).

### Scopes

| Endpoint | Scope |
| --- | --- |
| `POST /v1/payments` | `payments:write` |
| `GET /v1/payments` | `payments:read` |
| `POST /v1/payments/:id/settle`, `POST /v1/settlements` | `settlements:write` |
| `GET /v1/settlements`, `/:id`, `POST /v1/settlements/quote` | `settlements:read` |
| `GET /v1/webhooks` | `webhooks:read` |
| `POST /v1/webhooks/test` | `webhooks:write` |

Customer-facing reads (`GET /v1/payments/:id`, `/routes`, `/events`, `/stream`, `select-asset`,
`verify`) are public and unscoped — a shopper holds no credential.

A missing scope returns `403 INSUFFICIENT_SCOPE` with `requiredScope`, and is recorded in the
audit log.

Customer-facing endpoints are public — a shopper has no credential of either kind.

---

## Conventions

**Errors**

```json
{
  "error": { "code": "ASSET_UNSUPPORTED", "message": "Asset \"DOGE\" is not supported…" },
  "requestId": "req_9f2c…"
}
```

**Request IDs** — every response carries `X-Request-ID`. Send your own to correlate logs.

**Idempotency** — send `Idempotency-Key` on `POST /v1/payments`. Same key + same body replays the
stored response with `Idempotent-Replay: true`. Same key + *different* body returns
`409 IDEMPOTENCY_KEY_REUSED` rather than a silently wrong answer.

**Status is never writable.** No endpoint accepts a payment status. Sending one is ignored.

---

## Payments

### `POST /v1/payments` · authenticated

```json
{
  "amount": "50.00",
  "currency": "USD",
  "acceptedAssets": ["XRP", "FXRP", "C2FLR"],
  "settlementAsset": "FXRP",
  "orderId": "order_1001",
  "metadata": { "product": "Developer Hoodie" },
  "expiresInSeconds": 900
}
```

`201` → a `PaymentIntent` with `id`, `paymentReference` (e.g. `pay_8F92K2`), `expiresAt` and
`links`.

Errors: `400 ASSET_UNSUPPORTED`, `422 VALIDATION_FAILED`, `409 IDEMPOTENCY_KEY_REUSED`.

### `GET /v1/payments/:id` · public

The payment intent, plus derived `links` (explorer URLs) and `paymentInstructions` once an asset
is chosen.

### `GET /v1/payments` · authenticated

`?limit=50` — the merchant's payments, newest first.

### `GET /v1/payments/:id/routes` · public

```json
{
  "data": [ { "id": "route_…", "status": "available", "score": 94, "reasons": [...] } ],
  "recommended": "route_…"
}
```

Recomputed live: prices from FTSOv2, settlement capacity from FAssets.

### `GET /v1/payments/:id/events` · public

The immutable audit trail — one record per state transition.

### `POST /v1/payments/:id/select-asset` · public

```json
{ "asset": "XRP" }
```

Locks a quote, writes the intent commitment to `PaymentRegistry` on Coston2, and returns the
payment with `paymentInstructions` (destination, amount, and the memo hex for XRPL).

Errors: `409 ROUTE_UNAVAILABLE` with the reason.

### `POST /v1/payments/:id/verify` · public

```json
{ "transactionHashHint": "A1B2…" }
```

The hint is **untrusted**. The backend re-derives everything from XRPL and FDC regardless, and
accepts the hint only if it independently satisfies every matching rule.

`202` → `{ "status": "pending" | "no_payment_found", "detail": "…", "payment": {...} }`
`409` → verification failed, with `payment.failureCode`.

Returns as soon as the attestation is submitted. The round takes minutes; watch the stream.

### `POST /v1/payments/:id/settle` · authenticated

Executes settlement for a verified payment. `409` if the payment is not verified;
`502 SETTLEMENT_FAILED` with the blocker if it cannot execute.

### `GET /v1/payments/:id/stream` · public · SSE

```js
const source = new EventSource("/v1/payments/pay_123/stream")
source.addEventListener("snapshot", (e) => { /* payment + events */ })
source.addEventListener("update",   (e) => { /* payment + new event */ })
```

Emits `snapshot` on connect, then `update` on every change. Heartbeat comment frames every 20s.

---

## Assets and routes

### `GET /v1/assets` · public

Every asset with `enabled`, `supportsPayment`, `supportsSettlement` and a `note` explaining any
limitation. Unimplemented assets appear with `supportsPayment: false` rather than being hidden.

### `GET /v1/routes?amount=50.00&currency=USD&assets=XRP,FXRP,C2FLR` · public

Route preview without creating a payment.

---

## Settlements

### `POST /v1/settlements/quote` · authenticated

```json
{ "paymentId": "pay_…", "sourceAsset": "XRP", "destinationAsset": "FXRP", "amount": "73.21" }
```

Returns `executable` and, when false, `blockers[]` — the concrete reasons.

### `POST /v1/settlements` · authenticated

```json
{ "paymentId": "pay_…" }
```

### `GET /v1/settlements` · `GET /v1/settlements/:id` · authenticated

---

## Webhooks

### `GET /v1/webhooks` · authenticated

Endpoint, whether a signing secret is configured (never the secret itself), and recent deliveries.

### `POST /v1/webhooks/test` · authenticated

Sends a signed `webhook.test` event to the configured endpoint.

### Events

```
payment.created        payment.detected       payment.verifying
payment.verified       payment.confirmed      payment.settling
payment.settled        payment.failed         payment.expired
payment.partially_paid payment.overpaid
settlement.created     settlement.completed   settlement.failed
```

### Signature

```
X-PayFlux-Signature: t=1754700000,v1=5257a869e7…
X-PayFlux-Delivery:  whd_…
```

HMAC-SHA256 over `` `${timestamp}.${rawBody}` ``. Verify with `verifyWebhookSignature` from
`@payflux/node`, against the **raw** body — a re-serialized object will not match.

Retries: 5s, 30s, 2m, 10m, 1h, then `failed`.

---

## API keys · signed-in developer only

All require `Authorization: Bearer <firebase-id-token>`. An API key is rejected here by design.

```
GET    /v1/api-keys/me            profile and settlement config
GET    /v1/api-keys               list + availableScopes + defaultScopes
POST   /v1/api-keys               create   { name, scopes? }
POST   /v1/api-keys/:id/rotate    rotate   { graceHours?, scopes? }   0 = revoke immediately
POST   /v1/api-keys/:id/revoke    revoke immediately
```

Omitting `scopes` on create gives `payments:read` + `payments:write`, not full access. Omitting
it on rotate inherits the predecessor's scopes.

`create` and `rotate` are the only responses that contain `secret`, and only once. Acting on
another account's key returns `404 API_KEY_NOT_FOUND` — the same as a key that does not exist, so
ids cannot be probed across accounts.

When Firebase is not configured these return `503 AUTH_UNAVAILABLE` naming the missing variables,
rather than failing obscurely.

---

## Account · signed-in developer only

```
GET    /v1/account/settings       settlement addresses, with `usingDefaults`
PATCH  /v1/account/settings       { xrplAddress?, flareAddress?, settlementAsset?, webhookUrl?, webhookSecret? }
GET    /v1/account/audit          append-only account audit trail  ?limit=100
```

A blank string clears a field back to the deployment default; omitting it leaves it unchanged.
`xrplAddress` is checked against XRPL Testnet on save — an address that does not exist returns
`422 XRPL_ACCOUNT_NOT_FOUND`, because an unfunded address can never receive a payment.

The webhook secret is write-only: `GET` reports `webhookSecretConfigured`, never the value.

---

## Diagnostics

### `GET /v1/health` · public

The honesty endpoint. Reports live capabilities, resolved FDC and FAssets contract addresses,
PaymentRegistry state, price-feed health and registered settlement providers. `mode` is `LIVE` or
`DEMO`.

The dashboard renders this verbatim at `/dashboard/diagnostics`. Anything not configured shows as
UNAVAILABLE with its reason.

---

## Rate limits

`RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` (default 120/min), keyed per API key when
authenticated and per IP otherwise, so one noisy merchant cannot starve another. Standard
`RateLimit-*` headers; `429 RATE_LIMITED` on exceed.

## CORS

Origins from `ALLOWED_ORIGINS` only. Never a wildcard — the API sets `credentials: true`.
Allowed headers: `Content-Type`, `Authorization`, `X-API-Key`, `X-Request-ID`, `Idempotency-Key`.
