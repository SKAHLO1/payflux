import { Contract, hexlify, concat, toUtf8Bytes, zeroPadBytes } from "ethers"
import { getProvider } from "../chain/provider.js"
import { resolve, FLARE_CONTRACTS } from "../chain/contract-registry.js"

/**
 * Prices come from Flare's own FTSOv2 block-latency feeds, read on Coston2.
 *
 * This is the reason PayFlux can quote in USD without inventing a rate (master prompt §20, §56).
 * If a feed is unavailable the quote is refused — there is no fallback constant anywhere in this
 * file, deliberately.
 */

const FTSO_V2_ABI = [
  "function getFeedById(bytes21 _feedId) external payable returns (uint256 _value, int8 _decimals, uint64 _timestamp)",
]

/**
 * FTSOv2 feed IDs are 21 bytes: a 1-byte category (0x01 = crypto) followed by the UTF-8 feed
 * name, right-padded with zeros.
 */
export function encodeFeedId(name: string, category = 0x01): string {
  const body = zeroPadBytes(toUtf8Bytes(name), 20)
  return hexlify(concat([new Uint8Array([category]), body]))
}

export const FEEDS = {
  "FLR/USD": encodeFeedId("FLR/USD"),
  "XRP/USD": encodeFeedId("XRP/USD"),
} as const

export type FeedName = keyof typeof FEEDS

export interface FeedPrice {
  feed: FeedName
  /** Decimal string, e.g. "0.6832". */
  price: string
  decimals: number
  /** Feed publication time, from the chain — not the server clock. */
  timestamp: number
  raw: string
  source: "ftso-v2"
}

export class FeedUnavailableError extends Error {
  readonly code = "PRICE_FEED_UNAVAILABLE"
  constructor(
    readonly feed: string,
    readonly detail: string,
  ) {
    super(`FTSOv2 feed ${feed} is UNAVAILABLE: ${detail}`)
    this.name = "FeedUnavailableError"
  }
}

// Feeds update every ~1.8s on-chain; a short cache keeps quoting cheap without going stale.
const CACHE_TTL_MS = 5_000
const cache = new Map<string, { value: FeedPrice; fetchedAt: number }>()

async function ftsoV2(): Promise<Contract> {
  const address = await resolve(FLARE_CONTRACTS.ftsoV2)
  return new Contract(address, FTSO_V2_ABI, getProvider())
}

function formatFixed(value: bigint, decimals: number): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`
}

export async function getFeedPrice(feed: FeedName): Promise<FeedPrice> {
  const cached = cache.get(feed)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value

  let result: [bigint, bigint, bigint]
  try {
    const contract = await ftsoV2()
    // staticCall: the getter is payable but reads are free, and we never want to send value here.
    result = await contract.getFeedById.staticCall(FEEDS[feed])
  } catch (error) {
    throw new FeedUnavailableError(feed, error instanceof Error ? error.message : String(error))
  }

  const [rawValue, rawDecimals, rawTimestamp] = result
  const decimals = Number(rawDecimals)
  if (rawValue === 0n) {
    throw new FeedUnavailableError(feed, "feed returned a zero value")
  }

  const value: FeedPrice = {
    feed,
    price: formatFixed(rawValue, decimals),
    decimals,
    timestamp: Number(rawTimestamp),
    raw: rawValue.toString(),
    source: "ftso-v2",
  }

  cache.set(feed, { value, fetchedAt: Date.now() })
  return value
}

/** Which feeds are actually readable right now — surfaced on the dashboard diagnostics page. */
export async function feedHealth(): Promise<Array<{ feed: FeedName; ok: boolean; detail?: string }>> {
  return Promise.all(
    (Object.keys(FEEDS) as FeedName[]).map(async (feed) => {
      try {
        await getFeedPrice(feed)
        return { feed, ok: true }
      } catch (error) {
        return { feed, ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
}
