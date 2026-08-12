import { Contract, Wallet, id as keccakId, encodeBytes32String } from "ethers"
import { env, NETWORKS } from "../config/env.js"
import { getProvider, getSigner, tryGetSigner, withSigner } from "./provider.js"
import { encodeStandardPaymentReference, hashXrplAddress } from "../verification/xrpl.payment.js"
import { toContractProof, type PaymentProof } from "../verification/proof.js"

/**
 * Client for the deployed PaymentRegistry on Coston2.
 *
 * The registry is what makes a PayFlux payment independently auditable: anyone with the payment
 * id can read the verified record straight off Coston2, without asking PayFlux anything.
 */

const REGISTRY_ABI = [
  "function openPaymentIntent((bytes32 paymentId,address merchant,bytes32 sourceChain,bytes32 sourceAsset,bytes32 destinationAddressHash,bytes32 paymentReference,uint256 minAmount,uint64 expiresAt,bool open) intent) external",
  "function closePaymentIntent(bytes32 paymentId, bytes32 reason) external",
  "function registerVerifiedPayment(bytes32 paymentId, (bytes32[] merkleProof,(bytes32 attestationType,bytes32 sourceId,uint64 votingRound,uint64 lowestUsedTimestamp,(bytes32 transactionId,uint256 inUtxo,uint256 utxo) requestBody,(uint64 blockNumber,uint64 blockTimestamp,bytes32 sourceAddressHash,bytes32 sourceAddressesRoot,bytes32 receivingAddressHash,bytes32 intendedReceivingAddressHash,int256 spentAmount,int256 intendedSpentAmount,int256 receivedAmount,int256 intendedReceivedAmount,bytes32 standardPaymentReference,bool oneToOne,uint8 status) responseBody) data) proof) external",
  "function recordNativePayment(bytes32 paymentId, bytes32 sourceAsset, bytes32 transactionHash, uint256 amount) external",
  "function getVerifiedPayment(bytes32 paymentId) external view returns ((bytes32 paymentId,address merchant,bytes32 sourceChain,bytes32 sourceAsset,bytes32 externalTransactionId,uint256 amount,uint256 timestamp,bool verified,bytes32 verificationType) )",
  "function getPaymentIntent(bytes32 paymentId) external view returns ((bytes32 paymentId,address merchant,bytes32 sourceChain,bytes32 sourceAsset,bytes32 destinationAddressHash,bytes32 paymentReference,uint256 minAmount,uint64 expiresAt,bool open) )",
  "function isVerified(bytes32 paymentId) external view returns (bool)",
  "function fdcVerification() external view returns (address)",
  "event PaymentVerified(bytes32 indexed paymentId, address indexed merchant, bytes32 sourceChain, bytes32 sourceAsset, uint256 amount, bytes32 externalTransactionId)",

  // Custom errors must be in the ABI or ethers cannot decode a revert, and every failure
  // degrades to the useless "missing revert data". These are the difference between "the
  // registry said no" and knowing exactly which check failed and with what values.
  "error IntentAlreadyExists(bytes32 paymentId)",
  "error IntentUnknown(bytes32 paymentId)",
  "error IntentClosed(bytes32 paymentId)",
  "error IntentExpired(bytes32 paymentId, uint64 expiresAt, uint64 blockTimestamp)",
  "error PaymentAlreadyRegistered(bytes32 paymentId)",
  "error TransactionAlreadyUsed(bytes32 externalTransactionId, bytes32 paymentId)",
  "error InvalidFdcProof()",
  "error UnexpectedAttestationType(bytes32 attestationType)",
  "error SourceMismatch(bytes32 expected, bytes32 actual)",
  "error DestinationMismatch(bytes32 expected, bytes32 actual)",
  "error ReferenceMismatch(bytes32 expected, bytes32 actual)",
  "error AmountBelowMinimum(uint256 minAmount, uint256 receivedAmount)",
  "error SourceTransactionFailed(uint8 status)",
  "error InvalidMerchant()",
  // OpenZeppelin
  "error EnforcedPause()",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]

export class RegistryUnavailableError extends Error {
  readonly code = "PAYMENT_REGISTRY_UNAVAILABLE"
  constructor(detail: string) {
    super(`PaymentRegistry is UNAVAILABLE: ${detail}`)
    this.name = "RegistryUnavailableError"
  }
}

