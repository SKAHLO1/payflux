# Payment routing

## Supported ≠ available

The router exists to keep these two questions apart.

**Supported** — PayFlux has implemented the whole path: watcher, verification, settlement.
A static property of the codebase.

**Available** — the path can execute *right now*. A live question, re-answered on every checkout
load against real chain state.

```
XRP → FXRP

Supported:      YES
Available now:  NO
Reason:         No FAssets agent currently has 5 free lots (best available: 2)
```

That is a better answer than a shorter list, and much better than a route that fails after the
customer has already sent funds.

---

## Building a route

For each accepted asset, [`routing/router.ts`](../backend/src/routing/router.ts):

1. **Quotes it.** FTSOv2 feed read on Coston2. No price → no route. There is no hardcoded
   fallback rate anywhere in the pricing module, deliberately.
2. **Checks verification.** Are the FDC contracts resolvable? Is a verifier key configured? Is
   PaymentRegistry deployed?
3. **Checks settlement.** For XRP that means a full FAssets pre-flight: lot arithmetic, agent
   capacity, reservation fee, signer balance.
4. **Assigns a status.**
   - `available` — executable end to end
   - `degraded` — payment and verification work, settlement does not
   - `unavailable` — something essential is missing
5. **Collects reasons.** Human-readable strings, rendered verbatim in the checkout UI.

Health snapshots are cached for 15 seconds — these are chain reads and the router runs on every
checkout load.

---

## Scoring

```
score = 100
      − 25 if degraded
      − 15 if no settlement path
      −  (feeBps / 10),      capped at 20
      −  (seconds / 20),     capped at 15
      +   8 if FDC-verified
      −   5 if price impact
```

Two choices worth defending:

**Executability dominates.** A route that cannot run is never recommended, whatever its fee.
Unavailable routes get no score at all.

**Cross-chain verification earns a bonus, despite being slower.** An FDC-attested payment is a
stronger guarantee than a same-chain transfer, and the router should not rank a weaker guarantee
first purely because it confirms in five seconds. The time penalty is capped for the same reason.

The weights are simple and fully explainable on purpose. An opaque ranking shown next to a "Why
this route?" panel would be worse than no ranking at all.

---

## Explaining the choice

Every route carries `reasons[]`, rendered directly in the UI:

```
Why this route

✓ FDC Payment attestation available for testXRP
✓ Verified payments are recorded on-chain in PaymentRegistry
✓ Settles to FXRP by FAssets minting (5 lots of 10 XRP)
✓ +1.74 XRP rounded up to the FAssets lot boundary
```

Note that the last line is a *cost*, listed alongside the benefits. The panel is an explanation,
not a sales pitch.

Degraded routes say what still works:

> *Payment is verifiable now, but automatic FXRP settlement is unavailable — the merchant is
> credited once capacity returns.*

---

## The three live routes

| Route | Verification | Settlement | Typical | Notes |
| --- | --- | --- | --- | --- |
| XRP → FXRP | FDC `Payment` | FAssets minting | ~200s | The flagship cross-ecosystem path |
| FXRP → FXRP | Native | None needed | ~10s | Payment *is* the settlement |
| C2FLR → C2FLR | Native | None needed | ~5s | Fastest, no cross-chain story |

BTC and DOGE are declared in the asset registry and **disabled**. FDC attests those chains, but
PayFlux has no watcher and no settlement path, so listing them as supported would be a lie about
the product's capability.

---

## Quoting

```ts
const quote = await createQuote("50.00", "USD", "XRP")
// {
//   assetAmount: "73.432",
//   rate: "0.68123",
//   fee: "0.219",
//   rateSource: "ftso-v2",
//   rateSourceDetail: "FTSOv2 XRP/USD on Coston2, published 2026-08-09T…",
//   expiresAt: "…+5min",
// }
```

- Rate from FTSOv2, with provenance recorded in the quote itself.
- All arithmetic in integers at feed precision — no float drift on money.
- A 30 bps spread, disclosed as `fee` rather than folded into the rate.
- Short TTL (`QUOTE_TTL_SECONDS`, default 300s), enforced by `assertQuoteFresh`.

If the feed cannot be read, `createQuote` throws and the route is reported unavailable. A wrong
price is worse than no price when someone is about to send real value.
