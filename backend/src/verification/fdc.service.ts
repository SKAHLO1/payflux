import { Contract, keccak256 } from "ethers"
import { env, NETWORKS } from "../config/env.js"
import { getProvider, withSigner } from "../chain/provider.js"
import { resolve, tryResolve, FLARE_CONTRACTS } from "../chain/contract-registry.js"
import {
  ATTESTATION_TYPE_PAYMENT,
  decodePaymentResponse,
  type PaymentProof,
} from "./proof.js"
import { XRPL_SOURCE_ID } from "./xrpl.payment.js"

/**
 * The Flare Data Connector client.
 *
 * FDC is not a bridge. It produces *attestations* — signed, Merkle-committed statements that some
 * external-chain fact is true — which Flare contracts can then verify. PayFlux uses it to prove
 * "this XRPL payment happened, to this address, with this reference, for this amount" and does
 * nothing else with it (master prompt §4).
 *
 * The full round trip:
 *
 *   prepareRequest (verifier server)  ->  ABI-encoded attestation request
 *   requestAttestation (FdcHub)       ->  request enters a voting round
 *   wait for round finalization       ->  attestation providers vote, Merkle root is relayed
 *   proof-by-request-round (DA layer) ->  Merkle proof + attested response
 *   verifyPayment (FdcVerification)   ->  on-chain check against the relayed root
 *
 * Every stage below can fail loudly. None of them can be skipped or short-circuited.
 */

const FDC_HUB_ABI = [
  "function requestAttestation(bytes calldata _data) external payable",
]
const FEE_CONFIG_ABI = [
  "function getRequestFee(bytes calldata _data) external view returns (uint256)",
]
const SYSTEMS_MANAGER_ABI = [
  "function firstVotingRoundStartTs() external view returns (uint64)",
  "function votingEpochDurationSeconds() external view returns (uint64)",
]
const RELAY_ABI = [
  "function isFinalized(uint256 _protocolId, uint256 _votingRoundId) external view returns (bool)",
]

/** FDC's protocol id in the Flare Systems Protocol. */
export const FDC_PROTOCOL_ID = 200

export type FdcStage =
  | "prepare_request"
  | "submit_request"
  | "await_finalization"
  | "retrieve_proof"
  | "decode"

export class FdcError extends Error {
  constructor(
    readonly stage: FdcStage,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = "FdcError"
  }
}

export class FdcUnavailableError extends Error {
  readonly code = "FDC_UNAVAILABLE"
  constructor(readonly detail: string) {
    super(`FDC is UNAVAILABLE: ${detail}`)
    this.name = "FdcUnavailableError"
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — prepare the attestation request
// ---------------------------------------------------------------------------

export interface PrepareResult {
  abiEncodedRequest: string
  /** keccak of the encoded request; the DA layer keys proofs by this alongside the round. */
  requestId: string
}

export async function prepareXrpPaymentRequest(transactionId: string): Promise<PrepareResult> {
  if (!env.FDC_VERIFIER_API_KEY) {
    throw new FdcUnavailableError(
      "FDC_VERIFIER_API_KEY is empty. Leave it unset to use Flare's public testnet verifier key.",
    )
  }

  const url = `${env.FDC_VERIFIER_URL}/verifier/xrp/Payment/prepareRequest`
  const body = {
    attestationType: ATTESTATION_TYPE_PAYMENT,
    sourceId: sourceIdHex(XRPL_SOURCE_ID),
    requestBody: {
      transactionId: normalizeTxId(transactionId),
      inUtxo: "0",
      utxo: "0",
    },
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": env.FDC_VERIFIER_API_KEY,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new FdcError(
      "prepare_request",
      `verifier returned HTTP ${response.status}: ${await safeText(response)}`,
      response.status >= 500,
    )
  }

  const payload = (await response.json()) as {
    status?: string
    abiEncodedRequest?: string
  }

  // The verifier returns a status with an explanatory suffix — e.g.
  // "INVALID: TRANSACTION DOES NOT EXIST" — so match on the part before the colon. Comparing
  // the whole string would silently classify every INDETERMINATE as permanent and give up on a
  // transaction that simply had not been indexed yet.
  const status = payload.status ?? "UNKNOWN"
  const statusCode = status.split(":")[0].trim().toUpperCase()

  if (statusCode !== "VALID" || !payload.abiEncodedRequest) {
    const notIndexedYet = statusCode === "INDETERMINATE" || /DOES NOT EXIST/i.test(status)
    throw new FdcError(
      "prepare_request",
      `verifier rejected the request (status: ${status}).` +
        (notIndexedYet
          ? " The transaction may not have reached the verifier's indexer yet."
          : ""),
      notIndexedYet,
    )
  }

  return {
    abiEncodedRequest: payload.abiEncodedRequest,
    requestId: keccak256(payload.abiEncodedRequest),
  }
}

/**
 * Prepare, retrying while the verifier's indexer catches up.
 *
 * PayFlux's watcher reads XRPL directly and therefore sees a validated transaction *before* the
 * verifier's indexer does. Without this, the common case — we detect a payment the instant it
 * validates — fails immediately with "TRANSACTION DOES NOT EXIST" and the payment is marked
 * failed for a reason that would have resolved itself in seconds.
 */
export async function prepareXrpPaymentRequestWithRetry(
  transactionId: string,
  options: { attempts?: number; intervalMs?: number; onRetry?: (attempt: number, detail: string) => void } = {},
): Promise<PrepareResult> {
  const attempts = options.attempts ?? 10
  const intervalMs = options.intervalMs ?? 6_000

  let lastError: FdcError | undefined

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prepareXrpPaymentRequest(transactionId)
    } catch (error) {
      // A non-retryable rejection is a real mismatch — fail fast rather than burning the budget.
      if (!(error instanceof FdcError) || !error.retryable) throw error
      lastError = error
      options.onRetry?.(attempt, error.message)
      if (attempt < attempts) await sleep(intervalMs)
    }
  }

  throw (
    lastError ??
    new FdcError("prepare_request", `could not prepare an attestation for ${transactionId}`, true)
  )
}