/**
 * A registry revert with its custom error decoded.
 *
 * The name is the point. `PaymentAlreadyRegistered` and `TransactionAlreadyUsed` mean the write
 * this call was trying to make has already happened — success arriving by an unexpected route,
 * not a rejection. Every other name is a real refusal. Callers have to tell those apart, and
 * matching on message text would break on the next contract revision.
 */
export class RegistryRevertError extends Error {
  readonly code = "PAYMENT_REGISTRY_REVERTED"
  constructor(
    readonly revertName: string | undefined,
    detail: string,
  ) {
    super(`PaymentRegistry reverted: ${detail}`)
    this.name = "RegistryRevertError"
  }
}

/** Reverts that mean the payment is already on the registry — by us, or by another worker. */
const ALREADY_RECORDED = ["PaymentAlreadyRegistered", "TransactionAlreadyUsed"]

export function isAlreadyRegistered(error: unknown): boolean {
  return error instanceof RegistryRevertError && ALREADY_RECORDED.includes(error.revertName ?? "")
}

/**
 * The decoded custom error name, when ethers could resolve one against the ABI.
 *
 * Undefined for reverts with no data and for plain RPC failures — a timeout is not a rejection,
 * and must never be mistaken for one.
 */
function revertName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  return (error as { revert?: { name?: string } }).revert?.name
}

export function registryAddress(): string | undefined {
  return env.PAYMENT_REGISTRY_ADDRESS
}

function readContract(): Contract {
  const address = registryAddress()
  if (!address) {
    throw new RegistryUnavailableError(
      "PAYMENT_REGISTRY_ADDRESS is not set. Deploy contracts/PaymentRegistry.sol to Coston2 first.",
    )
  }
  return new Contract(address, REGISTRY_ABI, getProvider())
}

function writeContract(signer: Wallet): Contract {
  const address = registryAddress()
  if (!address) {
    throw new RegistryUnavailableError("PAYMENT_REGISTRY_ADDRESS is not set.")
  }
  return new Contract(address, REGISTRY_ABI, signer)
}

/** Payment ids are keccak of the PayFlux id, so they fit bytes32 without truncation. */
export function toPaymentIdBytes32(paymentId: string): string {
  return keccakId(paymentId)
}

/**
 * Normalises a payment reference to the bytes32 FDC will report.
 *
 * Two shapes reach here. A PayFlux reference (`pay_8F92K2`) is UTF-8 padded to 32 bytes. An
 * FAssets reference is *already* a bytes32 dictated by the AssetManager — UTF-8 encoding that
 * hex string would produce a value nothing on-chain ever matches.
 */
export function toBytes32Reference(reference: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(reference)) return reference.toLowerCase()
  return encodeStandardPaymentReference(reference)
}

export interface OpenIntentParams {
  paymentId: string
  merchantAddress: string
  sourceChain: string
  sourceAsset: string
  destinationAddress: string
  paymentReference: string
  minAmountSmallestUnit: bigint
  expiresAt: Date
}

export interface RegistryWriteResult {
  transactionHash: string
  blockNumber: number
  explorerUrl: string
}

/** Commits the merchant's expectation on-chain, before the customer pays. */
export async function openPaymentIntent(params: OpenIntentParams): Promise<RegistryWriteResult> {
  return withSigner(async (signer) => {
  const contract = writeContract(signer)
  const tx = await contract.openPaymentIntent({
    paymentId: toPaymentIdBytes32(params.paymentId),
    merchant: params.merchantAddress,
    sourceChain: encodeBytes32String(params.sourceChain),
    sourceAsset: encodeBytes32String(params.sourceAsset),
    destinationAddressHash: hashXrplAddress(params.destinationAddress),
    paymentReference: toBytes32Reference(params.paymentReference),
    minAmount: params.minAmountSmallestUnit,
    expiresAt: Math.floor(params.expiresAt.getTime() / 1000),
    open: true,
  })
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) {
    throw new RegistryUnavailableError(`openPaymentIntent reverted (tx ${tx.hash})`)
  }
  return {
    transactionHash: tx.hash,
    blockNumber: receipt.blockNumber,
    explorerUrl: NETWORKS.flare.txUrl(tx.hash),
  }
  })
}

/**
 * Submits the FDC proof on Coston2. The contract re-verifies it against FdcVerification, so a
 * successful transaction here is proof the attestation was genuinely finalized by Flare.
 */
