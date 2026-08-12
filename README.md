# PayFlux

**One payment API for assets across chains.**

A customer pays with XRP on XRPL. Flare's Data Connector independently verifies it. The merchant
is settled in FXRP on Coston2. One integration, no chain-specific code.

```ts
const payment = await payflux.payments.create({
  amount: "50.00",
  currency: "USD",
  acceptedAssets: ["XRP", "FXRP", "C2FLR"],
  settlementAsset: "FXRP",
})
```

Testnet only — Flare Coston2 and XRPL Testnet.

---

## Run it

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

## Try it

```bash
npm run xrpl:fund                              # a funded XRPL testnet wallet
npm run dev:api && npm run dev
```

Open `/store` → buy something → choose XRP → pay with:

```bash
npx tsx scripts/xrpl/pay.ts <paymentId> --seed sEd...
```

Watch it at `/status/<paymentId>`. Around 3–4 minutes, dominated by the FDC voting round.

Other scripts:

```bash
npm run poc:check                    # read-only: prices, FAssets params, contracts
npm run verify:key -- sk_ctn2_...    # exercise an API key end to end
```

---

## Deploy

**Backend → Render** (root directory blank — it's an npm workspace):

```
Build:  npm install --legacy-peer-deps && npm run build --workspace @payflux/backend
Start:  node backend/dist/index.js
Health: /v1/health
```

**Frontend → Vercel**: root `./`, install command `npm install --legacy-peer-deps`.

Then set `ALLOWED_ORIGINS` on Render to your Vercel origin, add that domain to Firebase
→ Authentication → Authorized domains, and run `firebase deploy --only firestore`.

---

## Layout

```
app/            Next.js — landing, docs, checkout, status, dashboard, demo store
backend/        Express API
contracts/      PaymentRegistry.sol
packages/sdk/   @payflux/node
scripts/        PoC, XRPL payer, key verifier
```

---

## Tests

```bash
npm test                # backend — 93 tests
npm run test:contracts  # PaymentRegistry — 20 tests
```

---

## Docs

**[PAYFLUX.md](PAYFLUX.md)** — the full blueprint: architecture, verification, settlement,
routing, keys, security, and an honest list of what is and isn't real.

Or read it in the app at **`/docs`**.

Deeper dives: [api](docs/api.md) · [architecture](docs/architecture.md) ·
[fdc-flow](docs/fdc-flow.md) · [settlement-flow](docs/settlement-flow.md) ·
[payment-routing](docs/payment-routing.md) · [auth-and-api-keys](docs/auth-and-api-keys.md)
