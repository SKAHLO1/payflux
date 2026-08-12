import type { PaymentAsset } from "../domain/types.js"

/**
 * The asset registry.
 *
 * `supportsPayment` / `supportsSettlement` describe what PayFlux has actually implemented
 * end-to-end. An asset is never listed as supported on the strength of a plan (master prompt §9).
 * Whether a supported asset is *usable right now* is a separate, runtime question answered by
 * the router.
 */

export const CHAINS = {
  XRPL_TESTNET: "xrpl-testnet",
  COSTON2: "coston2",
} as const

const ASSETS: PaymentAsset[] = [
  {
    id: "XRP",
    symbol: "XRP",
    name: "XRP (Testnet)",
    chain: CHAINS.XRPL_TESTNET,
    type: "native",
    decimals: 6, // drops
    enabled: true,
    supportsPayment: true,
    // XRP cannot be a settlement asset on Flare — settling into the Flare ecosystem means FXRP.
    supportsSettlement: false,
    note: "Paid on XRPL Testnet, verified on Flare via an FDC Payment attestation.",
  },
  {
    id: "FXRP",
    symbol: "FXRP",
    name: "FXRP (FAssets, Coston2)",
    chain: CHAINS.COSTON2,
    type: "fasset",
    decimals: 6,
    enabled: true,
    supportsPayment: true,
    supportsSettlement: true,
    note: "FAssets representation of XRP on Coston2. Settlement availability depends on live AssetManager capacity.",
  },
  {
    id: "C2FLR",
    symbol: "C2FLR",
    name: "Coston2 Flare",
    chain: CHAINS.COSTON2,
    type: "native",
    decimals: 18,
    enabled: true,
    supportsPayment: true,
    supportsSettlement: true,
    note: "Native Coston2 payment. Final on arrival, so no external attestation is required.",
  },
  // Declared but disabled: the adapter interfaces exist, the payment flow does not.
  // Listing them as unsupported is the honest position (master prompt §68).
  {
    id: "BTC",
    symbol: "BTC",
    name: "Bitcoin (Testnet)",
    chain: "bitcoin-testnet",
    type: "native",
    decimals: 8,
    enabled: false,
    supportsPayment: false,
    supportsSettlement: false,
    note: "FDC supports testBTC Payment attestations, but PayFlux has no BTC watcher or settlement path yet.",
  },
  {
    id: "DOGE",
    symbol: "DOGE",
    name: "Dogecoin (Testnet)",
    chain: "dogecoin-testnet",
    type: "native",
    decimals: 8,
    enabled: false,
    supportsPayment: false,
    supportsSettlement: false,
    note: "FDC supports testDOGE Payment attestations, but PayFlux has no DOGE watcher or settlement path yet.",
  },
]

const BY_ID = new Map(ASSETS.map((a) => [a.id.toUpperCase(), a]))

export function listAssets(): PaymentAsset[] {
  return ASSETS.map((a) => ({ ...a }))
}

export function listEnabledAssets(): PaymentAsset[] {
  return ASSETS.filter((a) => a.enabled).map((a) => ({ ...a }))
}

export function getAsset(id: string): PaymentAsset | undefined {
  const asset = BY_ID.get(id.toUpperCase())
  return asset ? { ...asset } : undefined
}

export class UnsupportedAssetError extends Error {
  readonly code = "ASSET_UNSUPPORTED"
  constructor(readonly assetId: string) {
    super(`Asset "${assetId}" is not supported for payment by PayFlux.`)
    this.name = "UnsupportedAssetError"
  }
}

/** Validates an `acceptedAssets` list at payment-creation time, before any chain work happens. */
export function validatePaymentAssets(ids: string[]): PaymentAsset[] {
  const resolved = ids.map((id) => {
    const asset = getAsset(id)
    if (!asset || !asset.enabled || !asset.supportsPayment) throw new UnsupportedAssetError(id)
    return asset
  })
  if (resolved.length === 0) throw new UnsupportedAssetError("(none)")
  return resolved
}

export function validateSettlementAsset(id: string): PaymentAsset {
  const asset = getAsset(id)
  if (!asset || !asset.enabled || !asset.supportsSettlement) {
    throw new UnsupportedAssetError(id)
  }
  return asset
}

/** Smallest-unit conversion helpers. All internal amounts are integers in smallest units. */
export function toSmallestUnit(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.split(".")
  const padded = frac.padEnd(decimals, "0").slice(0, decimals)
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0")
}

export function fromSmallestUnit(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const whole = amount / base
  const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "")
  return `${whole}${frac ? `.${frac}` : ""}`
}
