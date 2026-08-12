# The FDC verification flow

## What FDC is

The Flare Data Connector produces **attestations**: signed, Merkle-committed statements that some
external-chain fact is true, which Flare contracts can then verify on-chain.

It is not a bridge. It moves no value. PayFlux uses it for exactly one claim:

> *This XRPL payment happened — to this address, carrying this reference, for this amount.*

Everything else PayFlux does with that claim happens on Flare.

---

## The round trip

```
  XRPL transaction hash
          │
  ┌───────▼────────────────────────────────────────────┐
  │ 1. prepareRequest                                  │
  │    POST {verifier}/verifier/xrp/Payment/prepareRequest
  │    → abiEncodedRequest                             │
  └───────┬────────────────────────────────────────────┘
          │
  ┌───────▼────────────────────────────────────────────┐
  │ 2. requestAttestation                              │
  │    FdcHub.requestAttestation(bytes) payable        │
  │    fee from FdcRequestFeeConfigurations            │
  │    → Coston2 transaction, assigned a voting round  │
  └───────┬────────────────────────────────────────────┘
          │
  ┌───────▼────────────────────────────────────────────┐
  │ 3. wait for finalization                           │
  │    attestation providers observe XRPL and vote     │
  │    Relay.isFinalized(200, round)                   │
  └───────┬────────────────────────────────────────────┘
          │
  ┌───────▼────────────────────────────────────────────┐
  │ 4. retrieve proof                                  │
  │    POST {da}/api/v1/fdc/proof-by-request-round-raw │
  │    → Merkle proof + ABI-encoded response           │
  └───────┬────────────────────────────────────────────┘
          │
  ┌───────▼────────────────────────────────────────────┐
  │ 5. verify on-chain                                 │
  │    PaymentRegistry.registerVerifiedPayment(proof)  │
  │    → FdcVerification.verifyPayment(proof)          │
  └────────────────────────────────────────────────────┘
```

Implemented in [`backend/src/verification/fdc.service.ts`](../backend/src/verification/fdc.service.ts).

### The verifier API key

Stage 1 needs an `X-API-KEY`. Flare publishes an **open key for the testnet verifier** in their
FDC guides and starter kits:

```
00000000-0000-0000-0000-000000000000
```

It is not a secret, and PayFlux defaults to it — a fresh clone can verify a payment without
hunting for credentials. Confirmed against the live endpoint: no key returns `401`, this key
returns `200`. Override `FDC_VERIFIER_API_KEY` if you are issued a dedicated one.

### The indexer race

The verifier runs its own XRPL indexer, which lags the ledger slightly. PayFlux's watcher reads
XRPL directly, so it routinely sees a validated transaction *before* the verifier does, and
stage 1 answers:

```json
{ "status": "INVALID: TRANSACTION DOES NOT EXIST" }
```

Two consequences, both handled:

- Statuses carry an explanatory suffix, so they are matched on the part before the colon.
  Comparing the whole string classifies every `INDETERMINATE` as permanent.
- This particular rejection is **retryable**, not a mismatch. `prepareXrpPaymentRequestWithRetry`
  polls for up to a minute and records an `fdc.awaiting_indexer` event each attempt. Without it,
  the most common case — detecting a payment the instant it validates — fails a perfectly good
  payment for a reason that resolves itself in seconds.

**Stage 3 genuinely takes minutes.** Voting rounds are 90 seconds and finalization follows.
There is no way to make it faster and no reason to pretend otherwise — the checkout says so
plainly instead of animating a fake progress bar. That wait is the price of a trust-minimised
proof, and it is worth naming rather than hiding.

---

## Contract resolution

Every Flare contract is resolved through the **Flare Contract Registry** at
`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` — the same address on every Flare network — rather
than hardcoded:

```
FdcHub                     submit attestation requests
FdcRequestFeeConfigurations  read the request fee
FdcVerification            verify proofs on-chain
FlareSystemsManager        compute the voting round from a block timestamp
Relay                      check round finalization
FtsoV2                     read price feeds
AssetManagerFXRP           FAssets settings, agents, minting
```

