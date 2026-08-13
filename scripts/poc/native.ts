/**
 * PayFlux end-to-end proof of concept — both verification mechanisms, one run.
 *
 * PayFlux verifies two ways, and they cost very different amounts of time. This script proves
 * both against the same PaymentRegistry:
 *
 *   C2FLR   this chain      → the transaction is read directly     (~20 seconds)
 *   XRP     foreign chain   → FDC attestation and voting round     (~3 minutes)
 *
 * They are necessarily two separate payments. FDC's `Payment` attestation type reads XRPL and
 * UTXO ledgers, not EVM chains, so a Coston2 transfer cannot be attested — and the registry has
 * no entry point that would take such a proof if it could. Running both is the honest way to
 * show the full surface.
 *
 *   npx tsx scripts/poc/native.ts                 # both paths, using your .env
 *   npx tsx scripts/poc/native.ts --no-fdc        # native only, ~20 seconds
 *   npx tsx scripts/poc/native.ts --tx <HASH>     # attest an XRPL payment you already sent
 *   npx tsx scripts/poc/native.ts --check         # read-only, sends nothing
 *   npx tsx scripts/poc/native.ts --amount 0.5 --xrp 2
 *
 * Everything here is real: real transfers on both chains, real intent commitments, and registry
 * records anyone can read back. Nothing is simulated or stubbed.
 */
import { formatUnits, parseUnits } from "ethers"
import { env, NETWORKS } from "../../backend/src/config/env.js"
import { assertCoston2, getProvider, tryGetSigner } from "../../backend/src/chain/provider.js"
import * as registryClient from "../../backend/src/chain/payment-registry.js"
import * as fdc from "../../backend/src/verification/fdc.service.js"
import {
  encodeReferenceCalldata,
  verifyTransactionHash,
  currentBlock,
  formatAmount,
} from "../../backend/src/verification/coston2.payment.js"
import {
  buildMemo,
  getTransaction,
  dropsToXrp,
  decodeStandardPaymentReference,
} from "../../backend/src/verification/xrpl.payment.js"
import { generatePaymentReference } from "../../backend/src/payments/payment.service.js"
import { sendXrplPayment } from "./xrpl-send.js"

const args = parseArgs(process.argv.slice(2))
const AMOUNT_C2FLR = args.amount ?? "0.01"
/** The same threshold verifyNativePayment applies before treating a transfer as final. */
const CONFIRMATIONS = 2

