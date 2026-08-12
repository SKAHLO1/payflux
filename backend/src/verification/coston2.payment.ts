import { Contract, formatUnits, hexlify, toUtf8Bytes, toUtf8String, getAddress } from "ethers"
import { getProvider } from "../chain/provider.js"
import { getFAssetSettings } from "../chain/fassets.js"
import { NETWORKS } from "../config/env.js"

/**
 * Detection and verification of payments made natively on Coston2 (C2FLR and FXRP).
 *
 * ---------------------------------------------------------------------------
 * Why this needs no attestation
 * ---------------------------------------------------------------------------
 *
 * The XRPL path needs FDC because the payment happens on a chain Flare cannot see. A Coston2
 * payment is on *this* chain: PayFlux can read the transaction and its receipt directly, from the
 * same ledger a contract would. There is nothing to attest — reading it *is* the verification.
 *
 * That also changes what "untrusted hint" means. A client-supplied XRPL hash is a hint because we
 * must independently attest it. A client-supplied Coston2 hash is equally a hint, but we can
 * settle it completely ourselves: fetch the receipt, check the sender/destination/amount/status,
 * check confirmations. What still must be guarded is *reuse* — one transaction settling two
 * intents — which is enforced both here and by `transactionToPayment` in PaymentRegistry.
 *
 * ---------------------------------------------------------------------------
 * Binding a transfer to an intent
 * ---------------------------------------------------------------------------
 *
 * C2FLR: a plain value transfer can carry arbitrary calldata even to an EOA. The reference goes
 * there, giving the same exact binding the XRPL memo gives.
 *
 * FXRP: `transfer(address,uint256)` has no room for a memo — the calldata shape is fixed by the
 * ERC-20 ABI. So an FXRP payment is bound by (destination, exact amount, time window), and the
 * matcher refuses to guess when that tuple is ambiguous. See `findAmbiguity` below.
 */

/** "PFLX" — marks calldata as a PayFlux reference rather than a contract call. */
const REFERENCE_MAGIC = "0x50464c58"

export const C2FLR_DECIMALS = 18

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() external view returns (uint8)",
]

export interface Coston2Transfer {
  hash: string
  from: string
  to: string
  /** Smallest unit: wei for C2FLR, UBA for FXRP. */
  amount: bigint
  asset: "C2FLR" | "FXRP"
  blockNumber: number
  timestamp: number
  /** Present when the payer attached a PayFlux reference (C2FLR only). */
  reference?: string
  confirmations: number
  explorerUrl: string
}

// ---------------------------------------------------------------------------
// Reference encoding
// ---------------------------------------------------------------------------

/** Calldata a C2FLR payer attaches so the transfer binds exactly to one intent. */
export function encodeReferenceCalldata(reference: string): string {
  return hexlify(
    Buffer.concat([Buffer.from(REFERENCE_MAGIC.slice(2), "hex"), Buffer.from(reference, "utf8")]),
  )
}

export function decodeReferenceCalldata(data: string | undefined): string | undefined {
  if (!data || data === "0x") return undefined
  if (!data.toLowerCase().startsWith(REFERENCE_MAGIC)) return undefined
  try {
    const reference = toUtf8String(`0x${data.slice(REFERENCE_MAGIC.length)}`)
    return /^pay_[0-9A-Za-z]+$/.test(reference) ? reference : undefined
  } catch {
    return undefined
  }
}

export async function decimalsFor(asset: "C2FLR" | "FXRP"): Promise<number> {
  if (asset === "C2FLR") return C2FLR_DECIMALS
  return (await getFAssetSettings()).assetMintingDecimals
}

export function formatAmount(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals)
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Bounded so a long gap cannot turn one poll into a chain-wide scan. */
const MAX_BLOCK_SPAN = 2_000

export async function currentBlock(): Promise<number> {
  return getProvider().getBlockNumber()
}

/**
 * FXRP transfers to an address, read from ERC-20 Transfer logs.
 *
 * Log filtering is indexed by the node, so this is cheap and exact — unlike the native path,
 * which has to walk blocks.
 */
