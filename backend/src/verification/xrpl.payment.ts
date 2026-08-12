import { hexlify, toUtf8Bytes, zeroPadBytes, keccak256 } from "ethers"
import { env, NETWORKS } from "../config/env.js"

/**
 * XRPL Testnet access and the reference-binding scheme.
 *
 * Binding a transfer to a payment intent is the part most crypto checkouts get wrong: they match
 * on sender address, which breaks the moment a customer pays from an exchange or pays twice.
 * PayFlux binds on XRPL's *standard payment reference* — a 32-byte memo that FDC itself decodes
 * and reports in the attestation, so the binding is verified by Flare rather than trusted from
 * our own database (master prompt §8).
 */

export const XRPL_SOURCE_ID = "testXRP"
export const DROPS_PER_XRP = 1_000_000n

/** PayFlux reference (`pay_8F92K2`) -> the 32-byte value FDC will report. */
export function encodeStandardPaymentReference(reference: string): string {
  const bytes = toUtf8Bytes(reference)
  if (bytes.length > 32) {
    throw new Error(`Payment reference "${reference}" exceeds 32 bytes.`)
  }
  return zeroPadBytes(bytes, 32)
}

export function decodeStandardPaymentReference(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = Buffer.from(clean, "hex")
  const end = bytes.indexOf(0)
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8")
}

/**
 * FDC reports addresses as keccak256 of the UTF-8 address string, never the address itself.
 * We hash the merchant address the same way so the on-chain comparison is exact.
 */
export function hashXrplAddress(address: string): string {
  return keccak256(toUtf8Bytes(address))
}

/** The memo a customer's wallet must attach for the payment to be bindable. */
export function buildMemo(reference: string): { memoDataHex: string; humanHint: string } {
  const encoded = encodeStandardPaymentReference(reference)
  return {
    memoDataHex: encoded.slice(2).toUpperCase(),
    humanHint: `Attach memo data ${encoded.slice(2).toUpperCase()} (this encodes ${reference}).`,
  }
}

export function xrpToDrops(xrp: string): bigint {
  const [whole, frac = ""] = xrp.split(".")
  const padded = frac.padEnd(6, "0").slice(0, 6)
  return BigInt(whole || "0") * DROPS_PER_XRP + BigInt(padded || "0")
}

export function dropsToXrp(drops: bigint): string {
  const whole = drops / DROPS_PER_XRP
  const frac = (drops % DROPS_PER_XRP).toString().padStart(6, "0").replace(/0+$/, "")
  return `${whole}${frac ? `.${frac}` : ""}`
}

// ---------------------------------------------------------------------------
// XRPL JSON-RPC
// ---------------------------------------------------------------------------

interface XrplRpcResponse<T> {
  result: T & { status?: string; error?: string; error_message?: string }
}

async function xrplRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(env.XRPL_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
  })

  if (!response.ok) {
    throw new Error(`XRPL RPC ${method} failed: HTTP ${response.status}`)
  }

  const body = (await response.json()) as XrplRpcResponse<T>
  if (body.result?.status === "error") {
    throw new Error(`XRPL RPC ${method} error: ${body.result.error_message ?? body.result.error}`)
  }
  return body.result
}

export interface XrplPaymentTransaction {
  hash: string
  account: string
  destination: string
  destinationTag?: number
  /** Delivered amount in drops. Only meaningful for XRP (not issued currencies). */
  deliveredDrops: bigint
  isXrp: boolean
  validated: boolean
  successful: boolean
  ledgerIndex: number
  /** Standard payment reference as FDC would compute it, or undefined if absent/ambiguous. */
  standardPaymentReference?: string
  memos: string[]
  date?: number
}

interface RawTx {
  hash?: string
  Account?: string
  Destination?: string
  DestinationTag?: number
  TransactionType?: string
  Amount?: string | { currency: string; value: string; issuer: string }
  Memos?: Array<{ Memo: { MemoData?: string } }>
  validated?: boolean
  ledger_index?: number
  date?: number
  meta?: { TransactionResult?: string; delivered_amount?: string | Record<string, unknown> }
  metaData?: { TransactionResult?: string; delivered_amount?: string | Record<string, unknown> }
}

