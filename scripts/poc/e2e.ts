/**
 * PayFlux end-to-end proof of concept.
 *
 * This script exists to answer the only question that matters before any product is built:
 *
 *     Can we actually execute this path, on real infrastructure, today?
 *
 *       XRPL Testnet -> testXRP -> FDC XRPPayment -> Coston2 -> PaymentRegistry -> FXRP -> merchant
 *
 * It uses the same modules the API uses — no parallel "demo" implementation — so a green run here
 * is evidence about the product, not about the script.
 *
 * Run:
 *   npx tsx scripts/poc/e2e.ts --amount 20
 *   npx tsx scripts/poc/e2e.ts --pay                   # send the XRP too — the whole path, unattended
 *   npx tsx scripts/poc/e2e.ts --tx <XRPL_TX_HASH>     # skip the wait, attest an existing payment
 *   npx tsx scripts/poc/e2e.ts --check                 # read-only preflight, sends nothing
 *
 * Every stage prints what it did and the hash it produced. Nothing is simulated: if a stage
 * cannot run, the script says which one and stops.
 */
import { formatUnits } from "ethers"
import { env, capabilities, NETWORKS } from "../../backend/src/config/env.js"
import { assertCoston2, tryGetSigner, getProvider } from "../../backend/src/chain/provider.js"
import { getFeedPrice } from "../../backend/src/pricing/ftso.service.js"
import * as fassets from "../../backend/src/chain/fassets.js"
import * as fdc from "../../backend/src/verification/fdc.service.js"
import * as registryClient from "../../backend/src/chain/payment-registry.js"
import {
  buildMemo,
  getIncomingPayments,
  getTransaction,
  decodeStandardPaymentReference,
  xrpToDrops,
  dropsToXrp,
  type XrplPaymentTransaction,
} from "../../backend/src/verification/xrpl.payment.js"
import { matchPaymentProof } from "../../backend/src/verification/verification-result.js"
import { generatePaymentReference } from "../../backend/src/payments/payment.service.js"
import type { PaymentIntent } from "../../backend/src/domain/types.js"

const args = parseArgs(process.argv.slice(2))
const FIAT_AMOUNT = args.amount ?? "20.00"

