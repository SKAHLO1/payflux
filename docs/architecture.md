# Architecture

## The problem

A merchant who wants to accept XRP today integrates the XRPL SDK, writes a transaction watcher,
handles reorgs and validation, builds their own reconciliation, and then does all of it again for
the next chain. The integration cost scales with the number of ecosystems, not with the number of
customers.

PayFlux collapses that into one interface:

```
Source asset            Settlement asset
Source chain     ─────► Settlement chain
                PayFlux
```

The API stays constant while the chains underneath change. Adding a chain means adding an
adapter, not rewriting the payment engine.

---

## Who does what

Getting this boundary right is the difference between using Flare and name-dropping it.

| Component | Responsibility | What it is *not* |
| --- | --- | --- |
| **XRPL** | Settles the customer's XRP transfer and records it in a validated ledger | Not aware of PayFlux |
| **FDC** | Produces attestations: signed, Merkle-committed statements that an external-chain fact is true | **Not a bridge.** It moves no value |
| **FAssets** | Mints FXRP against real XRP locked with an agent, under collateral | **Not a wrapper contract.** There is no "convert" endpoint |
| **FTSOv2** | Publishes decentralised price feeds on-chain | Not an exchange |
| **PaymentRegistry** | Records verified payments after re-verifying the FDC proof itself | Not a custodian; holds no funds |
| **PayFlux** | Payment intents, routing, quoting, matching, reconciliation, settlement orchestration, merchant API | Not a chain, not a liquidity provider |

The single most important consequence: **PayFlux cannot make a payment look verified.** The
registry re-checks every proof against Flare's own `FdcVerification` contract, and PayFlux has no
way to forge one.

---

## System shape

```
                          ┌────────────────────┐
                          │      MERCHANT      │
                          └─────────┬──────────┘
                                    │  @payflux/node
                                    ▼
                          ┌────────────────────┐
                          │    EXPRESS API     │
                          └─────────┬──────────┘
                                    │
           ┌────────────────┬───────┴────────┬─────────────────┐
           ▼                ▼                ▼                 ▼
     Payment Engine   Routing Engine   Verification      Settlement
     (state machine)  (score + gate)   Engine (FDC)      Engine
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
                    Firestore /            Webhooks + SSE
                    in-memory store
```

---

## The payment engine

Every status change goes through one function, `payment.service.ts#transition`, which:

1. asserts the transition is legal against the state machine,
2. persists it,
3. writes an immutable `PaymentEvent`,
4. publishes to the SSE bus,
5. fires the merchant webhook.

No other module writes `status`, and **the API exposes no route that accepts a status from a
client**. A status is always the consequence of an observed fact — a detected transaction, a
finalized attestation, a confirmed settlement transaction.

```
created → awaiting_payment → payment_detected → verifying → verified → settling → settled
                                                     │
                                          partially_paid / overpaid
```

`partially_paid` can be topped up; it can never reach `settled` directly. Underpayment is never
rounded into success.

---

## Trust boundaries

Three things are deliberately not trusted.

**1. The client's transaction hash.** The `/verify` endpoint accepts `transactionHashHint`. The
name is the contract: it only narrows *which* transaction to attest. The hint is accepted only if
it independently satisfies every matching rule, and the payment's fate is decided entirely by the
attested data that comes back from FDC.

**2. PayFlux's own database.** The registry's intent commitment is written on-chain *before* the
customer pays, pinning the merchant, destination, reference, minimum amount and expiry. PayFlux
cannot change it afterwards. The backend states the expectation; Flare's attestation providers
state the fact. Neither side can produce a verified payment alone.

**3. The sender's address.** Payments are bound to intents by the XRPL *standard payment
reference* — a 32-byte memo that FDC itself decodes and reports. Matching on sender address breaks
the moment a customer pays from an exchange, or pays twice.

---

## Data model

Firestore when credentials are present, in-memory otherwise. Both satisfy the same interface, so
the API and tests run without external services.

```
users            merchants and settlement preferences
payments         payment intents
paymentEvents    immutable audit trail — one record per state transition
settlements      settlement records with real transaction hashes
webhookDeliveries  delivery attempts, retries, failures
idempotencyKeys  request hash → stored response
```

Secrets are never stored: API keys as SHA-256 digests only, signer keys never at all.

---

## Observability

Every request carries a `requestId` (echoed as `X-Request-ID`). Every payment, settlement,
blockchain operation and FDC operation carries its own identifier, and the event log ties them
together. When something fails at 2am mid-demo, the timeline says which stage and why.

---

## Extending it

Adding BTC:

1. Add the asset to `registry/assets.ts` (disabled).
2. Implement a watcher in `watcher/` — detect only, never decide.
3. Point the FDC service at the `testBTC` source ID; the `Payment` attestation type is unchanged.
4. Implement a `SettlementProvider` for the destination asset.
5. Add a route builder in `routing/router.ts`.
6. Enable the asset.

The payment engine, state machine, API, SDK, webhooks and dashboard need no changes. That is the
test of whether the abstraction is real.
