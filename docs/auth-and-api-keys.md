# Developer accounts and API keys

## Two credentials, deliberately not interchangeable

| Credential | Who holds it | What it can do |
| --- | --- | --- |
| **Firebase ID token** (Google sign-in) | A person, in a browser | Manage API keys, view the dashboard |
| **API key** (`sk_ctn2_…`) | A server, in an integration | Create and read payments, settlements, webhooks |

An API key **cannot** mint another API key. That would be a privilege escalation with no way
back: anyone who captured a key could issue themselves a fresh one and survive the rotation
meant to lock them out. Key management requires a session, always.

The reverse also holds — a signed-in browser session cannot create payments. Payments come from
your server, with your key.

---

## Sign-in

There is no sign-up form. A first Google sign-in provisions the account:

```
Browser                     PayFlux API                Google
   │                             │                        │
   │ signInWithPopup ────────────┼───────────────────────► │
   │ ◄─────────── ID token ──────┼──────────────────────── │
   │                             │                        │
   │ Authorization: Bearer <id>  │                        │
   ├────────────────────────────►│                        │
   │                             │ verifyIdToken ────────► │
   │                             │ ◄──── public keys ───── │
   │                             │                        │
   │                             ├─ provisionAccount       │
   │ ◄──────── account + keys ───┤                        │
```

The API verifies the token against Google's signing keys through `firebase-admin`. It never
trusts a uid, an email or an account id sent by the client — all three come out of the verified
token. `verifyIdToken(token, true)` also checks revocation, so signing out or disabling a user
invalidates their tokens immediately.

The ID token is never stored by this app: not in `localStorage`, not in a cookie. The Firebase
SDK holds it and `getToken()` fetches a fresh one before each request.

The `NEXT_PUBLIC_FIREBASE_*` values are public by design. They identify the project; they are not
secrets. What protects the account is the server-side verification.

### Account scoping

The account id is `acct_<firebase-uid>` and doubles as the `merchantId` scoping payments,
settlements and webhooks. A key issued by one developer can only ever see that developer's data.

---

## Per-account settlement

Each account sets its own destination addresses at `/dashboard/settings`:

```
PATCH /v1/account/settings
{
  "xrplAddress": "rYourOwnTestnetAddress...",
  "flareAddress": "0xYourCoston2Address...",
  "settlementAsset": "FXRP",
  "webhookUrl": "https://your-app.example/webhooks/payflux",
  "webhookSecret": "whsec_..."
}
```

A blank field falls back to the deployment default, and the response reports `usingDefaults` so
the dashboard can show which values are the account's own and which are inherited. Nobody should
have to guess where their money is going.

**The XRPL address is verified on save.** An unfunded XRPL address does not exist on ledger and
cannot receive a payment, so `checkAccountExists` rejects it with a message rather than accepting
a configuration that silently never works. A network failure during the check is *not* treated as
proof the address is bad.

Session-authenticated only. Changing where funds settle is an act by a person; no API key scope
grants it.

### The watcher consequence

Per-account addresses would be meaningless if the watcher only polled one. `xrpl.watcher.ts`
polls **every distinct merchant address** and refreshes the set every 60 seconds, so setting an
address in the dashboard starts it being watched without a restart.

Two details worth knowing:

- The set is capped at 25 addresses. Beyond that the watcher logs a warning naming the limit;
  those payments can still be verified via `POST /v1/payments/:id/verify`. It does not silently
  drop them.
- The payment *reference* decides which account owns a transaction — the address only decides
  where we looked. Several accounts inheriting the same default address is therefore harmless.

---

## Where authorisation actually lives

Worth being explicit, because Firebase invites the wrong assumption.

The client uses Firebase for **sign-in only**. It imports `firebase/app` and `firebase/auth`,
never `firebase/firestore`. Nothing in a browser reads or writes the database.

```
Browser ──ID token──► PayFlux API ──Admin SDK──► Firestore
                           │
                    all authorisation here
```