async function main() {
  banner("PayFlux end-to-end proof of concept")
  const results: Record<string, string> = {}

  // -- Stage 0: environment -------------------------------------------
  step(0, "Environment and network")
  await assertCoston2()
  const network = await getProvider().getNetwork()
  ok(`Coston2 RPC reachable, chainId ${network.chainId}`)
  ok(`XRPL endpoint: ${env.XRPL_RPC_URL}`)

  const caps = capabilities()
  const signer = tryGetSigner()
  if (signer) {
    const balance = await getProvider().getBalance(await signer.getAddress())
    ok(`Signer ${await signer.getAddress()} holds ${formatUnits(balance, 18)} C2FLR`)
    if (balance === 0n) {
      fail("Signer has no C2FLR. Fund it at https://faucet.flare.network/coston2")
    }
  } else {
    fail("COSTON2_PRIVATE_KEY is not set — the FDC request and registry write cannot be submitted.")
  }
  if (!caps.fdcVerifier) {
    fail("FDC_VERIFIER_API_KEY is not set — attestation requests cannot be prepared.")
  }
  if (!env.MERCHANT_XRPL_ADDRESS) {
    fail("MERCHANT_XRPL_ADDRESS is not set — there is nowhere for the customer to pay.")
  }

  // -- Stage 1: real price --------------------------------------------
  step(1, "Price the payment from FTSOv2 (no invented rates)")
  const price = await getFeedPrice("XRP/USD")
  const xrpAmount = (Number(FIAT_AMOUNT) / Number(price.price)).toFixed(6)
  ok(`XRP/USD = ${price.price} (published ${new Date(price.timestamp * 1000).toISOString()})`)
  ok(`$${FIAT_AMOUNT} => ${xrpAmount} XRP`)
  results["FTSOv2 XRP/USD"] = price.price

  // -- Stage 2: FAssets reality check ---------------------------------
  step(2, "FAssets pre-flight on Coston2")
  const settings = await fassets.getFAssetSettings().catch((e) => {
    warn(`FAssets settings unavailable: ${e.message}`)
    return undefined
  })

  let requiredXrp = xrpAmount
  let preflight: Awaited<ReturnType<typeof fassets.preflight>> | undefined

  if (settings) {
    ok(`AssetManagerFXRP: ${settings.assetManager}`)
    ok(`FXRP token:       ${settings.fAsset}`)
    ok(`Lot size:         ${settings.lotSizeXrp} XRP`)
    results["AssetManagerFXRP"] = settings.assetManager
    results["FXRP"] = settings.fAsset

    preflight = await fassets.preflight(xrpToDrops(xrpAmount))
    if (preflight.ok) {
      requiredXrp = preflight.requiredXrp
      ok(`Mintable: ${preflight.lots} lot(s) via agent ${preflight.agent?.agentVault}`)
      ok(`Customer must send ${requiredXrp} XRP (lot-aligned, incl. agent fee)`)
    } else {
      warn("FXRP settlement is UNAVAILABLE right now:")
      for (const blocker of preflight.blockers) warn(`  - ${blocker}`)
      warn("Verification will still be demonstrated end to end; settlement will be skipped.")
    }
  }

  // -- Stage 3: registry ----------------------------------------------
  step(3, "PaymentRegistry on Coston2")
  const health = await registryClient.registryHealth()
  if (!health.available) {
    fail(`PaymentRegistry unavailable: ${health.detail}`)
  }
  ok(`PaymentRegistry:  ${health.address}`)
  ok(`FdcVerification:  ${(health as { fdcVerification?: string }).fdcVerification}`)
  results["PaymentRegistry"] = health.address!

  if (args.check) {
    banner("Read-only check complete — nothing was sent")
    summary(results)
    return
  }

  // -- Stage 4: the payment -------------------------------------------
  step(4, "Payment intent and XRPL transfer")
  const reference = generatePaymentReference()
  const memo = buildMemo(reference)

  const intent: PaymentIntent = {
    id: `poc_${Date.now()}`,
    merchantId: "merchant_demo",
    amount: FIAT_AMOUNT,
    currency: "USD",
    acceptedAssets: ["XRP"],
    status: "awaiting_payment",
    paymentReference: reference,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  let tx: XrplPaymentTransaction | undefined

  if (args.tx) {
    tx = await getTransaction(args.tx)
    if (!tx) fail(`XRPL transaction ${args.tx} not found or is not a Payment.`)
    ok(`Using existing transaction ${tx!.hash}`)
    if (tx!.standardPaymentReference) {
      const existing = decodeStandardPaymentReference(tx!.standardPaymentReference)
      intent.paymentReference = existing
      ok(`Reference from memo: ${existing}`)
    }
  } else if (args.pay) {
    console.log(`
  Sending ${requiredXrp} XRP to ${env.MERCHANT_XRPL_ADDRESS}
  Memo encodes reference ${reference}, which is what binds this transfer to this intent.
`)
    const hash = await sendPayment(
      env.MERCHANT_XRPL_ADDRESS!,
      requiredXrp,
      memo.memoDataHex,
      args.seed ?? process.env.XRPL_WALLET_SEED,
    )
    ok(`Sent ${hash}`)

    // Read it back from the ledger rather than trusting the submit result: everything downstream
    // works from the attested transaction, so this proves it is actually queryable first.
    tx = await getTransaction(hash)
    if (!tx) fail(`Sent ${hash} but could not read it back from the ledger.`)
    ok(`Confirmed on ledger, delivering ${dropsToXrp(tx!.deliveredDrops)} XRP`)
  } else {
    console.log(`
  Send exactly ${requiredXrp} XRP on XRPL Testnet:

    Destination:  ${env.MERCHANT_XRPL_ADDRESS}
    Amount:       ${requiredXrp} XRP
    Memo (hex):   ${memo.memoDataHex}

  The memo encodes reference ${reference}. FDC reads it as the standard payment reference,
  which is how this transfer is bound to this intent — the sender address is never used.

  Re-run with --pay to have the script send this itself — it funds a wallet and sets the memo,
  which most faucet UIs cannot do.

  Faucets: https://faucet.altnet.rippletest.net/accounts   (official, fastest)
           https://test.bithomp.com/faucet/                (slower, but has a UI)

  Waiting...
`)
    tx = await waitForPayment(env.MERCHANT_XRPL_ADDRESS!, reference)
    ok(`Detected ${tx.hash} delivering ${dropsToXrp(tx.deliveredDrops)} XRP`)
  }

  results["XRPL transaction"] = tx!.hash
  console.log(`  ${NETWORKS.xrpl.txUrl(tx!.hash)}`)

  // -- Stage 5: FDC ----------------------------------------------------
  step(5, "FDC attestation")
  /*
   * Retry while the verifier's indexer catches up.
   *
   * The verifier answers TRANSACTION DOES NOT EXIST for a transfer that is already final on
   * XRPL but has not reached its index yet — a few seconds, usually. That gap was invisible
   * while a human went off to a faucet between stages 4 and 5; sending the payment inline
   * closed the gap and exposed it. The API path has always used this variant.
   */
  const prepared = await fdc.prepareXrpPaymentRequestWithRetry(tx!.hash, {
    onRetry: (attempt, detail) => {
      if (attempt === 1) console.log(`  … waiting for the verifier's indexer: ${detail}`)
      else process.stdout.write("·")
    },
  })
  if (process.stdout.isTTY) console.log("")
  ok(`Request prepared, id ${prepared.requestId}`)

  const submitted = await fdc.submitAttestationRequest(prepared.abiEncodedRequest)
  ok(`Submitted on Coston2: ${submitted.transactionHash}`)
  ok(`Voting round ${submitted.votingRound}, fee ${formatUnits(submitted.fee, 18)} C2FLR`)
  console.log(`  ${submitted.explorerUrl}`)
  results["FDC request tx"] = submitted.transactionHash
  results["FDC voting round"] = String(submitted.votingRound)

  console.log("\n  Waiting for the voting round to finalize (this genuinely takes a few minutes)…")
  const proof = await fdc.waitForProof(submitted.votingRound, prepared.abiEncodedRequest, {
    onTick: (attempt) => process.stdout.write(attempt % 6 === 0 ? "·" : ""),
  })
  console.log("")
  ok(`Proof retrieved: ${proof.merkleProof.length} Merkle node(s)`)
  ok(`Attested amount: ${dropsToXrp(proof.data.responseBody.receivedAmount)} XRP`)
  ok(`Attested reference: ${decodeStandardPaymentReference(proof.data.responseBody.standardPaymentReference)}`)

  // -- Stage 6: matching -----------------------------------------------
  step(6, "Match the attested data against the intent")
  const match = matchPaymentProof(proof, {
    intent,
    merchantXrplAddress: env.MERCHANT_XRPL_ADDRESS!,
    expectedDrops: xrpToDrops(requiredXrp),
  })

  if (!match.matched) {
    fail(`Match failed [${match.failureCode}]: ${match.detail}`)
  }
  ok(`Reconciliation: ${match.reconciliation.outcome}`)
  ok(`Expected ${match.reconciliation.expectedAmount} XRP, received ${match.reconciliation.receivedAmount} XRP`)

  // -- Stage 7: on-chain record ----------------------------------------
  step(7, "Record on Coston2 (contract re-verifies the proof)")
  await registryClient.openPaymentIntent({
    paymentId: intent.id,
    merchantAddress: env.MERCHANT_FLARE_ADDRESS ?? (await tryGetSigner()!.getAddress()),
    sourceChain: "testXRP",
    sourceAsset: "XRP",
    destinationAddress: env.MERCHANT_XRPL_ADDRESS!,
    paymentReference: intent.paymentReference,
    minAmountSmallestUnit: match.attestedDrops,
    expiresAt: new Date(intent.expiresAt),
  })
  ok("Intent commitment written")

  const registered = await registryClient.registerVerifiedPayment(intent.id, proof)
  ok(`PaymentRegistry accepted the proof: ${registered.transactionHash}`)
  console.log(`  ${registered.explorerUrl}`)
  results["Coston2 verification tx"] = registered.transactionHash

  const onChain = await registryClient.getVerifiedPayment(intent.id)
  ok(`Independently readable on-chain: verified=${onChain?.verified}, amount=${onChain?.amount} drops`)

  // -- Stage 8: settlement ---------------------------------------------
  step(8, "Settlement")
  if (!preflight?.ok) {
    warn("SKIPPED — FAssets minting was reported unavailable in stage 2.")
    warn("The payment above is nonetheless fully verified and independently auditable on Coston2.")
  } else {
    warn(
      "FAssets minting requires the customer's XRP to have been sent to the *agent's* underlying\n" +
        "  address against a collateral reservation. Run the API flow (POST /v1/payments then\n" +
        "  select-asset) to exercise that path — the reservation must exist before the payment.\n" +
        "  See docs/settlement-flow.md.",
    )
  }

  banner("Proof of concept complete")
  summary(results)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function waitForPayment(
  address: string,
  reference: string,
  timeoutMs = 20 * 60_000,
): Promise<XrplPaymentTransaction> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const incoming = await getIncomingPayments(address, 20).catch(() => [])
    const found = incoming.find(
      (tx) =>
        tx.successful &&
        tx.isXrp &&
        tx.standardPaymentReference &&
        decodeStandardPaymentReference(tx.standardPaymentReference) === reference,
    )
    if (found) return found
    process.stdout.write(".")
    await new Promise((r) => setTimeout(r, 4_000))
  }
  fail(`No payment carrying reference ${reference} arrived within the timeout.`)
}