async function main() {
  banner(args.noFdc ? "PayFlux proof of concept — native C2FLR" : "PayFlux proof of concept — native C2FLR + FDC attestation")
  const results: Record<string, string> = {}

  // -- Stage 0: environment -------------------------------------------
  step(0, "Environment and network")
  await assertCoston2()
  const network = await getProvider().getNetwork()
  ok(`Coston2 RPC reachable, chainId ${network.chainId}`)

  const signer = tryGetSigner()
  if (!signer) fail("COSTON2_PRIVATE_KEY is not set — nothing can be sent or recorded.")

  const from = await signer!.getAddress()
  const balance = await getProvider().getBalance(from)
  ok(`Signer ${from} holds ${formatUnits(balance, 18)} C2FLR`)
  if (balance === 0n) fail("Signer has no C2FLR. Fund it at https://faucet.flare.network/coston2")

  const merchantAddress = env.MERCHANT_FLARE_ADDRESS
  if (!merchantAddress) fail("MERCHANT_FLARE_ADDRESS is not set — there is nowhere to pay.")
  ok(`Merchant settlement address: ${merchantAddress}`)

  /*
   * A self-payment is the common case here, because the deployment default puts the signer and
   * the merchant at the same address. It still exercises every step honestly — the transfer,
   * the receipt, the matching and the registry write are all real — but the merchant's balance
   * cannot be observed to *rise*, since the same account paid the gas. Say so rather than
   * letting the run imply more than it proves.
   */
  const selfPayment = merchantAddress.toLowerCase() === from.toLowerCase()
  if (selfPayment) {
    warn("Signer and merchant are the same address, so this is a self-payment.")
    warn("Every stage is real; the balance-increase check is the one thing it cannot show.")
  }

  // -- Stage 1: registry ----------------------------------------------
  step(1, "PaymentRegistry on Coston2")
  const health = await registryClient.registryHealth()
  if (!health.available) fail(`PaymentRegistry unavailable: ${health.detail}`)
  ok(`PaymentRegistry:  ${health.address}`)
  results["PaymentRegistry"] = health.address!

  const amountWei = parseUnits(AMOUNT_C2FLR, 18)
  ok(`Payment amount:   ${AMOUNT_C2FLR} C2FLR`)

  if (args.check) {
    banner("Read-only check complete — nothing was sent")
    summary(results)
    return
  }

  // -- Stage 2: commit the intent before paying -----------------------
  step(2, "Commit the intent on-chain")
  const reference = generatePaymentReference()
  const paymentId = `poc_native_${Date.now()}`
  const expiresAt = new Date(Date.now() + 60 * 60_000)

  const opened = await registryClient.openPaymentIntent({
    paymentId,
    merchantAddress,
    sourceChain: "coston2",
    sourceAsset: "C2FLR",
    destinationAddress: merchantAddress,
    paymentReference: reference,
    minAmountSmallestUnit: amountWei,
    expiresAt,
  })
  ok(`Intent ${paymentId} committed`)
  ok(`Reference ${reference}`)
  console.log(`  ${opened.explorerUrl}`)
  results["Intent tx"] = opened.transactionHash

  // -- Stage 3: the payment -------------------------------------------
  step(3, "Send C2FLR carrying the reference")
  // Calldata is what binds this transfer to this intent. Matching on sender would break the
  // moment a customer paid from an exchange or paid twice.
  const sent = await signer!.sendTransaction({
    to: merchantAddress,
    value: amountWei,
    data: encodeReferenceCalldata(reference),
  })
  ok(`Sent ${sent.hash}`)
  const receipt = await sent.wait()
  if (!receipt || receipt.status !== 1) fail(`Transfer reverted (tx ${sent.hash})`)
  ok(`Mined in block ${receipt.blockNumber}`)
  console.log(`  ${NETWORKS.flare.txUrl(sent.hash)}`)
  results["Payment tx"] = sent.hash

  // -- Stage 4: confirmations -----------------------------------------
  step(4, `Wait for ${CONFIRMATIONS} confirmations`)
  process.stdout.write("  ")
  while ((await currentBlock()) - receipt.blockNumber < CONFIRMATIONS) {
    process.stdout.write("·")
    await new Promise((r) => setTimeout(r, 2_000))
  }
  console.log("")
  ok("Confirmed")

  // -- Stage 5: verify against the chain ------------------------------
  step(5, "Verify the transfer")
  // Read back from the chain rather than trusting what we just sent — this is the same call the
  // API makes when a client submits a transaction hash.
  const transfer = await verifyTransactionHash(sent.hash, merchantAddress, "C2FLR")
  ok(`Destination matches: ${transfer.to ?? merchantAddress}`)
  ok(`Amount:    ${formatAmount(transfer.amount, 18)} C2FLR`)
  ok(`Reference: ${transfer.reference ?? "(none decoded)"}`)

  if (transfer.reference !== reference) {
    fail(`Reference mismatch: chain says ${transfer.reference}, intent expects ${reference}`)
  }
  if (transfer.amount < amountWei) {
    fail(`Underpaid: ${formatAmount(transfer.amount, 18)} < ${AMOUNT_C2FLR}`)
  }
  ok("Transfer matches the committed intent")

  // -- Stage 6: record it ---------------------------------------------
  step(6, "Record the verified payment on Coston2")
  const recorded = await registryClient.recordNativePayment(
    paymentId,
    "C2FLR",
    sent.hash,
    transfer.amount,
  )
  ok(`Recorded: ${recorded.transactionHash}`)
  console.log(`  ${recorded.explorerUrl}`)
  results["Registry tx"] = recorded.transactionHash

  // Read it straight back off the chain. This is the record a third party can verify without
  // asking PayFlux anything, so proving it is readable is part of the proof.
  const onChain = await registryClient.getVerifiedPayment(paymentId)
  if (!onChain?.verified) fail("Registry does not report the payment as verified.")
  ok(`Registry confirms verified, amount ${formatAmount(BigInt(onChain.amount), 18)} C2FLR`)

  results["Payment id"] = paymentId
  results["Reference"] = reference

  if (args.noFdc) {
    banner("Complete — native path verified and recorded on Coston2")
    warn("FDC skipped (--no-fdc). Run without the flag to attest an XRPL payment too.")
    summary(results)
    return
  }

  await runFdcStage(results)

  banner("Complete — both verification mechanisms proven on Coston2")
  summary(results)
}

/**
 * The FDC half: an XRPL payment, attested, and recorded on the same registry.
 *
 * This is a *separate* payment from the C2FLR one above, and it has to be. FDC's `Payment`
 * attestation type reads UTXO-style and XRPL ledgers; it cannot attest a Coston2 transaction,
 * and PaymentRegistry has no entry point that would accept such a proof if it could. So the two
 * halves of this script prove two different mechanisms rather than the same payment twice:
 *
 *   C2FLR   this chain      → read the transaction directly     (seconds)
 *   XRP     foreign chain   → FDC attestation, voting round     (minutes)
 *
 * The wait below is not slowness. It is providers voting and a Merkle root being relayed, which
 * is the entire reason the resulting proof is worth anything.
 */