So Firestore security rules are **not** PayFlux's authorisation layer — the Admin SDK bypasses
them entirely. [`firestore.rules`](../firestore.rules) denies every client request, which is the
correct posture given the architecture: it costs the product nothing and guarantees that payment
amounts, API key digests, audit trails and settlement addresses can never be read from a browser
regardless of a future frontend bug.

Authorisation lives in three places, all server-side:

| Layer | File | Decides |
| --- | --- | --- |
| API keys + scopes | `backend/src/middleware/index.ts` | What an integration may call |
| Sessions | `backend/src/auth/firebase.ts` | Who a person is |
| Account scoping | `merchantId === accountId` throughout | Whose data is returned |

The real blast radius is the service account, not the rules file. `FIREBASE_PRIVATE_KEY` is the
only credential that can read this data — keep it server-side, and rotate it in the Firebase
console if it is ever exposed.

---

## Audit log

An append-only record of what changed an account's security posture, at
`/dashboard/audit` and `GET /v1/account/audit`.

| Event | Recorded when |
| --- | --- |
| `account.created` | First Google sign-in |
| `account.signed_in` | A session resumes, at most once per hour |
| `api_key.created` | A key is issued |
| `api_key.rotated` | Includes successor id, grace window and scopes |
| `api_key.revoked` | Immediate revocation |
| `api_key.scope_denied` | A key hit an endpoint it lacks the scope for |
| `settings.updated` | Which fields changed |

Each entry carries the actor (user email or key id), the request id and the client IP, so an
entry here traces to a line in the API logs.

**Secrets are never recorded.** A webhook secret change is logged as the field having changed,
never as a value — and API key secrets are not in the log because the server does not hold them
at all.

Audit writes for background events use `recordAuditSafe`, which logs and swallows failures: a
dropped audit line is bad, but a rotation that appears to fail *after* the key was already
rotated is worse, because the developer retries and ends up with an extra live key. Mutations
driven by an explicit request (`api_key.created`, `settings.updated`) await the write instead, so
the trail cannot fall behind the state it describes.

### Known weakness

Audit events for key operations are written by the **route handlers**, not by
`auth/api-keys.ts`. A future code path that calls `issueApiKey` directly would not be audited.
Moving the write into the service would fix that but double-log rotations, since rotation issues
a key internally and should read as `api_key.rotated`, not `api_key.created`. The routes are
currently the only entry point for human actions, so this is a live trade-off rather than a
solved problem.

---

## Scopes

A key carries only the permissions it needs.

| Scope | Grants |
| --- | --- |
| `payments:read` | Read payment intents, routes and events |
| `payments:write` | Create payment intents and trigger verification |
| `settlements:read` | Read settlements and settlement quotes |
| `settlements:write` | Execute settlements into the merchant's asset |
| `webhooks:read` | Read webhook configuration and delivery history |
| `webhooks:write` | Send test webhook events |

There is deliberately **no management scope**. No key can mint, rotate or revoke another key,
whatever it holds.

Omitting `scopes` on create gives `payments:read` + `payments:write` — the minimum to accept a
payment — not full access. Insecure-by-default is how scoped keys end up meaning nothing.

A denial returns `403 INSUFFICIENT_SCOPE` naming the scope required, the scopes held, and how to
fix it:

```json
{
  "error": {
    "code": "INSUFFICIENT_SCOPE",
    "message": "This API key lacks the \"payments:write\" scope (Create payment intents and trigger verification). It holds: payments:read. Rotate the key with the scope added.",
    "requiredScope": "payments:write"
  }
}
```

Every denial is written to the audit log. A key repeatedly hitting an endpoint it cannot use is
either a misconfigured deploy or someone probing, and both are worth seeing.

### Legacy keys

A key issued before scopes existed has no `scopes` field. It is **grandfathered as full access**
rather than silently narrowed — quietly breaking a working integration with a confusing 403 is
worse than the delay in tightening it. The dashboard marks these `Legacy · full access`.

