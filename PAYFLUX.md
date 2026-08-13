# PayFlux — Blueprint

**The asset-agnostic payment infrastructure layer for interoperable assets.**

Built on Flare Coston2 and XRPL Testnet. This document is the complete picture: what the product
is, how each part works, what is real, and what is not.

---

## Contents

1. [The problem](#1-the-problem)
2. [The abstraction](#2-the-abstraction)
3. [Who does what](#3-who-does-what)
4. [System architecture](#4-system-architecture)
5. [The payment lifecycle](#5-the-payment-lifecycle)
6. [Verification](#6-verification)
7. [Settlement](#7-settlement)
8. [Routing and pricing](#8-routing-and-pricing)
9. [Accounts, keys and scopes](#9-accounts-keys-and-scopes)
10. [Data model](#10-data-model)
11. [Security](#11-security)
12. [Deployment](#12-deployment)
13. [What is real, and what is not](#13-what-is-real-and-what-is-not)
14. [Design decisions worth defending](#14-design-decisions-worth-defending)
15. [Extending it](#15-extending-it)

---

## 1. The problem

A merchant who wants to accept XRP today integrates the XRPL SDK, writes a transaction watcher,
handles validation and reorgs, builds reconciliation — then does all of it again for the next
chain. Integration cost scales with the number of ecosystems, not the number of customers.

Meanwhile the merchant does not want XRP. They want a price in dollars and a balance in something
they chose.

PayFlux is the layer in between.

---

## 2. The abstraction

```
Source asset                            Settlement asset
Source chain     ────► PayFlux ────►    Settlement chain
```

The merchant writes this and nothing else:

```ts
const payment = await payflux.payments.create({
  amount: "50.00",
  currency: "USD",
  acceptedAssets: ["XRP", "FXRP", "C2FLR"],
  settlementAsset: "FXRP",
})
```

No XRPL SDK. No FDC client. No FAssets lot arithmetic. No transaction watcher. No wallet
connection — a merchant accepting payments never signs anything.

The API stays constant as chains are added underneath. Adding a chain means adding an adapter,
not rewriting the payment engine.

---

## 3. Who does what

Getting this boundary right is the difference between using Flare and name-dropping it.

| Component | Responsibility | What it is **not** |
| --- | --- | --- |
| **XRPL** | Settles the customer's XRP transfer, records it in a validated ledger | Not aware of PayFlux |
| **FDC** | Produces attestations — signed, Merkle-committed statements that an external-chain fact is true | **Not a bridge.** Moves no value |
| **FAssets** | Mints FXRP against real XRP locked with a collateralised agent | **Not a wrapper contract.** There is no "convert" endpoint |
| **FTSOv2** | Publishes decentralised price feeds on-chain | Not an exchange |
| **PaymentRegistry** | Records verified payments after re-verifying the FDC proof itself | Not a custodian — holds no funds |
| **PayFlux** | Intents, routing, quoting, matching, reconciliation, settlement orchestration, merchant API | Not a chain, not a liquidity provider |

The consequence that matters: **PayFlux cannot make a payment look verified.** The registry
re-checks every proof against Flare's own `FdcVerification` contract, and PayFlux has no way to
forge one.

---

## 4. System architecture

```
                          ┌────────────────────┐
                          │      MERCHANT      │
                          └─────────┬──────────┘
                                    │  payflux-sdk
                                    ▼
                          ┌────────────────────┐
                          │    EXPRESS API     │
                          └─────────┬──────────┘
                                    │
           ┌────────────────┬───────┴────────┬─────────────────┐
           ▼                ▼                ▼                 ▼
     Payment Engine   Routing Engine   Verification      Settlement
     (state machine)  (score + gate)   Engine            Engine
           │                │                │                 │
           │                │                ▼                 ▼
           │                │          XRPL + FDC        FAssets / native
           │                │                │                 │
           └────────────────┴────────┬───────┴─────────────────┘
                                     ▼
                              Coston2 · PaymentRegistry
                                     │
                          ┌──────────┴──────────┐
                          ▼                     ▼
                    Firestore              Webhooks + SSE
```

### Repository layout

```
app/                    Next.js — landing, docs, checkout, status, dashboard, demo store
components/payflux/     Shared UI
lib/payflux/            Typed API client, SSE hook, formatting
backend/                Express API
  src/payments/         Payment engine + verification orchestration
  src/verification/     FDC client, XRPL, Coston2 native, proof handling
  src/settlement/       Settlement providers
  src/routing/          Router and scoring
  src/chain/            Provider, contract registry, FAssets, PaymentRegistry
  src/auth/             Google sign-in, API keys
contracts/              PaymentRegistry.sol + Hardhat + tests
packages/sdk/           payflux-sdk
scripts/                PoC, XRPL payer, key verifier
```

### Background workers

| Worker | Interval | Job |
| --- | --- | --- |
| XRPL watcher | 6s | Detect XRP payments to any merchant address |
| Coston2 watcher | 8s | Detect FXRP/C2FLR payments |
| FDC finalization sweeper | 20s | Complete payments whose attestation round has finalized |
| Webhook sweeper | 15s | Retry failed deliveries with backoff |
| Expiry sweeper | 30s | Expire unpaid intents, after a final chain re-check |

---

## 5. The payment lifecycle

```
created → awaiting_payment → payment_detected → verifying → verified → settling → settled
                                                     │
                                          partially_paid / overpaid
                                                     │
                                            failed / expired / refunded
```

Every status change funnels through one function, which enforces the transition, writes an
immutable event, publishes to the SSE stream and fires the merchant webhook.

**No API route accepts a status from a client.** A status is always the *consequence* of an
observed fact — a detected transaction, a finalized attestation, a confirmed settlement.

`partially_paid` can be topped up; it can never reach `settled` directly. Underpayment is never
rounded into success.

### The full XRP flow

```
1.  Merchant     payflux.payments.create({ amount: "50.00", ... })
2.  Customer     picks XRP at checkout
3.  PayFlux      reserves FAssets collateral            → Coston2 tx
                 (agent's XRPL address + reference)
4.  PayFlux      commits the intent on PaymentRegistry  → Coston2 tx
5.  Customer     sends XRP to the agent, with the memo  → XRPL tx
6.  PayFlux      detects it (watcher, ~6s)
7.  PayFlux      requests an FDC attestation            → Coston2 tx
8.  FDC          voting round finalizes                 (~2 min)
9.  PayFlux      retrieves the Merkle proof
10. PayFlux      matches it against the intent
11. PayFlux      submits it to PaymentRegistry          → Coston2 tx
                 (the contract re-verifies the proof)
12. PayFlux      submits the same proof to executeMinting → Coston2 tx
13. FXRP         minted, delivered to the merchant
14. Merchant     receives a signed webhook
```

Roughly 3–4 minutes end to end, dominated by the FDC round. That wait is the cost of a
trust-minimised proof, not slowness.

---

## 6. Verification

Two mechanisms behind one call, dispatched on the asset the customer chose.

### XRP — external chain, FDC attestation

```
XRPL tx hash
   │
   ├─ prepareRequest (verifier server)  → ABI-encoded attestation request
   ├─ requestAttestation (FdcHub)       → enters a voting round
   ├─ wait for finalization             → providers vote, Merkle root relayed
   ├─ proof-by-request-round (DA layer) → Merkle proof + attested response
   └─ registerVerifiedPayment           → contract calls FdcVerification.verifyPayment
```

Every Flare contract is resolved through the **Flare Contract Registry** at
`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` — never hardcoded — so the integration survives
contract upgrades. The Solidity does the same via `ContractRegistry.getFdcVerification()`.

The verifier needs an `X-API-KEY`. Flare publishes an open key for the testnet verifier
(`00000000-0000-0000-0000-000000000000`); PayFlux defaults to it.

### FXRP / C2FLR — this chain, direct read

Coston2 *is* the chain PayFlux runs on, so there is nothing to attest. The transaction and its
receipt are read directly, checked for destination, amount, status and confirmations, then
recorded via `recordNativePayment` — role-gated and tagged `FLARE_NATIVE` so it is never confused
with an FDC-verified cross-chain payment.

### Binding a transfer to an intent

Matching on **sender address** breaks the moment a customer pays from an exchange or pays twice.

| Asset | Binding |
| --- | --- |
| XRP | XRPL standard payment reference — a 32-byte memo FDC itself decodes and reports |
| C2FLR | Transaction calldata carrying the reference |
| FXRP | (destination, exact amount, time window) — ERC-20 `transfer` has no memo field |

FXRP is the weak case, and it is handled honestly: when two open intents expect an
indistinguishable amount, the matcher **refuses to guess** and asks for a transaction hash.
Crediting the wrong order is worse than asking.

### The client's transaction hash is a hint, never evidence

`POST /v1/payments/:id/verify` accepts `transactionHashHint`. The name is the contract. For XRP it
only narrows which transaction to attest; the payment's fate is decided by the attested data. For
native assets it is settled completely against the chain — the same authority a contract would
have.

### Reconciliation

A tolerance band (default 50 bps) absorbs the rounding unavoidable when converting fiat to a
volatile asset. Outside the band:

```
received < expected − tolerance   →  partially_paid   (never "paid")
received > expected + tolerance   →  overpaid         (excess recorded, settles normally)
```

The contract enforces the floor with **no tolerance at all** — an underpayment reverts. Off-chain
leniency, on-chain strictness.

---

## 7. Settlement

### The constraint that shapes everything

FXRP is not a wrapper PayFlux can mint on demand. FAssets minting is a three-party protocol:

1. A minter reserves collateral against an **agent**, paying a fee in C2FLR. The AssetManager
   responds with the agent's XRPL address and a payment reference.
2. The minter sends the underlying XRP to **that address** with **that reference**.
3. Anyone submits an FDC `Payment` attestation of step 2 to `executeMinting`, and FXRP is minted.

There is no "XRP in, FXRP out" endpoint. Inventing one would be fiction.

So PayFlux does not bolt a conversion onto the side of the payment. It makes the customer's
payment **be** the FAssets minting payment: the reservation happens when the customer picks XRP,
the checkout shows the agent's address and reference, and the single attestation of that one
transfer is used twice — once for PaymentRegistry, once for `executeMinting`.

The customer's XRP literally becomes the backing for the minted FXRP.

### The cost: lot quantisation

FAssets mints whole lots. Coston2 lot size is currently **10 XRP** (read live, never hardcoded).
A $5 payment becomes 10 XRP plus the agent's fee. PayFlux surfaces this as `priceImpact` on the
route card rather than absorbing it.

### Providers

| Provider | Path | Notes |
| --- | --- | --- |
| `fassets-mint` | XRP → FXRP | Real minting. Availability depends on live agent capacity |
| `flare-native` | FXRP → FXRP, C2FLR → C2FLR | The payment *is* the settlement; confirms the balance moved |

Deliberately absent: `XRP → USDT0`. PayFlux has no swap infrastructure and no liquidity source.
`quoteSettlement` returns *"No settlement provider implements X → Y. PayFlux does not invent
conversion routes."*

### "Settled" means

1. A confirmed transaction, **and**
2. the merchant's balance actually increased.

There is no code path anywhere that sets a settlement to `completed` without a transaction hash.
When the merchant *is* the minting account, the mint already credited them and no forwarding
transfer is attempted — but the balance check still runs.

---

## 8. Routing and pricing

### Supported ≠ available

**Supported** — PayFlux implements the whole path. A static property of the codebase.
**Available** — it can execute *right now*. Re-answered on every checkout against live state.

```
XRP → FXRP
Supported:      YES
Available now:  NO
Reason:         No agent currently has 5 free lots (best available: 2)
```

Better than a shorter list, and far better than a route that fails after funds are sent.

### Scoring

```
score = 100
      − 25 if degraded
      − 15 if no settlement path
      − (feeBps / 10),   capped at 20
      − (seconds / 20),  capped at 15
      + 8 if FDC-verified
      − 5 if price impact
```

Executability dominates: an unavailable route is never recommended, whatever its fee. Cross-chain
verification earns a bonus despite being slower — a trust-minimised proof is a stronger guarantee
than a same-chain transfer, and the ranking should say so.

Every route carries `reasons[]`, rendered verbatim at checkout. An opaque ranking shown next to a
"Why this route?" panel would be worse than no ranking.

### Pricing

Rates come from **FTSOv2 feeds read on Coston2** — `XRP/USD`, `FLR/USD`. There is no hardcoded
fallback anywhere in the pricing module. If a feed cannot be read, quoting fails and the route is
reported unavailable. A wrong price is worse than no price when someone is about to send value.

Arithmetic is integer at feed precision. A 30 bps spread is disclosed as `fee`, not folded into
the rate. Quotes expire in 5 minutes.

---

## 9. Accounts, keys and scopes

### Two credentials, not interchangeable

| Credential | Holder | Can do |
| --- | --- | --- |
| Firebase ID token | A person, in a browser | Manage keys, settings, audit log, view dashboard |
| API key `sk_ctn2_…` | A server | Create/read payments, settlements, webhooks |

An API key **cannot mint another API key** — that would let anyone holding a leaked key issue
themselves a fresh one and survive the rotation meant to lock them out. A session cannot create
payments.

### Sign-up

There is no sign-up form. A first Google sign-in provisions the account. The API verifies the ID
token against Google's keys via `firebase-admin`; it never trusts a uid or email from the client.

A new account starts with **no settlement addresses**. Inheriting the deployment's would be
convenient and quietly wrong — a developer who never opens Settings would have their customers pay
the *operator*. Blank means the routes report themselves unavailable, naming the setting to fill in.

### Key format

```
sk_ctn2_a1b2c3d4e5f6a7b8_XmR3nQ7...
└┬┘ └─┬┘ └──────┬───────┘ └──┬──┘
 │    │         │            └── 32 random bytes, base64url
 │    │         └─────────────── key id: public lookup handle
 │    └───────────────────────── environment
 └────────────────────────────── secret key marker
```

Embedding the id makes verification one indexed lookup rather than a scan. Stored as SHA-256 and
compared in constant time — these are 256-bit CSPRNG secrets, so a slow KDF would only add latency
without adding security.

Shown exactly once. There is no endpoint that reveals an existing key, because the server does not
have it.

### Scopes

`payments:read` · `payments:write` · `settlements:read` · `settlements:write` ·
`webhooks:read` · `webhooks:write`

No management scope exists. Omitting scopes on create grants `payments:read` + `payments:write` —
the minimum to accept a payment, not full access. A denial returns `403 INSUFFICIENT_SCOPE` naming
the required scope, and is written to the audit log.

Keys issued before scopes existed are grandfathered as full access and badged `Legacy` — silently
narrowing them would break working integrations. Rotating one applies real scopes.

### Rotation

```
rotate(A, graceHours: 24)

during:  [A: rotating, expires in 24h]  ← still works
         [B: active]                     ← works
                   ↑ deploy B, confirm traffic moved
after:   [A: expired]  [B: active]
```

The grace window is the point. Without it there is a moment where production authenticates with a
dead key, and rotation becomes something teams avoid. `graceHours: 0` revokes immediately, for a
leak.

### Audit log

Append-only. Sign-ins, key creation/rotation/revocation, denied scopes, settings changes — with
actor, request id and client IP. Secrets never appear: a webhook secret change is logged as *the
field having changed*, never its value.

### Limits

| Limit | Default | Why |
| --- | --- | --- |
| Keys per account | 5 | — |
| Rotation grace | 24h | Deploy window |
| Open FAssets reservations per account | 3 | Each costs the operator ~1.7 C2FLR, non-refundable if unpaid |
| Operating C2FLR reserve | 5 | Reservations must not consume the gas verification needs |
| Rate limit | 120/min per key | — |

---

## 10. Data model

Firestore when credentials are present, in-memory otherwise. Same interface; the API and tests run
without external services.

```
accounts          developer accounts (Google)
apiKeys           key records — digests only, never secrets
auditEvents       append-only account trail
users             merchants and settlement preferences
payments          payment intents
paymentEvents     immutable per-payment audit trail
settlements       settlements with real transaction hashes
webhookDeliveries delivery attempts, retries, failures
idempotencyKeys   request hash → stored response
```

Five composite indexes are required (`firestore.indexes.json`). Firestore fails these at *runtime*
with `FAILED_PRECONDITION`, not at deploy.

---

## 11. Security

**Firestore rules deny every client request.** No browser talks to Firestore — the client uses
Firebase for sign-in only, and all data access goes through the API with the Admin SDK, which
bypasses rules. Locking clients out costs nothing and guarantees payment data, key digests and
audit trails can never be read from a browser.

Authorisation lives in three server-side places:

| Layer | Decides |
| --- | --- |
| API keys + scopes | What an integration may call |
| Firebase sessions | Who a person is |
| `merchantId === accountId` | Whose data is returned |

Other controls: helmet, per-origin CORS (never wildcard with credentials), zod validation on every
body, idempotency keys, request ids, signed webhooks with replay-bounded timestamps, constant-time
key comparison, role-gated contract writes.

**Never stored:** private keys, seed phrases, raw API secrets. The Coston2 signer lives only in the
API process — never in Firestore, never sent to the browser.

The real blast radius is the service account and the signer key, not the rules file.

---

## 12. Deployment

**Backend → Render.** Root directory blank (npm workspace).

```
Build:  npm install --legacy-peer-deps && npm run build --workspace @payflux/backend
Start:  node backend/dist/index.js
Health: /v1/health
```

**Frontend → Vercel.** Root `./`, install command `npm install --legacy-peer-deps`.

Then: set `ALLOWED_ORIGINS` on Render to the Vercel origin, add the Vercel domain to Firebase
Authorized domains, and `firebase deploy --only firestore`.

The API refuses to start if the network configuration is inconsistent — mixing Coston and Coston2,
or testnet and mainnet, is the easiest way to produce convincing but meaningless data.

**Free-tier caveat:** Render sleeps after 15 minutes and the workers sleep with it. State is
persisted, so a sleeping instance resumes rather than losing a payment — but a stalled verification
mid-demo is a bad look.

---

## 13. What is real, and what is not

| Capability | Status |
| --- | --- |
| XRPL Testnet payment detection | **Real** |
| FDC `Payment` attestation (testXRP) | **Real** — prepare → submit → round → proof |
| On-chain proof verification | **Real** — the contract calls `FdcVerification.verifyPayment` |
| Payment recorded on Coston2 | **Real** — publicly readable |
| USD pricing | **Real** — FTSOv2. No fallback |
| FAssets parameters | **Real** — read per request |
| FXRP minting and settlement | **Real** — proven end to end |
| Native Coston2 verification | **Real** |
| BTC / DOGE | **Not supported** — listed as unsupported |

Verified end to end on Coston2:

```
$5.00 USD
CRT 48221628 · agent 0xd5dEFe2c62D48788BB3889534FBFe7Aea0602D64
reserve tx    0xef645dc91a6fd7705e8a9f4d26f4d4feec56e9395ae3deb592cc8d77c96efd3a
customer paid 10.025 XRP → the agent's XRPL address
XRPL tx       0x5a3be1f814465d32a979ffeca92d830b5b8df39570dc29176b8f7c2e0b7d3b38
registry tx   0x87baf3160c4e6bd5b32a2680f9f87de521bc29f5672f2d216a548fd22c82e2ad
settlement    0x4953c4907ef5ea4d2ccae920489616981a9278a7c3036ec13cbf9c8d2314168e
status: settled · 10.0 FXRP delivered
```

Anything not configured reports **UNAVAILABLE** at `/dashboard/diagnostics` with the reason.
Nothing degrades into plausible-looking fake data.

There is a `PAYFLUX_DEMO_MODE` switch for offline UI work. It is refused in production, every
response it touches is labelled `DEMO`, and it must not be used for a verification demo.

### Known limitations

1. **Team accounts** — one account, one human. No invites or roles.
2. **FXRP payment matching** is amount-based and refuses ambiguity rather than resolving it.
3. **Single-instance SSE and signer.** The event bus is in-process; the signer serializes writes
   through an in-process queue. Multiple instances would need Redis pub/sub and either a
   distributed lock or a per-instance signer.
4. **Watchers cap at 25 addresses**, loudly.
5. **`ReferencedPaymentNonexistence` is not wired up.** Expiry uses the server clock plus a final
   chain re-check. Making non-payment *provable* is the natural next step.
6. **No key rotation reminders, audit retention policy, or export.**
7. **Audit events for key operations are written at the route layer**, not in the service.

---

## 14. Design decisions worth defending

**The customer pays the FAssets agent, not the merchant.** For the XRP route this is not a
shortcut — it is the only shape FAssets will mint against. The merchant is made whole in FXRP on
Coston2, which is what they asked for.

**The registry commits the merchant's expectation before the customer pays.** The backend states
the expectation; Flare's attestation providers state the fact. Neither can produce a verified
payment alone.

**Underpayment is never rounded into success.** Off-chain tolerance absorbs conversion rounding;
the contract enforces a hard floor.

**Routes are gated on live executability**, not on whether the code exists.

**New accounts inherit nothing.** Convenience is not worth silently routing a developer's revenue
to the operator.

**Secrets are shown once.** The server keeps only digests, so "resend my key" is not a feature that
can exist.

---

## 15. Extending it

Adding BTC:

1. Add the asset to `registry/assets.ts`, disabled.
2. Implement a watcher — detect only, never decide.
3. Point the FDC service at the `testBTC` source id; the `Payment` attestation type is unchanged.
4. Implement a `SettlementProvider` for the destination asset.
5. Add a route builder.
6. Enable the asset.

The payment engine, state machine, API, SDK, webhooks and dashboard need no changes. That is the
test of whether the abstraction is real.

---

## Reference

| Doc | Covers |
| --- | --- |
| [docs/api.md](docs/api.md) | Endpoint reference |
| [docs/architecture.md](docs/architecture.md) | Component boundaries |
| [docs/fdc-flow.md](docs/fdc-flow.md) | Attestation round trip |
| [docs/settlement-flow.md](docs/settlement-flow.md) | FAssets minting |
| [docs/payment-routing.md](docs/payment-routing.md) | Scoring and availability |
| [docs/auth-and-api-keys.md](docs/auth-and-api-keys.md) | Sign-in, keys, scopes, audit |

Testnet only — Flare Coston2 (chain ID 114) and XRPL Testnet.