export async function registerVerifiedPayment(
  paymentId: string,
  proof: PaymentProof,
): Promise<RegistryWriteResult> {
  return withSigner(async (signer) => {
  const contract = writeContract(signer)
  const encoded = toContractProof(proof)
  const idBytes = toPaymentIdBytes32(paymentId)

  // Simulate first so a mismatch surfaces as a precise custom error instead of a lost fee.
  // This is also where a duplicate registration is caught, before it costs anything.
  try {
    await contract.registerVerifiedPayment.staticCall(idBytes, encoded)
  } catch (error) {
    throw new RegistryRevertError(
      revertName(error),
      `registerVerifiedPayment would revert: ${decodeRevert(error)}`,
    )
  }

  const tx = await contract.registerVerifiedPayment(idBytes, encoded)
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) {
    throw new RegistryUnavailableError(`registerVerifiedPayment reverted (tx ${tx.hash})`)
  }
  return {
    transactionHash: tx.hash,
    blockNumber: receipt.blockNumber,
    explorerUrl: NETWORKS.flare.txUrl(tx.hash),
  }
  })
}

export async function recordNativePayment(
  paymentId: string,
  sourceAsset: string,
  transactionHash: string,
  amount: bigint,
): Promise<RegistryWriteResult> {
  return withSigner(async (signer) => {
  const contract = writeContract(signer)

  // No separate simulation here — ethers estimates gas before sending, so a revert surfaces
  // from that estimate with its custom error intact and nothing is spent. Decoding it matters
  // for the same reason as above: a duplicate must be distinguishable from a rejection.
  let tx
  try {
    tx = await contract.recordNativePayment(
      toPaymentIdBytes32(paymentId),
      encodeBytes32String(sourceAsset),
      transactionHash,
      amount,
    )
  } catch (error) {
    throw new RegistryRevertError(
      revertName(error),
      `recordNativePayment would revert: ${decodeRevert(error)}`,
    )
  }

  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) {
    throw new RegistryUnavailableError(`recordNativePayment reverted (tx ${tx.hash})`)
  }
  return {
    transactionHash: tx.hash,
    blockNumber: receipt.blockNumber,
    explorerUrl: NETWORKS.flare.txUrl(tx.hash),
  }
  })
}

export async function closePaymentIntent(
  paymentId: string,
  reason: string,
): Promise<RegistryWriteResult> {
  return withSigner(async (signer) => {
  const contract = writeContract(signer)
  const tx = await contract.closePaymentIntent(
    toPaymentIdBytes32(paymentId),
    encodeBytes32String(reason.slice(0, 31)),
  )
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) {
    throw new RegistryUnavailableError(`closePaymentIntent reverted (tx ${tx.hash})`)
  }
  return {
    transactionHash: tx.hash,
    blockNumber: receipt.blockNumber,
    explorerUrl: NETWORKS.flare.txUrl(tx.hash),
  }
  })
}

/** Reads the on-chain record. This is what a judge can independently verify. */
export async function getVerifiedPayment(paymentId: string) {
  const record = await readContract().getVerifiedPayment(toPaymentIdBytes32(paymentId))
  if (!record.verified) return undefined
  return {
    paymentId: record.paymentId as string,
    merchant: record.merchant as string,
    amount: (record.amount as bigint).toString(),
    externalTransactionId: record.externalTransactionId as string,
    timestamp: Number(record.timestamp),
    verified: record.verified as boolean,
    verificationType: record.verificationType as string,
  }
}

export async function registryHealth() {
  const address = registryAddress()
  if (!address) {
    return {
      available: false,
      detail: "PAYMENT_REGISTRY_ADDRESS is not set — the registry has not been deployed yet.",
    }
  }
  try {
    const code = await getProvider().getCode(address)
    if (code === "0x") {
      return { available: false, address, detail: "No contract code at the configured address." }
    }
    const fdcVerification = await readContract().fdcVerification()
    return {
      available: true,
      address,
      fdcVerification,
      canWrite: Boolean(tryGetSigner()),
      explorer: NETWORKS.flare.addressUrl(address),
    }
  } catch (error) {
    return {
      available: false,
      address,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function decodeRevert(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const anyError = error as { shortMessage?: string; reason?: string; message?: string }
    return anyError.shortMessage ?? anyError.reason ?? anyError.message ?? String(error)
  }
  return String(error)
}

/** Diagnostic read of the committed intent, for comparing against an attestation. */
export async function getPaymentIntentRaw(paymentId: string) {
  return readContract().getPaymentIntent(toPaymentIdBytes32(paymentId))
}
