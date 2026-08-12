# Settlement

## The constraint that shapes everything

FXRP is not a wrapper token PayFlux can mint on demand. FAssets minting is a three-party protocol:

1. A **minter** reserves collateral against an **agent**, paying a reservation fee in C2FLR. The
   AssetManager responds with the agent's XRPL address and a payment reference.
2. The minter sends the underlying XRP to **that address** with **that reference**.
3. Anyone submits an FDC `Payment` attestation of step 2 to `executeMinting`, and FXRP is minted.

There is no "XRP in, FXRP out" endpoint. Inventing one would be fiction.

So PayFlux does not bolt a conversion onto the side of the payment. It makes the customer's
payment **be** the FAssets minting payment:

```
Customer picks the XRP route
        │
        ▼
PayFlux reserves collateral with an agent      ← a real Coston2 transaction
        │
        ▼
AssetManager emits CollateralReserved
  → agent's XRPL address
  → required payment reference
        │
        ▼
Checkout shows the customer THAT address and THAT reference
        │
        ▼
Customer sends XRP                             ← one transfer, not two
        │
        ▼
FDC attests it                                 ← one attestation
        │
        ├──────────────► PaymentRegistry.registerVerifiedPayment
        │                (the payment is verified)
        │
        └──────────────► AssetManager.executeMinting
                         (FXRP is minted)
        │
        ▼
FXRP forwarded to the merchant                 ← balance read before and after
```

One customer transfer. One attestation. Used twice. The FXRP genuinely lands in the merchant's
wallet, with a transaction hash.

---

## The cost: lot quantisation

FAssets mints in **whole lots**. Read live from `AssetManagerFXRP.lotSize()` — never hardcoded.

On Coston2 at the time of writing that is **10 XRP** per lot
(`AssetManagerFXRP` at `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`, FXRP at
`0x0b6A3645c240605887a5532109323A3E12273dc7`). Do not rely on those figures — the code reads
them every time, and so should you.

A $50 payment at 1.036 USD/XRP is 48.26 XRP. At a 10 XRP lot size the customer must send 50 XRP
plus the agent's minting fee.

That is a real cost to a real customer, so PayFlux surfaces it rather than absorbing it:

- the route card shows `priceImpact: "+1.74 XRP rounded up to the FAssets lot boundary"`,
- the reason appears in the route's "Why this route" list,
- `preflight()` returns `roundingDrops` explicitly.

Hiding it would be the easy choice and the dishonest one.

---

## Pre-flight

Before any gas is spent, [`chain/fassets.ts#preflight`](../backend/src/chain/fassets.ts) checks
everything knowable:

```
✓ AssetManagerFXRP resolves via the Contract Registry
✓ settings readable (lot size, granularity, minting decimals)
✓ amount clears at least one lot
✓ an agent exists with enough free collateral lots
✓ collateral reservation fee readable
✓ signer configured and holds enough C2FLR for that fee
```

Any failure becomes a **blocker string**, and the route is reported `degraded` — supported, not
available now, with the reason. The router never offers a settlement it has not confirmed it can
execute.

Execution goes further: `reserveCollateral` is simulated with `staticCall` before being sent, so a
revert surfaces as a precise UNAVAILABLE reason rather than a lost fee. This also makes the
integration self-correcting against FAssets ABI drift.

---

## What "settled" means

A settlement reaches `completed` only when **all** of these hold:

1. `executeMinting` returned a confirmed transaction,
2. the transfer to the merchant returned a confirmed transaction,
3. the merchant's FXRP balance, read before and after, **actually increased**.

If the balance did not move, the settlement is marked `failed` with:

> *"The merchant's FXRP balance did not increase after the transfer — refusing to report this
> settlement as complete."*

There is no code path anywhere in this repository that sets a settlement to `completed` without a
transaction hash. `settlement.service.ts` re-checks the returned settlement and fails the payment
if a provider ever returns one.

---

## Providers

### `fassets-mint` — XRP → FXRP

The path above. Availability depends on live agent capacity.

### `flare-native` — FXRP → FXRP, C2FLR → C2FLR

When the customer pays on Coston2, the payment *is* the settlement — there is nothing to convert.
This provider's job is to confirm the merchant's balance really changed, not to move anything.
Reporting `settled` without that confirmation would be the database-update-as-settlement
anti-pattern the whole architecture exists to avoid.

### Deliberately absent: `XRP → USDT0`

PayFlux has no swap infrastructure and no liquidity source. Implementing this with an invented
conversion rate would produce a longer asset list and a worthless one. `quoteSettlement` returns:

> *"No settlement provider implements X → Y. PayFlux does not invent conversion routes."*

---

## Adding a provider

```ts
export class MyProvider implements SettlementProvider {
  readonly id = "my-provider"
  supports(source: string, destination: string): boolean
  quote(request): Promise<SettlementQuote>    // executable:true only if genuinely checked
  execute(request, context): Promise<SettlementResult>  // real hash, or throw
  getStatus(id): Promise<SettlementStatus>
}
```

Register it in `settlement.service.ts`. The payment engine, API, SDK and dashboard need no
changes.

The contract is short and non-negotiable: `quote()` may only claim `executable: true` after
checking, and `execute()` may only return a completed settlement backed by a confirmed
transaction.

---

## Known gap

The FAssets path requires the collateral reservation to exist **before** the customer pays,
because the destination address comes from the reservation. A payment sent to the merchant's own
XRPL address instead is fully verified and recorded on Coston2, but cannot be minted.

PayFlux reports that state accurately: **verified, settlement unavailable**. It never reports it
as settled. The `poc` script's stage 8 says the same thing rather than skipping quietly.