// ---------------------------------------------------------------------------
// Stage 2 — submit the request on Coston2
// ---------------------------------------------------------------------------

export interface SubmitResult {
  transactionHash: string
  votingRound: number
  fee: string
  blockTimestamp: number
  explorerUrl: string
}

export async function submitAttestationRequest(abiEncodedRequest: string): Promise<SubmitResult> {
  // Serialized against every other signer write — see withSigner.
  return withSigner(async (signer) => {
  const [hubAddress, feeConfigAddress] = await Promise.all([
    resolve(FLARE_CONTRACTS.fdcHub),
    resolve(FLARE_CONTRACTS.fdcRequestFeeConfigurations),
  ])

  const feeConfig = new Contract(feeConfigAddress, FEE_CONFIG_ABI, getProvider())
  const fee: bigint = await feeConfig.getRequestFee(abiEncodedRequest)

  const hub = new Contract(hubAddress, FDC_HUB_ABI, signer)
  const tx = await hub.requestAttestation(abiEncodedRequest, { value: fee })
  const receipt = await tx.wait()

  if (!receipt || receipt.status !== 1) {
    throw new FdcError("submit_request", `requestAttestation reverted (tx ${tx.hash})`)
  }

  const block = await getProvider().getBlock(receipt.blockNumber)
  if (!block) throw new FdcError("submit_request", "could not read the submission block")

  const votingRound = await votingRoundForTimestamp(block.timestamp)

  return {
    transactionHash: tx.hash,
    votingRound,
    fee: fee.toString(),
    blockTimestamp: block.timestamp,
    explorerUrl: NETWORKS.flare.txUrl(tx.hash),
  }
  })
}

/** Maps a Coston2 block timestamp onto the FDC voting round that will carry the request. */
export async function votingRoundForTimestamp(timestamp: number): Promise<number> {
  const address = await resolve(FLARE_CONTRACTS.flareSystemsManager)
  const manager = new Contract(address, SYSTEMS_MANAGER_ABI, getProvider())
  const [firstStart, duration]: [bigint, bigint] = await Promise.all([
    manager.firstVotingRoundStartTs(),
    manager.votingEpochDurationSeconds(),
  ])
  return Math.floor((timestamp - Number(firstStart)) / Number(duration))
}

// ---------------------------------------------------------------------------
// Stage 3 — wait for the round to finalize
// ---------------------------------------------------------------------------