async function runFdcStage(results: Record<string, string>) {
  step(7, "FDC attestation — the cross-chain path")

  if (!env.MERCHANT_XRPL_ADDRESS) {
    warn("MERCHANT_XRPL_ADDRESS is not set — skipping the FDC stage.")
    return
  }

  let reference = generatePaymentReference()
  let hash = args.tx

  if (hash) {
    ok(`Attesting existing XRPL transaction ${hash}`)
  } else {
    ok(`Sending ${args.xrp} XRP to ${env.MERCHANT_XRPL_ADDRESS}`)
    hash = await sendXrplPayment(env.MERCHANT_XRPL_ADDRESS, args.xrp, buildMemo(reference).memoDataHex, {
      seed: args.seed ?? process.env.XRPL_WALLET_SEED,
      log: ok,
    })
    ok(`Sent ${hash}`)
  }

  const tx = await getTransaction(hash)
  if (!tx) fail(`XRPL transaction ${hash} could not be read back from the ledger.`)
  ok(`On ledger, delivering ${dropsToXrp(tx!.deliveredDrops)} XRP`)
  console.log(`  ${NETWORKS.xrpl.txUrl(hash)}`)
  results["XRPL tx"] = hash

  // With --tx the memo already exists and decides the reference; a freshly generated one would
  // simply not match what the attestation reports.
  if (tx!.standardPaymentReference) {
    reference = decodeStandardPaymentReference(tx!.standardPaymentReference)
    ok(`Reference from memo: ${reference}`)
  }

  /*
   * Commit the intent now, before the attestation — not after the proof arrives.
   *
   * The registry validates the intent against the attested response, so a wrong field here
   * reverts. Committing first means a mismatch surfaces in seconds; committing after the round
   * means paying for the attestation and waiting three minutes to be told the intent was never
   * going to be accepted. It is also the order the API itself uses: the expectation is on-chain
   * before the customer pays.
   */
  const xrplPaymentId = `poc_fdc_${Date.now()}`
  const opened = await registryClient.openPaymentIntent({
    paymentId: xrplPaymentId,
    merchantAddress: env.MERCHANT_FLARE_ADDRESS!,
    /*
     * The FDC source id, not a human-readable chain name.
     *
     * The contract compares this field byte-for-byte against `response.sourceId` from the
     * attestation and reverts with SourceMismatch when they differ, so it has to be the exact
     * value FDC reports — "testXRP". The API commits the same value for the same reason
     * (payment.service.ts).
     */
    sourceChain: "testXRP",
    sourceAsset: "XRP",
    destinationAddress: env.MERCHANT_XRPL_ADDRESS,
    paymentReference: reference,
    minAmountSmallestUnit: tx!.deliveredDrops,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  })
  ok(`Intent ${xrplPaymentId} committed before attesting`)
  results["FDC intent tx"] = opened.transactionHash

  // The verifier's indexer lags the ledger by a few seconds, so a transfer that is already final
  // on XRPL can still be reported as nonexistent. Retrying is the difference between a working
  // script and one that fails whenever it is quick.
  const prepared = await fdc.prepareXrpPaymentRequestWithRetry(hash, {
    onRetry: (attempt, detail) => {
      if (attempt === 1) console.log(`  … waiting for the verifier's indexer: ${detail}`)
      else process.stdout.write("·")
    },
  })
  ok(`Attestation request prepared, id ${prepared.requestId}`)

  const submitted = await fdc.submitAttestationRequest(prepared.abiEncodedRequest)
  ok(`Submitted on Coston2: ${submitted.transactionHash}`)
  ok(`Voting round ${submitted.votingRound}, fee ${formatUnits(submitted.fee, 18)} C2FLR`)
  console.log(`  ${submitted.explorerUrl}`)
  results["FDC request tx"] = submitted.transactionHash
  results["FDC voting round"] = String(submitted.votingRound)

  console.log("\n  Waiting for the voting round to finalize (a few minutes, genuinely)…")
  process.stdout.write("  ")
  const proof = await fdc.waitForProof(submitted.votingRound, prepared.abiEncodedRequest, {
    onTick: (attempt) => process.stdout.write(attempt % 6 === 0 ? "·" : ""),
  })
  console.log("")
  ok(`Proof retrieved, Merkle branch of ${proof.merkleProof.length}`)
  ok(`Attested amount: ${dropsToXrp(BigInt(proof.data.responseBody.receivedAmount))} XRP`)

  // The contract re-verifies this proof against Flare's own FdcVerification. A transaction that
  // succeeds here is proof the attestation was genuinely finalized by Flare, not by PayFlux.
  const recorded = await registryClient.registerVerifiedPayment(xrplPaymentId, proof)
  ok(`Registry accepted the proof: ${recorded.transactionHash}`)
  console.log(`  ${recorded.explorerUrl}`)
  results["FDC registry tx"] = recorded.transactionHash
}

function parseArgs(argv: string[]) {
  const out: {
    amount?: string
    check?: boolean
    noFdc?: boolean
    /** XRP sent for the attested payment. Small: this leg proves verification, not settlement. */
    xrp: string
    tx?: string
    seed?: string
  } = { xrp: "1" }

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--amount") out.amount = argv[++i]
    else if (argv[i] === "--check") out.check = true
    else if (argv[i] === "--no-fdc") out.noFdc = true
    else if (argv[i] === "--xrp") out.xrp = argv[++i]
    else if (argv[i] === "--tx") out.tx = argv[++i]
    else if (argv[i] === "--seed") out.seed = argv[++i]
  }
  return out
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
    console.log(`  ${label.padEnd(20)} ${value}`)
  }
  console.log("")
}

main().catch((error) => {
  console.error("\n  ✗ Proof of concept failed:\n")
  console.error(error)
  process.exit(1)
})
