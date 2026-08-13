import Link from "next/link"
import { Shell, TopNav } from "@/components/payflux/shell"
import { CheckItem, GhostLink, PrimaryLink, Surface } from "@/components/payflux/primitives"
import {
  Callout,
  Code,
  DocNav,
  DocSection,
  DocTable,
  Endpoint,
} from "@/components/payflux/docs-ui"

export const metadata = {
  title: "PayFlux — Documentation",
  description: "Everything a developer needs to integrate PayFlux.",
}

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "quickstart", label: "Quickstart" },
  { id: "auth", label: "Authentication" },
  { id: "scopes", label: "Scopes" },
  { id: "payments", label: "Creating payments" },
  { id: "checkout", label: "Checkout & routes" },
  { id: "webhooks", label: "Webhooks" },
  { id: "verification", label: "How verification works" },
  { id: "settlement", label: "Settlement" },
  { id: "errors", label: "Errors" },
  { id: "reference", label: "API reference" },
  { id: "limits", label: "Limits & caveats" },
]

export default function DocsPage() {
  return (
    <Shell ambient={false} deep>
      <TopNav />

      <div className="mx-auto grid w-full max-w-[88rem] gap-12 px-6 pb-24 pt-4 md:px-10 lg:grid-cols-[13rem_1fr]">
        <aside className="hidden lg:block">
          <DocNav sections={SECTIONS} />
        </aside>

        <main className="min-w-0 max-w-3xl space-y-14">
          {/* ------------------------------------------------- overview */}
          <DocSection id="overview" eyebrow="Documentation" title="PayFlux in one page">
            <p>
              PayFlux lets you accept payments in assets that live on different chains, through one
              API. You price in dollars and name the assets you&apos;ll take. PayFlux works out the
              valid paths, proves the payment happened, and settles you in the asset you asked for.
            </p>

            <Code language="typescript">{`import { PayFlux } from "payflux-sdk"

const payflux = new PayFlux({ apiKey: process.env.PAYFLUX_SECRET_KEY })

const payment = await payflux.payments.create({
  amount: "50.00",
  currency: "USD",
  acceptedAssets: ["XRP", "FXRP", "C2FLR"],
  settlementAsset: "FXRP",
})

redirect(\`/checkout/\${payment.id}\`)`}</Code>

            <p>
              That is the whole integration. No XRPL SDK, no attestation client, no lot arithmetic,
              no transaction watcher — and no wallet connection: as a merchant you never sign
              anything.
            </p>

            <Callout tone="warn" title="Testnet only">
              PayFlux runs on Flare Coston2 and XRPL Testnet. No mainnet value moves. The API
              refuses to start if the network configuration is inconsistent.
            </Callout>
          </DocSection>

          {/* ----------------------------------------------- quickstart */}
          <DocSection id="quickstart" eyebrow="Get started" title="Quickstart">
            <ol className="space-y-5">
              <Step n={1} title="Sign in">
                Go to <DocLink href="/sign-in">/sign-in</DocLink> and continue with Google. The
                first sign-in creates your account — there is no separate sign-up and no password.
              </Step>

              <Step n={2} title="Set your settlement addresses">
                In <DocLink href="/dashboard/settings">Settings</DocLink>, add an XRPL Testnet
                address (where customers send XRP) and a Coston2 address (where your FXRP lands).
                Both are yours alone — PayFlux never falls back to anyone else&apos;s.
                <br />
                <span className="text-white/45">
                  Until both are set, every payment route reports itself unavailable.
                </span>
              </Step>

              <Step n={3} title="Create an API key">
                In <DocLink href="/dashboard/api-keys">API keys</DocLink>, pick the scopes you need
                and create a key. It is shown once.
              </Step>

              <Step n={4} title="Create a payment">
                <Code language="bash">{`curl -X POST https://your-api/v1/payments \\
  -H "X-API-Key: $PAYFLUX_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order_1001" \\
  -d '{
    "amount": "50.00",
    "currency": "USD",
    "acceptedAssets": ["XRP", "FXRP", "C2FLR"],
    "settlementAsset": "FXRP",
    "orderId": "order_1001"
  }'`}</Code>
              </Step>

              <Step n={5} title="Send the customer to checkout">
                Redirect to <code className="pf-hash">/checkout/&lt;paymentId&gt;</code>. They pick
                an asset, pay, and watch it verify. You get a webhook when it settles.
              </Step>
            </ol>

            <Callout tone="good" title="Check your key works">
              <code className="pf-hash">npm run verify:key -- sk_ctn2_…</code> exercises the key
              end to end in about ten seconds: authentication, every scope, a real payment,
              idempotency, and the routing engine.
            </Callout>
          </DocSection>

          {/* ----------------------------------------------------- auth */}
          <DocSection id="auth" eyebrow="Security" title="Authentication">
            <p>There are two credentials and they are deliberately not interchangeable.</p>

            <DocTable
              headers={["Credential", "Who holds it", "Can do"]}
              rows={[
                [
                  <code key="k" className="pf-hash">X-API-Key: sk_ctn2_…</code>,
                  "Your server",
                  "Create and read payments, settlements, webhooks",
                ],
                [
                  <code key="s" className="pf-hash">Authorization: Bearer &lt;id-token&gt;</code>,
                  "You, in a browser",
                  "Manage keys, settings, audit log",
                ],
              ]}
            />

            <p>
              An API key <strong className="text-white/85">cannot create another API key</strong>.
              If it could, anyone holding a leaked key could issue themselves a fresh one and
              survive the rotation meant to lock them out. Equally, a browser session cannot create
              payments — those come from your server.
            </p>

            <h3 className="pt-2 font-display text-base tracking-[0.04em] text-white">Key format</h3>
            <Code>{`sk_ctn2_a1b2c3d4e5f6a7b8_XmR3nQ7...
└┬┘ └─┬┘ └──────┬───────┘ └──┬──┘
 │    │         │            └── 32 random bytes
 │    │         └─────────────── key id — public, safe to quote in support
 │    └───────────────────────── environment (ctn2 = Coston2 testnet)
 └────────────────────────────── secret key marker`}</Code>

            <p>
              Keys are stored as SHA-256 digests and compared in constant time. The secret is shown
              exactly once, when you create it — there is no endpoint that reveals an existing key,
              because the server does not have it.
            </p>

            <h3 className="pt-2 font-display text-base tracking-[0.04em] text-white">Rotation</h3>
            <p>
              Rotating issues a successor and puts the old key on a countdown (24 hours by default).
              Both work during the window, so you can deploy the new key and confirm traffic moved
              before the old one stops. For a leaked key, rotate with no grace period — it is
              rejected on the next request.
            </p>
          </DocSection>

          {/* --------------------------------------------------- scopes */}
          <DocSection id="scopes" eyebrow="Security" title="Scopes">
            <p>
              A key carries only the permissions it needs, so a reporting job can hold a key that
              cannot move money.
            </p>

            <DocTable
              headers={["Scope", "Grants"]}
              rows={[
                [<code key="1" className="pf-hash">payments:write</code>, "Create payments, trigger verification"],
                [<code key="2" className="pf-hash">payments:read</code>, "Read payments, routes and events"],
                [<code key="3" className="pf-hash">settlements:read</code>, "Read settlements and quotes"],
                [<code key="4" className="pf-hash">settlements:write</code>, "Execute settlements"],
                [<code key="5" className="pf-hash">webhooks:read</code>, "Read webhook config and deliveries"],
                [<code key="6" className="pf-hash">webhooks:write</code>, "Send test events"],
              ]}
            />

            <p>
              Omitting scopes grants <code className="pf-hash">payments:read</code> +{" "}
              <code className="pf-hash">payments:write</code> — the minimum to accept a payment, not
              full access. A missing scope returns <code className="pf-hash">403</code> naming what
              was required:
            </p>

            <Code language="json">{`{
  "error": {
    "code": "INSUFFICIENT_SCOPE",
    "message": "This API key lacks the \\"payments:write\\" scope. It holds: payments:read. Rotate the key with the scope added.",
    "requiredScope": "payments:write"
  }
}`}</Code>

            <p className="text-white/45">
              Every denial is written to your audit log — a key repeatedly hitting an endpoint it
              cannot use is either a misconfigured deploy or someone probing.
            </p>
          </DocSection>

          {/* ------------------------------------------------- payments */}
          <DocSection id="payments" eyebrow="Core" title="Creating payments">
            <Code language="typescript">{`const payment = await payflux.payments.create({
  amount: "50.00",           // decimal string, max 2 places
  currency: "USD",           // USD only for now
  acceptedAssets: ["XRP", "FXRP", "C2FLR"],
  settlementAsset: "FXRP",   // what you want to end up holding
  orderId: "order_1001",     // your reference
  metadata: { sku: "hoodie" },
  idempotencyKey: "order_1001",
})`}</Code>

            <Callout title="Idempotency">
              Same key + same body returns the same payment. Same key + a{" "}
              <em>different</em> body returns <code className="pf-hash">409</code> rather than
              silently handing back the first payment. A retried request can never create a second
              charge.
            </Callout>

            <h3 className="pt-2 font-display text-base tracking-[0.04em] text-white">Statuses</h3>
            <Code>{`created → awaiting_payment → payment_detected → verifying → verified → settling → settled
                                                  │
                                       partially_paid / overpaid
                                                  │
                                         failed / expired / refunded`}</Code>

            <p>
              You cannot set a status. There is no field for it on any endpoint. A status is always
              the consequence of an observed fact — a detected transaction, a finalized attestation,
              a confirmed settlement.
            </p>

            <p>
              <strong className="text-white/85">Underpayment never becomes success.</strong> A short
              payment lands in <code className="pf-hash">partially_paid</code> with the outstanding
              amount recorded. Overpayment settles normally with the excess recorded.
            </p>
          </DocSection>

          {/* ------------------------------------------------- checkout */}
          <DocSection id="checkout" eyebrow="Core" title="Checkout & routes">
            <p>
              Redirect the customer to <code className="pf-hash">/checkout/&lt;paymentId&gt;</code>,
              or build your own using the routes endpoint.
            </p>

            <Code language="json" filename="GET /v1/payments/:id/routes">{`{
  "recommended": "route_pay_abc_fxrp",
  "data": [
    {
      "sourceAsset": "XRP",
      "status": "available",
      "score": 90,
      "estimatedInputAmount": "10.025",
      "destinationAsset": "FXRP",
      "settlementMethod": "fassets-mint",
      "priceImpact": "+0.82 XRP rounded up to the FAssets lot boundary",
      "reasons": [
        "FDC Payment attestation available for testXRP",
        "Verified payments are recorded on-chain in PaymentRegistry",
        "Settles to FXRP by FAssets minting (1 lot of 10 XRP)"
      ]
    }
  ]
}`}</Code>

            <p>
              Routes are recomputed live against FTSOv2 prices and FAssets agent capacity. A route
              is only <code className="pf-hash">available</code> if it can execute right now — a
              path PayFlux supports but cannot currently run is reported as{" "}
              <code className="pf-hash">degraded</code> or{" "}
              <code className="pf-hash">unavailable</code> with the reason, never hidden.
            </p>

            <Callout title="Why show the reasons?">
              A recommendation nobody can interrogate is an arbitrary default. Every route carries
              its reasons, including its costs — lot rounding appears in the same list as the
              benefits.
            </Callout>
          </DocSection>

          {/* ------------------------------------------------- webhooks */}
          <DocSection id="webhooks" eyebrow="Core" title="Webhooks">
            <p>
              Set your endpoint and signing secret in{" "}
              <DocLink href="/dashboard/settings">Settings</DocLink>. Every state change is
              delivered, signed, with retries at 5s, 30s, 2m, 10m and 1h.
            </p>

            <Code language="typescript" filename="Verifying a delivery">{`import { verifyWebhookSignature } from "payflux-sdk"

app.post("/webhooks/payflux",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const result = verifyWebhookSignature(
      req.header("X-PayFlux-Signature")!,
      req.body.toString("utf8"),   // RAW body, not a re-serialized object
      process.env.PAYFLUX_WEBHOOK_SECRET!,
    )
    if (!result.valid) return res.status(400).send(result.reason)

    const event = JSON.parse(req.body.toString("utf8"))
    // event.type, event.paymentId, event.status, event.settlement …
    res.json({ received: true })
  })`}</Code>

            <Callout tone="warn" title="Use the raw body">
              Key order and whitespace do not survive a JSON round trip, so verifying a
              re-serialized object will always fail.
            </Callout>

            <p>Events:</p>
            <Code>{`payment.created      payment.detected     payment.verifying
payment.verified     payment.settling     payment.settled
payment.failed       payment.expired      payment.partially_paid
payment.overpaid     settlement.completed settlement.failed`}</Code>

            <p className="text-white/45">
              The signature covers the timestamp and the body together, so a captured payload
              cannot be replayed later.
            </p>
          </DocSection>

          {/* --------------------------------------------- verification */}
          <DocSection id="verification" eyebrow="How it works" title="How verification works">
            <p>
              This is the part worth understanding, because it is what makes a PayFlux payment
              checkable by someone who does not trust PayFlux.
            </p>

            <h3 className="pt-2 font-display text-base tracking-[0.04em] text-white">
              XRP — proved by Flare
            </h3>
            <Code>{`XRPL transaction
   │
   ├─ FDC attestation requested        → Coston2 transaction
   ├─ voting round finalizes           → ~2 minutes
   ├─ Merkle proof retrieved
   └─ submitted to PaymentRegistry     → the contract calls
                                          FdcVerification.verifyPayment`}</Code>

            <p>
              The Flare Data Connector is <strong className="text-white/85">not a bridge</strong>.
              It moves no value. It produces an attestation — a signed, Merkle-committed statement
              that an external-chain fact is true — which Flare contracts can then verify.
            </p>

            <p>
              PayFlux commits your expectation to the registry{" "}
              <em>before the customer pays</em>: merchant, destination, reference, minimum amount,
              expiry. It cannot change that afterwards. PayFlux states the expectation; Flare&apos;s
              attestation providers state the fact. Neither can produce a verified payment alone.
            </p>

            <h3 className="pt-2 font-display text-base tracking-[0.04em] text-white">
              FXRP and C2FLR — read directly
            </h3>
            <p>
              Coston2 is the chain PayFlux runs on, so there is nothing to attest. The transaction
              and its receipt are read straight off the ledger and checked for destination, amount,
              status and confirmations.
            </p>

            <h3 className="pt-2 font-display text-base tracking-[0.04em] text-white">
              How a transfer is tied to your order
            </h3>
            <p>
              Not by sender address — that breaks the moment a customer pays from an exchange or
              pays twice. XRP payments carry a 32-byte memo that FDC itself decodes and reports, so
              the binding is verified by Flare rather than trusted from our database.
            </p>

            <Callout title="Your transaction hash is a hint">
              If you pass <code className="pf-hash">transactionHashHint</code> to{" "}
              <code className="pf-hash">/verify</code>, it only narrows which transaction to check.
              The outcome is decided by the attested data, not by what you sent.
            </Callout>
          </DocSection>

          {/* ------------------------------------------------ settlement */}
          <DocSection id="settlement" eyebrow="How it works" title="Settlement">
            <p>
              FXRP is not a wrapper token that can be minted on demand. FAssets minting is a
              three-party protocol: collateral is reserved with an agent, the underlying XRP is sent
              to <em>that agent</em>, and an attestation of that payment mints the FXRP.
            </p>

            <p>
              So PayFlux does not bolt a conversion onto the side of your payment. It makes the
              customer&apos;s payment <strong className="text-white/85">be</strong> the minting
              payment — one transfer, one attestation, used twice: once to record the payment, once
              to mint. The customer&apos;s XRP literally becomes the backing for your FXRP.
            </p>

            <Callout tone="warn" title="Lot quantisation">
              FAssets mints whole lots — currently 10 XRP on Coston2. A $5 payment becomes 10 XRP
              plus the agent&apos;s fee. PayFlux shows this as price impact on the route rather
              than hiding it.
            </Callout>

            <p>
              A settlement is only <code className="pf-hash">completed</code> when there is a
              confirmed transaction <em>and</em> your balance actually increased. There is no code
              path that marks a settlement complete without both.
            </p>

            <p className="text-white/45">
              There is deliberately no <code className="pf-hash">XRP → USDT</code> route. PayFlux
              has no swap infrastructure, so offering one would mean inventing a conversion rate.
            </p>
          </DocSection>

          {/* ---------------------------------------------------- errors */}
          <DocSection id="errors" eyebrow="Reference" title="Errors">
            <Code language="json">{`{
  "error": { "code": "ASSET_UNSUPPORTED", "message": "Asset \\"DOGE\\" is not supported…" },
  "requestId": "req_9f2c…"
}`}</Code>

            <DocTable
              headers={["Code", "Status", "Meaning"]}
              rows={[
                [<code key="a" className="pf-hash">UNAUTHORIZED</code>, "401", "Missing or invalid key"],
                [<code key="b" className="pf-hash">INSUFFICIENT_SCOPE</code>, "403", "Key lacks the required scope"],
                [<code key="c" className="pf-hash">ASSET_UNSUPPORTED</code>, "400", "Asset has no implemented path"],
                [<code key="d" className="pf-hash">ROUTE_UNAVAILABLE</code>, "409", "Supported, but not executable now"],
                [<code key="e" className="pf-hash">IDEMPOTENCY_KEY_REUSED</code>, "409", "Same key, different body"],
                [<code key="f" className="pf-hash">VALIDATION_FAILED</code>, "422", "Body failed validation"],
                [<code key="g" className="pf-hash">RATE_LIMITED</code>, "429", "120 requests/min per key"],
                [<code key="h" className="pf-hash">QUOTE_UNAVAILABLE</code>, "503", "No live price feed — never a guess"],
                [<code key="i" className="pf-hash">FASSETS_UNAVAILABLE</code>, "503", "No agent capacity right now"],
              ]}
            />

            <p>
              Every response carries <code className="pf-hash">X-Request-ID</code>. Quote it in a
              support thread and the whole request can be traced.
            </p>
          </DocSection>

          {/* ------------------------------------------------- reference */}
          <DocSection id="reference" eyebrow="Reference" title="API reference">
            <Surface className="px-5 py-2">
              <Endpoint method="POST" path="/v1/payments" auth="key">
                Create a payment intent. Send <code className="pf-hash">Idempotency-Key</code>.
              </Endpoint>
              <Endpoint method="GET" path="/v1/payments" auth="key">
                List your payments.
              </Endpoint>
              <Endpoint method="GET" path="/v1/payments/:id" auth="public">
                Read a payment — safe to expose to the customer.
              </Endpoint>
              <Endpoint method="GET" path="/v1/payments/:id/routes" auth="public">
                Live routes with scores and reasons.
              </Endpoint>
              <Endpoint method="GET" path="/v1/payments/:id/events" auth="public">
                The payment&apos;s audit trail.
              </Endpoint>
              <Endpoint method="GET" path="/v1/payments/:id/stream" auth="public">
                Server-sent events — status changes as they happen.
              </Endpoint>
              <Endpoint method="POST" path="/v1/payments/:id/select-asset" auth="public">
                Customer chooses how to pay. Locks a quote and commits the intent on-chain.
              </Endpoint>
              <Endpoint method="POST" path="/v1/payments/:id/verify" auth="public">
                Ask PayFlux to re-check the chain.
              </Endpoint>
              <Endpoint method="POST" path="/v1/payments/:id/settle" auth="key">
                Settle a verified payment.
              </Endpoint>
              <Endpoint method="GET" path="/v1/settlements" auth="key">
                List settlements.
              </Endpoint>
              <Endpoint method="GET" path="/v1/assets" auth="public">
                Supported assets and their capabilities.
              </Endpoint>
              <Endpoint method="GET" path="/v1/health" auth="public">
                What is actually live right now.
              </Endpoint>
              <Endpoint method="GET" path="/v1/api-keys" auth="session">
                List keys. Create, rotate and revoke live here too.
              </Endpoint>
              <Endpoint method="PATCH" path="/v1/account/settings" auth="session">
                Your settlement addresses and webhook config.
              </Endpoint>
            </Surface>
          </DocSection>

          {/* ---------------------------------------------------- limits */}
          <DocSection id="limits" eyebrow="Be aware" title="Limits & caveats">
            <DocTable
              headers={["Limit", "Value"]}
              rows={[
                ["Rate limit", "120 requests / minute, per key"],
                ["API keys per account", "5 live"],
                ["Rotation grace window", "24 hours (configurable, 0 = immediate)"],
                ["Open FAssets reservations", "3 per account"],
                ["Payment window", "15 minutes"],
                ["Quote lifetime", "5 minutes"],
                ["Amount tolerance", "50 bps"],
              ]}
            />

            <p className="pt-2">Things worth knowing before you build on this:</p>
            <ul className="space-y-2.5">
              <CheckItem>
                Verification takes 3–4 minutes, dominated by the FDC voting round. That wait is the
                cost of a trust-minimised proof.
              </CheckItem>
              <CheckItem>
                FXRP payments are matched on amount and time window — ERC-20 transfers have no memo
                field. When two orders expect the same amount, PayFlux asks for a transaction hash
                rather than guessing.
              </CheckItem>
              <CheckItem>
                BTC and DOGE are listed as unsupported. FDC can attest them, but PayFlux has no
                watcher or settlement path yet.
              </CheckItem>
              <CheckItem>
                One account, one human. No team accounts, invites or roles yet.
              </CheckItem>
            </ul>

            <Callout tone="warn" title="Testnet">
              Coston2 and XRPL Testnet only. Nothing here moves real value, and this is not audited
              software.
            </Callout>

            <div className="flex flex-wrap gap-4 pt-4">
              <PrimaryLink href="/sign-in">Get an API key</PrimaryLink>
              <GhostLink href="/dashboard/diagnostics">See what&apos;s live</GhostLink>
            </div>

            <p className="pt-2 text-[12px] text-white/35">
              The full blueprint — architecture, design decisions, and an honest list of what is and
              isn&apos;t real — lives in{" "}
              <code className="pf-hash">PAYFLUX.md</code> in the repository.
            </p>
          </DocSection>
        </main>
      </div>
    </Shell>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="font-display mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--pf-coral)]/40 bg-[color:var(--pf-coral)]/10 text-[12px] text-[color:var(--pf-coral)]">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-white/90">{title}</p>
        <div className="mt-1.5 space-y-3 text-[13px] leading-relaxed text-white/60">{children}</div>
      </div>
    </li>
  )
}

function DocLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:text-[color:var(--pf-coral)]"
    >
      {children}
    </Link>
  )
}
