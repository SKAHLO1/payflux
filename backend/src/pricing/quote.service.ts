import { randomUUID } from "node:crypto"
import { env } from "../config/env.js"
import type { PaymentQuote } from "../domain/types.js"
import { getFeedPrice, FeedUnavailableError, type FeedName } from "./ftso.service.js"

/**
 * Fiat -> asset quoting.
 *
 * The rate always comes from an FTSOv2 feed read on Coston2. There is no hardcoded fallback: if
 * the feed cannot be read, quoting fails and the route is reported unavailable. A wrong price is
 * worse than no price when someone is about to send real value (master prompt §20, §56).
 */

const FEED_FOR_ASSET: Record<string, FeedName> = {
  XRP: "XRP/USD",
  FXRP: "XRP/USD", // FXRP is 1:1 with XRP by construction of the FAssets system.
  C2FLR: "FLR/USD",
}

export class QuoteUnavailableError extends Error {
  readonly code = "QUOTE_UNAVAILABLE"
  constructor(
    readonly asset: string,
    readonly detail: string,
  ) {
    super(`Cannot quote ${asset}: ${detail}`)
    this.name = "QuoteUnavailableError"
  }
}

/** Basis-point spread PayFlux applies. Explicit, disclosed, and part of the quote. */
const SPREAD_BPS = 30n

export async function createQuote(
  fiatAmount: string,
  fiatCurrency: string,
  asset: string,
): Promise<PaymentQuote> {
  if (fiatCurrency.toUpperCase() !== "USD") {
    throw new QuoteUnavailableError(
      asset,
      `only USD is quotable — the FTSOv2 feeds PayFlux reads are USD-denominated.`,
    )
  }

  const feed = FEED_FOR_ASSET[asset.toUpperCase()]
  if (!feed) {
    throw new QuoteUnavailableError(asset, "no FTSOv2 price feed is mapped for this asset")
  }

  let price: Awaited<ReturnType<typeof getFeedPrice>>
  try {
    price = await getFeedPrice(feed)
  } catch (error) {
    if (error instanceof FeedUnavailableError) {
      throw new QuoteUnavailableError(asset, error.message)
    }
    throw error
  }

  // Work in integers at feed precision to avoid float drift on money.
  const scale = 10n ** BigInt(price.decimals)
  const fiatScaled = parseDecimal(fiatAmount, price.decimals)
  const rateRaw = BigInt(price.raw)

  const assetScaled = (fiatScaled * scale) / rateRaw
  const fee = (assetScaled * SPREAD_BPS) / 10_000n
  const total = assetScaled + fee

  return {
    id: `qt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    fiatAmount,
    fiatCurrency: fiatCurrency.toUpperCase(),
    asset: asset.toUpperCase(),
    assetAmount: formatDecimal(total, price.decimals, 6),
    rate: price.price,
    fee: formatDecimal(fee, price.decimals, 6),
    expiresAt: new Date(Date.now() + env.QUOTE_TTL_SECONDS * 1000).toISOString(),
    rateSource: "ftso-v2",
    rateSourceDetail: `FTSOv2 ${feed} on Coston2, published ${new Date(
      price.timestamp * 1000,
    ).toISOString()}`,
  }
}

export function isQuoteExpired(quote: PaymentQuote, now = new Date()): boolean {
  return new Date(quote.expiresAt).getTime() <= now.getTime()
}

export function assertQuoteFresh(quote: PaymentQuote): void {
  if (isQuoteExpired(quote)) {
    throw new QuoteUnavailableError(quote.asset, `quote ${quote.id} expired at ${quote.expiresAt}`)
  }
}

function parseDecimal(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.split(".")
  const padded = frac.padEnd(decimals, "0").slice(0, decimals)
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0")
}

function formatDecimal(value: bigint, decimals: number, maxFractionDigits: number): string {
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const frac = (value % base).toString().padStart(decimals, "0").slice(0, maxFractionDigits)
  const trimmed = frac.replace(/0+$/, "")
  return `${whole}${trimmed ? `.${trimmed}` : ""}`
}