function parseArgs(argv: string[]) {
  const out: { amount?: string; tx?: string; check?: boolean; pay?: boolean; seed?: string } = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--amount") out.amount = argv[++i]
    else if (argv[i] === "--tx") out.tx = argv[++i]
    else if (argv[i] === "--check") out.check = true
    else if (argv[i] === "--pay") out.pay = true
    else if (argv[i] === "--seed") out.seed = argv[++i]
  }
  return out
}

/**
 * Sends the XRPL transfer this script is otherwise waiting for.
 *
 * Only reached under `--pay`. It exists so the whole path can run unattended, which matters
 * because the manual step sits in the middle: without it you start the script, go and use a
 * faucet UI that cannot set a memo, and come back to a timeout.
 *
 * A wallet is funded from the testnet faucet when no seed is available, and the seed is printed
 * so the same wallet can be reused rather than begging the faucet on every run.
 */
async function sendPayment(
  destination: string,
  amountXrp: string,
  memoDataHex: string,
  seed?: string,
): Promise<string> {
  const { Client, Wallet, xrpToDrops: toDrops } = await import("xrpl")

  const wsUrl = env.XRPL_WS_URL
  // The same guard pay.ts uses. A memo-carrying transfer to a mainnet address would be real money.
  if (!/altnet|testnet|devnet/i.test(wsUrl)) {
    fail(`XRPL_WS_URL does not look like a testnet endpoint: ${wsUrl}. Refusing to send.`)
  }

  const client = new Client(wsUrl)
  await client.connect()

  try {
    let wallet
    if (seed) {
      wallet = Wallet.fromSeed(seed)
      ok(`Paying from ${wallet.address}`)
    } else {
      ok("No XRPL_WALLET_SEED set — funding a throwaway testnet wallet…")

      // Uses faucet.altnet.rippletest.net, the official testnet faucet. It is occasionally slow
      // or rate limited, and when it is, the useful advice is to stop asking it for a new wallet
      // on every run rather than to find another faucet.
      const funded = await client.fundWallet().catch((error) => {
        fail(
          `The XRPL testnet faucet did not respond: ${error instanceof Error ? error.message : error}\n` +
            `  Reuse a funded wallet instead — it is faster than any faucet:\n` +
            `    set XRPL_WALLET_SEED in .env, or pass --seed sEd...\n` +
            `  To fund one by hand: https://faucet.altnet.rippletest.net/accounts\n` +
            `  Note: it must be XRPL *testnet*. FDC's testnet verifier does not index devnet.`,
        )
      })

      wallet = funded.wallet
      ok(`Funded ${wallet.address} with ${funded.balance} XRP`)
      console.log(`\n  Reuse this wallet by adding to .env:\n    XRPL_WALLET_SEED=${wallet.seed}\n`)
    }

    const balance = Number(await client.getXrpBalance(wallet.address).catch(() => 0))
    // XRPL holds a base reserve (1 XRP on testnet) that can never be spent.
    if (balance - 1 < Number(amountXrp)) {
      fail(
        `Wallet holds ${balance} XRP, which does not cover ${amountXrp} XRP plus the 1 XRP ` +
          `account reserve. Fund it at https://faucet.altnet.rippletest.net/accounts`,
      )
    }

    const result = await client.submitAndWait(
      {
        TransactionType: "Payment",
        Account: wallet.address,
        Destination: destination,
        Amount: toDrops(amountXrp),
        // Exactly one 32-byte memo. More than one, or a different length, and FDC reports an
        // empty standard payment reference and the transfer binds to nothing.
        Memos: [{ Memo: { MemoData: memoDataHex } }],
      },
      { wallet },
    )

    const meta = result.result.meta
    const code = typeof meta === "object" && meta ? meta.TransactionResult : "unknown"
    if (code !== "tesSUCCESS") fail(`XRPL rejected the payment: ${code}`)

    return result.result.hash
  } finally {
    await client.disconnect()
  }
}

function banner(text: string) {
  console.log(`\n${"=".repeat(72)}\n  ${text}\n${"=".repeat(72)}`)
}

function step(n: number, text: string) {
  console.log(`\n[${n}] ${text}\n${"-".repeat(72)}`)
}

function ok(text: string) {
  console.log(`  ✓ ${text}`)
}

function warn(text: string) {
  console.log(`  ! ${text}`)
}

function fail(text: string): never {
  console.error(`\n  ✗ ${text}\n`)
  process.exit(1)
}

function summary(results: Record<string, string>) {
  console.log("")
  for (const [label, value] of Object.entries(results)) {
    console.log(`  ${label.padEnd(26)} ${value}`)
  }
  console.log("")
}

main().catch((error) => {
  console.error("\n  ✗ Proof of concept failed:\n")
  console.error(error)
  process.exit(1)
})