export async function isRoundFinalized(votingRound: number): Promise<boolean> {
  const relayAddress = await tryResolve(FLARE_CONTRACTS.relay)
  if (!relayAddress) return false
  const relay = new Contract(relayAddress, RELAY_ABI, getProvider())
  try {
    return await relay.isFinalized(FDC_PROTOCOL_ID, votingRound)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Stage 4 — retrieve the Merkle proof from the Data Availability layer
// ---------------------------------------------------------------------------

export async function retrieveProof(
  votingRound: number,
  abiEncodedRequest: string,
): Promise<PaymentProof | undefined> {
  const url = `${env.FDC_DA_LAYER_URL}/api/v1/fdc/proof-by-request-round-raw`
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (env.FDC_DA_LAYER_API_KEY) headers["X-API-KEY"] = env.FDC_DA_LAYER_API_KEY

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ votingRoundId: votingRound, requestBytes: abiEncodedRequest }),
  })

  // The DA layer answers 400 while a round is still open — that is "not yet", not "never".
  if (response.status === 400 || response.status === 404) return undefined
  if (!response.ok) {
    throw new FdcError(
      "retrieve_proof",
      `DA layer returned HTTP ${response.status}: ${await safeText(response)}`,
      response.status >= 500,
    )
  }

  const payload = (await response.json()) as {
    proof?: string[]
    response_hex?: string
    responseHex?: string
  }

  const responseHex = payload.response_hex ?? payload.responseHex
  if (!payload.proof || !responseHex) return undefined

  return {
    merkleProof: payload.proof,
    data: decodePaymentResponse(responseHex),
  }
}

/**
 * Polls for the proof until the round finalizes.
 *
 * Rounds are 90s; finalization typically lands within a few minutes. There is no way to make
 * this faster and no reason to pretend otherwise, so the UI shows this wait honestly rather than
 * animating a fake progress bar.
 */
export async function waitForProof(
  votingRound: number,
  abiEncodedRequest: string,
  options: { timeoutMs?: number; intervalMs?: number; onTick?: (attempt: number) => void } = {},
): Promise<PaymentProof> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const intervalMs = options.intervalMs ?? 10_000
  const deadline = Date.now() + timeoutMs

  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    options.onTick?.(attempt)
    const proof = await retrieveProof(votingRound, abiEncodedRequest)
    if (proof) return proof
    await sleep(intervalMs)
  }

  throw new FdcError(
    "await_finalization",
    `voting round ${votingRound} did not produce a retrievable proof within ${Math.round(
      timeoutMs / 1000,
    )}s`,
    true,
  )
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface FdcHealth {
  verifierConfigured: boolean
  hubAddress?: string
  verificationAddress?: string
  feeConfigAddress?: string
  relayAddress?: string
  dataAvailabilityUrl: string
  reachable: boolean
  detail?: string
}

export async function fdcHealth(): Promise<FdcHealth> {
  const base: FdcHealth = {
    verifierConfigured: Boolean(env.FDC_VERIFIER_API_KEY),
    dataAvailabilityUrl: env.FDC_DA_LAYER_URL,
    reachable: false,
  }

  try {
    const [hub, verification, feeConfig, relay] = await Promise.all([
      tryResolve(FLARE_CONTRACTS.fdcHub),
      tryResolve(FLARE_CONTRACTS.fdcVerification),
      tryResolve(FLARE_CONTRACTS.fdcRequestFeeConfigurations),
      tryResolve(FLARE_CONTRACTS.relay),
    ])
    return {
      ...base,
      hubAddress: hub,
      verificationAddress: verification,
      feeConfigAddress: feeConfig,
      relayAddress: relay,
      reachable: Boolean(hub && verification),
    }
  } catch (error) {
    return { ...base, detail: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sourceIdHex(sourceId: string): string {
  return `0x${Buffer.from(sourceId, "utf8").toString("hex").padEnd(64, "0")}`
}

/** XRPL hashes are unprefixed uppercase hex; FDC wants 0x-prefixed bytes32. */
function normalizeTxId(txId: string): string {
  const clean = txId.startsWith("0x") ? txId.slice(2) : txId
  return `0x${clean.toLowerCase().padStart(64, "0")}`
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return "<no body>"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
