/**
 * Frontend mirror of the API's domain types.
 *
 * Kept structural rather than imported from the server package so the Next app can be deployed
 * independently of the API. The server is the source of truth; these are read-only views.
 */

export type PaymentStatus =
  | "created"
  | "awaiting_payment"
  | "payment_detected"
  | "verifying"
  | "verified"
  | "settling"
  | "settled"
  | "failed"
  | "expired"
  | "partially_paid"
  | "overpaid"
  | "refunded"

export type RouteStatus = "available" | "unavailable" | "degraded"

export interface PaymentAsset {
  id: string
  symbol: string
  name: string
  chain: string
  type: "native" | "fasset" | "erc20"
  decimals: number
  enabled: boolean
  supportsPayment: boolean
  supportsSettlement: boolean
  note?: string
}

export interface PaymentInstructions {
  chain: string
  asset: string
  destinationAddress: string
  reference?: string
  referenceEncoding?: string
  destinationTag?: number
  amount: string
  amountUnit: string
  memoDataHex?: string
}

export interface PaymentRoute {
  id: string
  sourceAsset: string
  sourceChain: string
  destinationAsset?: string
  destinationChain: string
  estimatedInputAmount: string
  estimatedOutputAmount: string
  estimatedFee: string
  estimatedTimeSeconds: number
  priceImpact?: string
  verificationMethod: string
  settlementMethod?: string
  status: RouteStatus
  score?: number
  reasons: string[]
  supported: boolean
  unavailableReason?: string
  paymentInstructions?: PaymentInstructions
}

export interface PaymentQuote {
  id: string
  fiatAmount: string
  fiatCurrency: string
  asset: string
  assetAmount: string
  rate: string
  fee: string
  expiresAt: string
  rateSource: "ftso-v2" | "unavailable"
  rateSourceDetail?: string
}

export interface PaymentVerification {
  method: "fdc-payment" | "flare-native"
  attestationType?: string
  sourceChain: string
  sourceTransactionId?: string
  fdcRequestId?: string
  votingRound?: number
  proofRetrievedAt?: string
  coston2TransactionHash?: string
  registryAddress?: string
  verifiedAt?: string
  attestedAmount?: string
  status: "pending" | "requested" | "finalized" | "verified" | "failed"
  failureCode?: string
  failureDetail?: string
}

export interface Settlement {
  id: string
  paymentId: string
  sourceAsset: string
  destinationAsset: string
  sourceChain: string
  destinationChain: string
  inputAmount: string
  outputAmount: string
  fee: string
  status: "quoted" | "pending" | "processing" | "completed" | "failed"
  transactionHash?: string
  createdAt: string
  completedAt?: string
  failureCode?: string
  failureDetail?: string
  provider?: string
}

export interface PaymentReconciliation {
  expectedAmount: string
  receivedAmount: string
  differenceAmount: string
  asset: string
  outcome: "exact" | "underpaid" | "overpaid"
  toleranceApplied: string
}

export interface Payment {
  id: string
  merchantId: string
  amount: string
  currency: string
  acceptedAssets: string[]
  preferredSettlementAsset?: string
  selectedAsset?: string
  selectedRoute?: PaymentRoute
  status: PaymentStatus
  orderId?: string
  paymentReference: string
  expiresAt: string
  createdAt: string
  updatedAt: string
  quote?: PaymentQuote
  verification?: PaymentVerification
  settlement?: Settlement
  reconciliation?: PaymentReconciliation
  metadata?: Record<string, string>
  failureCode?: string
  failureDetail?: string
  onChainIntentTransactionHash?: string
  paymentInstructions?: PaymentInstructions
  links: {
    status: string
    sourceTransaction?: string
    verificationTransaction?: string
    settlementTransaction?: string
    registry?: string
    intentTransaction?: string
  }
}

export interface PaymentEvent {
  id: string
  paymentId: string
  type: string
  timestamp: string
  source: string
  metadata: Record<string, unknown>
}

export interface HealthReport {
  status: string
  mode: "LIVE" | "DEMO"
  networks: {
    flare: { name: string; chainId: number; explorer: string }
    xrpl: { name: string; explorer: string }
  }
  capabilities: Record<string, boolean>
  fdc: {
    verifierConfigured?: boolean
    hubAddress?: string
    verificationAddress?: string
    relayAddress?: string
    dataAvailabilityUrl?: string
    reachable: boolean
    detail?: string
  }
  fassets: {
    available: boolean
    assetManager?: string
    fxrp?: string
    lotSizeXrp?: string
    totalFreeLots?: number
    agentCount?: number
    maxMintableXrp?: string
    detail?: string
    limits?: { lotSizeXrp: string; totalFreeLots: number; maxMintableXrp: string }
  }
  paymentRegistry: {
    available: boolean
    address?: string
    fdcVerification?: string
    canWrite?: boolean
    explorer?: string
    detail?: string
  }
  priceFeeds: Array<{ feed: string; ok: boolean; detail?: string }>
  settlementProviders: Array<{ id: string; name: string }>
}