Rotating a legacy key applies the default scopes to the successor, so full access does not carry
forward indefinitely. Rotating a scoped key inherits its scopes unless you narrow them:

```
POST /v1/api-keys/:id/rotate  { "graceHours": 24, "scopes": ["payments:read"] }
```

---

## Key format

```
sk_ctn2_a1b2c3d4e5f6a7b8_XmR3nQ7...
└┬┘ └─┬┘ └──────┬───────┘ └──┬──┘
 │    │         │            └── 32 random bytes, base64url
 │    │         └─────────────── key id: public lookup handle
 │    └───────────────────────── environment — a testnet key is obvious on sight
 └────────────────────────────── secret key marker, for secret scanners
```

Embedding the key id makes verification one indexed lookup rather than a scan over every key in
the system. The id is safe to quote in a support thread; the secret is not.

Note that base64url's alphabet includes `_`, so only the first three underscores are structural.
Parsing must split on those alone — an implementation that splits on every underscore rejects
roughly three keys in four, which is the kind of bug that passes a test suite by luck.

### Why SHA-256 and not bcrypt

Password hashes are slow because passwords are low-entropy and human-chosen. These secrets are
256 bits from a CSPRNG: there is no dictionary to attack and no brute-force budget that touches
them. A slow KDF would only add latency to every authenticated request. The comparison is still
constant-time, so the digest cannot leak through timing.

---

## Rotation

```
before:   [key A: active]

rotate(A, graceHours: 24)

during:   [key A: rotating, expires in 24h]  ← still works
          [key B: active]                     ← works
                    ↑ deploy B, confirm traffic moved

after:    [key A: expired]                    ← rejected
          [key B: active]
```

The grace window is the point. Without it there is a moment where production is authenticating
with a key that no longer works, and rotation becomes something teams avoid — which is worse than
not offering it.

For a leaked key, rotate with `graceHours: 0`. The old key is rejected on the next request.

A key can be rotated once. The successor records `rotatedFromId` and the predecessor records
`rotatedToId`, so the chain is auditable.

### Endpoints

All require `Authorization: Bearer <firebase-id-token>`.

```
GET    /v1/api-keys/me            the signed-in developer's profile
GET    /v1/api-keys               list (never includes hashes or secrets)
POST   /v1/api-keys               create      { name }
POST   /v1/api-keys/:id/rotate    rotate      { graceHours? }
POST   /v1/api-keys/:id/revoke    revoke immediately
```

`POST /v1/api-keys` and `/rotate` are the only responses that ever contain `secret`. There is no
endpoint that reveals an existing key, because the server does not have it to reveal.

Acting on another account's key returns the same `API_KEY_NOT_FOUND` as a key that does not
exist, so ids cannot be probed across accounts.

---

## The environment bootstrap key

`PAYFLUX_API_KEYS` holds `keyId:merchantId:secret` entries. These exist so the API, the test
suite and the demo store work before anyone has signed in.

Authentication tries developer-issued keys first, then falls back to these. They cannot be
rotated from the dashboard — that is the entire reason per-account keys exist. Treat them as a
local-development convenience.

---

## What is not implemented

Stated plainly rather than discovered later.

1. **Team accounts.** One account, one human. No invites, no shared ownership, no roles. Deferred
   deliberately — it needs an invitation flow and a permission model above scopes.
2. **Automatic rotation reminders.** Keys have `lastUsedAt` and `createdAt`, so the data for
   "this key is 90 days old and unused" exists — nothing acts on it.
3. **Rate limits per key beyond the global default.** The limiter keys on the API key, but every
   key gets the same allowance regardless of scopes.
4. **Audit retention and export.** Entries accumulate with no TTL and no CSV/SIEM export.
5. **Audit written at the route layer.** See the weakness noted above.
6. **The watcher caps at 25 addresses.** Loudly, not silently — but it is a cap.