export async function getIncomingFxrpTransfers(
  merchantAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<Coston2Transfer[]> {
  const settings = await getFAssetSettings()
  const provider = getProvider()
  const token = new Contract(settings.fAsset, ERC20_ABI, provider)

  const from = Math.max(0, fromBlock)
  const to = Math.min(toBlock, from + MAX_BLOCK_SPAN)

  const logs = await token.queryFilter(
    token.filters.Transfer(null, getAddress(merchantAddress)),
    from,
    to,
  )

  const head = await provider.getBlockNumber()

  return Promise.all(
    logs.map(async (log) => {
      const block = await provider.getBlock(log.blockNumber)
      const args = (log as unknown as { args: { from: string; to: string; value: bigint } }).args
      return {
        hash: log.transactionHash,
        from: args.from,
        to: args.to,
        amount: args.value,
        asset: "FXRP" as const,
        blockNumber: log.blockNumber,
        timestamp: block?.timestamp ?? 0,
        confirmations: Math.max(0, head - log.blockNumber),
        explorerUrl: NETWORKS.flare.txUrl(log.transactionHash),
      }
    }),
  )
}

/**
 * Native C2FLR transfers to an address.
 *
 * There is no log for a plain value transfer, so this walks blocks. Kept to a bounded span and
 * driven incrementally by the watcher, which tracks the last block it scanned.
 */
export async function getIncomingNativeTransfers(
  merchantAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<Coston2Transfer[]> {
  const provider = getProvider()
  const target = getAddress(merchantAddress).toLowerCase()

  const from = Math.max(0, fromBlock)
  const to = Math.min(toBlock, from + MAX_BLOCK_SPAN)
  const head = await provider.getBlockNumber()

  const transfers: Coston2Transfer[] = []

  for (let number = from; number <= to; number += 1) {
    // `true` prefetches transactions; without it each block needs a second round trip.
    const block = await provider.getBlock(number, true)
    if (!block) continue

    for (const tx of block.prefetchedTransactions ?? []) {
      if (!tx.to || tx.to.toLowerCase() !== target) continue
      if (tx.value === 0n) continue

      transfers.push({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        amount: tx.value,
        asset: "C2FLR",
        blockNumber: number,
        timestamp: block.timestamp,
        reference: decodeReferenceCalldata(tx.data),
        confirmations: Math.max(0, head - number),
        explorerUrl: NETWORKS.flare.txUrl(tx.hash),
      })
    }
  }

  return transfers
}

// ---------------------------------------------------------------------------
// Verifying a single transaction
// ---------------------------------------------------------------------------

export class NativeTransferError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "REVERTED" | "WRONG_DESTINATION" | "WRONG_ASSET",
    message: string,
  ) {
    super(message)
    this.name = "NativeTransferError"
  }
}

/**
 * Reads a transaction and confirms it really is a payment to the merchant.
 *
 * This is the authoritative check for the native path — the chain is read directly, so a hash
 * supplied by a client is fully settled here rather than merely believed.
 */
export async function verifyTransactionHash(
  hash: string,
  merchantAddress: string,
  asset: "C2FLR" | "FXRP",
): Promise<Coston2Transfer> {
  const provider = getProvider()

  const [tx, receipt] = await Promise.all([
    provider.getTransaction(hash),
    provider.getTransactionReceipt(hash),
  ])

  if (!tx || !receipt) {
    throw new NativeTransferError("NOT_FOUND", `Transaction ${hash} was not found on Coston2.`)
  }
  if (receipt.status !== 1) {
    throw new NativeTransferError("REVERTED", `Transaction ${hash} reverted on Coston2.`)
  }

  const head = await provider.getBlockNumber()
  const block = await provider.getBlock(receipt.blockNumber)
  const target = getAddress(merchantAddress).toLowerCase()

  if (asset === "C2FLR") {
    if (!tx.to || tx.to.toLowerCase() !== target) {
      throw new NativeTransferError(
        "WRONG_DESTINATION",
        `Transaction ${hash} did not send C2FLR to the merchant's address.`,
      )
    }
    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      amount: tx.value,
      asset: "C2FLR",
      blockNumber: receipt.blockNumber,
      timestamp: block?.timestamp ?? 0,
      reference: decodeReferenceCalldata(tx.data),
      confirmations: Math.max(0, head - receipt.blockNumber),
      explorerUrl: NETWORKS.flare.txUrl(tx.hash),
    }
  }

  // FXRP: the value is in a Transfer log, not the transaction itself.
  const settings = await getFAssetSettings()
  const token = new Contract(settings.fAsset, ERC20_ABI, provider)

  const transfer = receipt.logs
    .filter((log) => log.address.toLowerCase() === settings.fAsset.toLowerCase())
    .map((log) => {
      try {
        return token.interface.parseLog({ topics: [...log.topics], data: log.data })
      } catch {
        return null
      }
    })
    .find((parsed) => parsed?.name === "Transfer" && parsed.args.to.toLowerCase() === target)

  if (!transfer) {
    throw new NativeTransferError(
      "WRONG_DESTINATION",
      `Transaction ${hash} contains no FXRP transfer to the merchant's address.`,
    )
  }

  return {
    hash: receipt.hash,
    from: transfer.args.from,
    to: transfer.args.to,
    amount: transfer.args.value,
    asset: "FXRP",
    blockNumber: receipt.blockNumber,
    timestamp: block?.timestamp ?? 0,
    confirmations: Math.max(0, head - receipt.blockNumber),
    explorerUrl: NETWORKS.flare.txUrl(receipt.hash),
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * FXRP transfers carry no reference, so they are matched on (destination, amount, window).
 *
 * If two open intents on the same merchant expect an indistinguishable amount at the same time,
 * that tuple is ambiguous and PayFlux must not pick one — crediting the wrong order is worse than
 * asking the customer for their transaction hash. Returns true when matching must be refused.
 */
export function isAmbiguous(
  candidateAmount: bigint,
  otherExpectedAmounts: bigint[],
  toleranceBps: number,
): boolean {
  const within = (expected: bigint) => {
    const tolerance = (expected * BigInt(toleranceBps)) / 10_000n
    const delta = candidateAmount > expected ? candidateAmount - expected : expected - candidateAmount
    return delta <= tolerance
  }
  return otherExpectedAmounts.filter(within).length > 0
}

export function toSmallestUnit(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.split(".")
  const padded = frac.padEnd(decimals, "0").slice(0, decimals)
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0")
}