The contract does the same thing: `PaymentRegistry._verifyFdcProof` calls
`ContractRegistry.getFdcVerification()` on every verification, so the registry keeps working
across FDC contract upgrades.

---

## Binding a transfer to an intent

This is the part most crypto checkouts get wrong.

Matching on **sender address** breaks when a customer pays from an exchange, pays twice, or pays
for two orders. PayFlux binds on the XRPL **standard payment reference**: a 32-byte memo that FDC
itself decodes and reports in `responseBody.standardPaymentReference`.

```
pay_8F92K2
   │  UTF-8, right-padded to 32 bytes
   ▼
0x7061795f384639324b32000000000000000000000000000000000000000000000
   │  attached as XRPL MemoData
   ▼
FDC reports it back in the attestation
   │
   ▼
PaymentRegistry compares it to the committed intent — on-chain
```

The same value is checked twice: off-chain by `verification-result.ts` when matching, and on-chain
by the registry before it will record anything. Because the intent commitment was written
*before* the customer paid, PayFlux cannot retrofit a reference to match a payment it likes.

---

## What the attestation actually says

```solidity
struct ResponseBody {
    uint64  blockNumber;
    uint64  blockTimestamp;            // from the attested XRPL block, not our clock
    bytes32 sourceAddressHash;
    bytes32 receivingAddressHash;      // keccak256(utf8(address))
    int256  receivedAmount;            // drops
    bytes32 standardPaymentReference;
    bool    oneToOne;
    uint8   status;                    // 0 == success
}
```

PayFlux checks all of it — and so does the contract, independently:

| Check | Off-chain | On-chain |
| --- | --- | --- |
| Source transaction succeeded | ✓ | ✓ |
| Destination is the merchant | ✓ | ✓ |
| Reference matches the intent | ✓ | ✓ |
| Landed before expiry | ✓ | ✓ (using the attested block timestamp) |
| Amount clears the minimum | ✓ (with tolerance) | ✓ (hard floor) |
| Transaction not already used | ✓ | ✓ |

Note the expiry check uses `blockTimestamp` from the attested XRPL block. A payment cannot be
back-dated into a window it missed.

---

## Amount reconciliation

Converting a fiat amount to a volatile asset means rounding. A tolerance band (default 50 bps,
`AMOUNT_TOLERANCE_BPS`) absorbs that. Outside the band:

```
received < expected - tolerance   →  partially_paid   (never "paid")
received > expected + tolerance   →  overpaid         (excess recorded, settles normally)
```

The contract enforces the floor with no tolerance at all: an underpayment reverts rather than
being recorded. Off-chain leniency, on-chain strictness.

---

## Failure modes

Every one of these is a distinct, reportable state. None of them silently becomes success.

| Code | Meaning |
| --- | --- |
| `FDC_REQUEST_FAILED` | The verifier rejected the request, or the submission reverted |
| `FDC_REQUEST_PENDING` | The round did not produce a retrievable proof in time |
| `FDC_PROOF_INVALID` | `FdcVerification` rejected the proof, or the registry's checks failed |
| `TRANSACTION_NOT_FOUND` | No matching validated XRPL payment |
| `WRONG_DESTINATION` | Funds went somewhere other than the merchant |
| `WRONG_AMOUNT` | Amount could not be reconciled |
| `PAYMENT_EXPIRED` | Landed after the intent's window |
| `DUPLICATE_PAYMENT` | The transaction already settled another intent |

The most common in practice is a `prepareRequest` returning `INDETERMINATE` because the verifier's
indexer has not seen the transaction yet. It is marked retryable rather than fatal.

---

## Not yet implemented: provable non-payment

FDC offers `ReferencedPaymentNonexistence`, including for testXRP. It would let PayFlux prove that
no matching payment occurred in a window, rather than trusting its own clock:

```
window closes
     ↓
request ReferencedPaymentNonexistence
     ↓
proof of absence
     ↓
expire the intent — verifiably
```

Today expiry is decided by the server clock plus a final XRPL re-check before expiring anything
that might have landed at the last moment. The attestation type is already defined in
`verification/proof.ts` and the state machine distinguishes `expired` from `failed`, so this is an
addition rather than a redesign. It is listed as a limitation in the README because it is not
built.