function parseTx(raw: RawTx): XrplPaymentTransaction {
  const meta = raw.meta ?? raw.metaData ?? {}
  const delivered = meta.delivered_amount ?? raw.Amount
  const isXrp = typeof delivered === "string"

  // FDC derives the standard payment reference from a single 32-byte memo. Anything else is
  // treated as "no reference" rather than guessed at.
  const memos = (raw.Memos ?? []).map((m) => m.Memo?.MemoData ?? "").filter(Boolean)
  const candidates = memos.filter((m) => m.length === 64 && /^[0-9a-fA-F]+$/.test(m))
  const standardPaymentReference = candidates.length === 1 ? `0x${candidates[0].toLowerCase()}` : undefined

  return {
    hash: raw.hash ?? "",
    account: raw.Account ?? "",
    destination: raw.Destination ?? "",
    destinationTag: raw.DestinationTag,
    deliveredDrops: isXrp ? BigInt(delivered as string) : 0n,
    isXrp,
    validated: Boolean(raw.validated),
    successful: meta.TransactionResult === "tesSUCCESS",
    ledgerIndex: raw.ledger_index ?? 0,
    standardPaymentReference,
    memos,
    date: raw.date,
  }
}

/** Fetch a single transaction. Used to sanity-check a hint before spending an FDC request fee. */
export async function getTransaction(txHash: string): Promise<XrplPaymentTransaction | undefined> {
  try {
    const raw = await xrplRpc<RawTx>("tx", { transaction: txHash, binary: false })
    if (raw.TransactionType !== "Payment") return undefined
    return parseTx({ ...raw, hash: raw.hash ?? txHash })
  } catch (error) {
    if (error instanceof Error && /txnNotFound/i.test(error.message)) return undefined
    throw error
  }
}

/** Recent inbound payments to the merchant address, newest first. Drives the watcher. */
export async function getIncomingPayments(
  address: string,
  limit = 25,
): Promise<XrplPaymentTransaction[]> {
  const result = await xrplRpc<{ transactions: Array<{ tx?: RawTx; tx_json?: RawTx; meta?: RawTx["meta"]; hash?: string; validated?: boolean; ledger_index?: number }> }>(
    "account_tx",
    { account: address, limit, ledger_index_min: -1, ledger_index_max: -1, binary: false },
  )

  return (result.transactions ?? [])
    .map((entry) => {
      const tx = entry.tx ?? entry.tx_json
      if (!tx || tx.TransactionType !== "Payment") return undefined
      return parseTx({
        ...tx,
        hash: tx.hash ?? entry.hash,
        meta: entry.meta ?? tx.meta,
        validated: entry.validated ?? tx.validated,
        ledger_index: entry.ledger_index ?? tx.ledger_index,
      })
    })
    .filter((tx): tx is XrplPaymentTransaction => Boolean(tx) && tx!.destination === address)
}

/** XRPL classic address: base58 with the ambiguous characters (0, O, I, l) removed. */
export const XRPL_ADDRESS_PATTERN = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/

export interface XrplAccountCheck {
  exists: boolean
  /** Reserve-satisfying balance in drops, when the account exists. */
  balanceDrops?: bigint
  detail?: string
}

/**
 * Confirms an address is actually usable as a destination.
 *
 * An unfunded XRPL address does not exist on ledger and cannot receive a payment. Checking at
 * configuration time turns a silent "payments never arrive" into an error the merchant sees
 * while they are still looking at the form.
 */
export async function checkAccountExists(address: string): Promise<XrplAccountCheck> {
  try {
    const result = await xrplRpc<{ account_data?: { Balance?: string } }>("account_info", {
      account: address,
      ledger_index: "validated",
    })
    return {
      exists: true,
      balanceDrops: result.account_data?.Balance ? BigInt(result.account_data.Balance) : undefined,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/actNotFound/i.test(message)) {
      return {
        exists: false,
        detail: "This address does not exist on XRPL Testnet yet — fund it to activate it.",
      }
    }
    // A network problem is not proof the address is bad; say so rather than rejecting it.
    return { exists: true, detail: `Could not verify the address: ${message}` }
  }
}

export function explorerTxUrl(hash: string): string {
  return NETWORKS.xrpl.txUrl(hash)
}

export const XRPL_SOURCE_ID_HEX = hexlify(zeroPadBytes(toUtf8Bytes(XRPL_SOURCE_ID), 32))
