# PayFlux

**One payment API for assets across chains.**

A customer pays with XRP on XRPL. Flare's Data Connector independently verifies it. You are
settled in FXRP on Coston2. One integration, no chain-specific code — no XRPL SDK, no FDC client,
no transaction watcher, no wallet connection.

Testnet only — Flare Coston2 (chain 114) and XRPL Testnet.

---

## Quickstart

### 1. Get an API key

Sign in at `/sign-in` with Google, then **Dashboard → API keys → Create key**. You get a secret
once:

```
sk_ctn2_a1b2c3d4e5f6a7b8_XmR3nQ7...
```

It is shown exactly once, because the server only stores a SHA-256 digest. There is no endpoint
that can reveal it later — if you lose it, rotate.

Check it works before writing any code:

```bash
npm run verify:key -- sk_ctn2_... --api https://your-api-host
```

### 2. Install the SDK

```bash
npm install payflux-sdk
```

[![npm](https://img.shields.io/npm/v/payflux-sdk)](https://www.npmjs.com/package/payflux-sdk)
Zero runtime dependencies. **ESM only** — use `import`, not `require`. Node 20+.

Or skip it entirely — it is a thin wrapper over REST, and every example below has a plain
`fetch` equivalent:

```bash
curl -X POST https://your-api-host/v1/payments \
  -H "X-API-Key: sk_ctn2_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order_1001" \
  -d '{"amount":"50.00","currency":"USD","acceptedAssets":["XRP"],"settlementAsset":"FXRP"}'
```

### 3. Create a payment

```ts
import PayFlux from "payflux-sdk"

const payflux = new PayFlux({
  apiKey: process.env.PAYFLUX_SECRET_KEY!,
  baseUrl: "https://your-api-host",
})

const payment = await payflux.payments.create({
  amount: "50.00",
  currency: "USD",
  acceptedAssets: ["XRP", "FXRP", "C2FLR"],
  settlementAsset: "FXRP",
  orderId: "order_1001",
  // Safe to retry: the same key returns the same payment rather than creating a second one.
  idempotencyKey: "order_1001",
})
```

### 4. Send the customer to checkout

```ts
redirect(`https://your-app/checkout/${payment.id}`)
```

The hosted checkout at `/checkout/[id]` handles asset choice, live FTSOv2 pricing, the payment
instructions and the progress rail. **Your customer never connects a wallet to you, and you never
handle a private key.**

Building your own UI instead? Everything it needs is on the payment:

```ts
payment.paymentInstructions  // destinationAddress, amount, memoDataHex
payment.links.status         // customer-facing status page
await payflux.payments.routes(payment.id)  // live routes, scored, with reasons[]
```

### 5. Get told when it settles

```ts
// app/api/webhooks/payflux/route.ts
import { verifyWebhookSignature } from "payflux-sdk"

export async function POST(request: Request) {
  const raw = await request.text()          // the raw body — parsing first breaks the signature
  const signature = request.headers.get("X-PayFlux-Signature") ?? ""

  const { valid, reason } = verifyWebhookSignature(
    signature,
    raw,
    process.env.PAYFLUX_WEBHOOK_SECRET!,
  )
  if (!valid) return new Response(reason, { status: 400 })

  const event = JSON.parse(raw)
  if (event.type === "payment.settled") {
    await fulfilOrder(event.orderId)   // your own id, echoed back from create()
  }

  return new Response("ok")
}
```

The payload is flat — `type`, `paymentId`, `orderId`, `status`, `amount`, `currency`,
`sourceAsset`, `settlementAsset`, `paymentReference`, `verification`, `settlement`,
`reconciliation`, `failureCode`, `metadata`. There is no nested `data` object.

Set the receiving URL as `MERCHANT_WEBHOOK_URL` on the API, and use the same secret on both sides.

That is the whole integration.

---

## The integration surface

| Call | Does |
| --- | --- |
| `payments.create(params)` | Create an intent. Honours `idempotencyKey` |
| `payments.retrieve(id)` | Current state |
| `payments.list(limit)` | Your payments, newest first |
| `payments.routes(id)` | Live routes with `status`, `score` and `reasons[]` |
| `payments.events(id)` | The immutable per-payment audit trail |
| `payments.verify(id, hash?)` | Ask PayFlux to re-check the chain. The hash is a *hint* |
| `payments.settle(id)` | Trigger settlement explicitly |
| `routes.preview(amount, assets)` | Quote before an intent exists |
| `settlements.quote(...)` / `.create(id)` / `.retrieve(id)` | Settlement lifecycle |
| `webhooks.list()` / `.test()` | Deliveries, and a signed test event |
| `health()` | What is actually live right now |
| `waitForPayment(id, opts)` | Poll to a terminal state |

`waitForPayment` resolves with the server's real view rather than sleeping and assuming — a
payment that fails resolves as failed instead of throwing after a fixed delay:

```ts
const settled = await payflux.waitForPayment(payment.id, {
  onUpdate: (p) => console.log(p.status),   // verifying → verified → settling → settled
})
```

In a browser, stream it instead of polling:

```ts
new EventSource(`${API}/v1/payments/${id}/stream`)
  .addEventListener("update", (e) => setPayment(JSON.parse(e.data).payment))
```

### Webhook events

`payment.created` · `detected` · `verifying` · `verified` · `confirmed` · `settling` ·
`settled` · `partially_paid` · `overpaid` · `failed` · `expired`

Signed `X-PayFlux-Signature: t=<unix>,v1=<hmac-sha256>` over `"{timestamp}.{rawBody}"`, compared
in constant time, with a 5-minute replay window. Always verify against the **raw** body.

### Two things that will save you an afternoon

**Underpayment is never rounded into success.** A short payment becomes `partially_paid`, which
can be topped up but can never reach `settled` directly. Check the status, not just for an absence
of errors.

**Supported ≠ available.** A route exists in code and *can execute right now* are different
questions. `routes()` reports both, with `unavailableReason` — so you can surface "no agent has
enough FXRP capacity" instead of failing after the customer has already sent funds.

---

## Run it locally

```bash
npm install --legacy-peer-deps
cp .env.example .env
cp .env.example .env.local

npm run dev:api    # API  → localhost:4000
npm run dev        # app  → localhost:3000
```

Works with an empty `.env` — everything unconfigured reports **UNAVAILABLE** at
`/dashboard/diagnostics` rather than pretending.

To take a real payment you need four values in `.env`:

| Variable | Where from |
| --- | --- |
| `COSTON2_PRIVATE_KEY` | a throwaway account, funded at [faucet.flare.network/coston2](https://faucet.flare.network/coston2) |
| `MERCHANT_XRPL_ADDRESS` | [faucet.altnet.rippletest.net/accounts](https://faucet.altnet.rippletest.net/accounts) |
| `MERCHANT_FLARE_ADDRESS` | same account as the signer is fine |
| `PAYMENT_REGISTRY_ADDRESS` | printed by `npm run contracts:deploy` |

The FDC verifier key is public and already defaulted. Every variable is annotated in
[`.env.example`](.env.example).

---

## Prove it works

All of these make real transactions on real testnets. Nothing is simulated.

```bash
npm run poc:check      # read-only: FTSOv2 prices, FAssets capacity, contracts. Sends nothing
npm run poc:fast       # C2FLR only — verified and recorded on Coston2        (~20s)
npm run poc:both       # C2FLR + a full FDC attestation of an XRP payment     (~3 min)
npm run poc:auto       # the full XRP path including the FXRP mint            (~4 min)
```

`poc:fast` is quick because C2FLR is native to Coston2 and needs no attestation — the transaction
is read directly. The three minutes in the others is the FDC voting round: providers voting and a
Merkle root being relayed. That wait is the cost of a trust-minimised proof, not slowness.

Reuse an XRPL payment you already made instead of sending another:

```bash
npm run poc:both -- --tx <XRPL_TX_HASH>
```

Or drive the product end to end by hand:

```bash
npm run xrpl:fund                            # a funded XRPL testnet wallet
npm run xrpl:pay -- <paymentId>              # pays an intent, with the 32-byte memo
npm run verify:key -- sk_ctn2_...            # exercise an API key end to end
```

There is also a **Playground** in the dashboard: paste a key, watch it authenticate against the
live API. The key goes from your browser straight to the API and never to the website's server.

---

## Deploy

**Backend → Railway.** Settings → Source → **Root Directory = `backend`**. Nixpacks then reads
`build` and `start` from `backend/package.json` with nothing else to configure. Set the variables
*before* the first deploy — the boot sequence validates config and exits rather than starting
misconfigured.

**Frontend → Vercel.** Root Directory `./` — not `app/`. The root install resolves the
`payflux-sdk` workspace that `next.config.mjs` transpiles from source.

Then, and only once both URLs exist:

1. `ALLOWED_ORIGINS` on the API → your Vercel origin. Exact scheme and host, no trailing slash;
   the check is strict list membership with no wildcards.
2. Firebase → Authentication → **Authorized domains** → add the Vercel domain.
3. `MERCHANT_WEBHOOK_URL` → your webhook route, with matching secrets on both sides.
4. `firebase deploy --only firestore`.

Keep it at **one replica**. Correctness does not depend on it — finalization is guarded by a
compare-and-set claim and the registry refuses duplicate registrations — but every replica runs
its own chain watchers, which is wasted polling against the same addresses.

---

## Layout

```
app/            Next.js — landing, docs, checkout, status, dashboard, demo store
backend/        Express API
contracts/      PaymentRegistry.sol
packages/sdk/   payflux-sdk
scripts/        proofs of concept, XRPL payer, key verifier
```

---

## Tests

```bash
npm test                # backend — 123 tests
npm run test:contracts  # PaymentRegistry
```

---

## Docs

**[PAYFLUX.md](PAYFLUX.md)** — the full blueprint: architecture, verification, settlement,
routing, keys, security, and an honest list of what is and isn't real.

Or read it in the app at **`/docs`**.

Deeper dives: [api](docs/api.md) · [architecture](docs/architecture.md) ·
[fdc-flow](docs/fdc-flow.md) · [settlement-flow](docs/settlement-flow.md) ·
[payment-routing](docs/payment-routing.md) · [auth-and-api-keys](docs/auth-and-api-keys.md)
