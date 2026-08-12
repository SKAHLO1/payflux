/**
 * The PayFlux domain model.
 *
 * This is the abstraction the whole product rests on: a merchant expresses intent in fiat and a
 * set of acceptable assets, and PayFlux resolves that into concrete chains, verification methods
 * and settlement paths. The types below stay constant even as adapters are added underneath.
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

/** Machine-readable failure reasons (master prompt §44). Never collapsed into success. */
export type PaymentFailureCode =
  | "FDC_REQUEST_PENDING"
  | "FDC_REQUEST_FAILED"
  | "FDC_PROOF_INVALID"
  | "TRANSACTION_NOT_FOUND"
  | "WRONG_DESTINATION"
  | "WRONG_AMOUNT"
  | "PAYMENT_EXPIRED"
  | "DUPLICATE_PAYMENT"
  | "SETTLEMENT_FAILED"
  | "INSUFFICIENT_LIQUIDITY"
  | "ASSET_UNSUPPORTED"
  | "ROUTE_UNAVAILABLE"

export type AssetType = "native" | "fasset" | "erc20"

export interface PaymentAsset {
  id: string
  symbol: string
  name: string
  chain: string
  type: AssetType
  decimals: number
  enabled: boolean
  supportsPayment: boolean
  supportsSettlement: boolean
  /** Human explanation shown in the UI when the asset is present but not fully usable. */
  note?: string
}

export type RouteStatus = "available" | "unavailable" | "degraded"

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
  /** Router score, 0-100. Only meaningful for `available` routes. */
  score?: number
  /** Why the router ranked (or rejected) this route — surfaced verbatim in the checkout UI. */
  reasons: string[]
  /**
   * `supported` means PayFlux implements the path. `status` means it is executable right now.
   * The two are deliberately separate (master prompt §54).
   */
  supported: boolean
  unavailableReason?: string
  /** Where the customer sends funds for this route. */
  paymentInstructions?: PaymentInstructions
}

export interface PaymentInstructions {
  chain: string
  asset: string
  destinationAddress: string
  /** XRPL: the memo/destination-tag payload that binds the transfer to this intent. */
  reference?: string
  referenceEncoding?: "xrpl-memo-hex" | "evm-calldata" | "none"
  destinationTag?: number
  amount: string
  amountUnit: string
}

export interface RouteRequest {
  paymentId: string
  fiatAmount: string
  fiatCurrency: string
  acceptedAssets: string[]
  preferredSettlementAsset?: string
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
  /** Provenance of `rate`. Never "made up" — see pricing/quote.service.ts. */
  rateSource: "ftso-v2" | "unavailable"
  rateSourceDetail?: string
}

export interface PaymentVerification {
  method: "fdc-payment" | "flare-native"
  attestationType?: string
  sourceChain: string
  sourceTransactionId?: string
  fdcRequestId?: string
  /** Kept so a restarted process can still retrieve the proof for an in-flight round. */
  abiEncodedRequest?: string
  votingRound?: number
  proofRetrievedAt?: string
  coston2TransactionHash?: string
  registryAddress?: string
  verifiedAt?: string
  /** Amount the attestation actually reported, in the asset's smallest unit. */
  attestedAmount?: string
  status: "pending" | "requested" | "finalized" | "verified" | "failed"
  failureCode?: PaymentFailureCode
  failureDetail?: string
}

export type SettlementStatus = "quoted" | "pending" | "processing" | "completed" | "failed"

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
  status: SettlementStatus
  transactionHash?: string
  createdAt: string
  completedAt?: string
  failureCode?: PaymentFailureCode
  failureDetail?: string
  /** Which SettlementProvider executed this. */
  provider?: string
}

export interface SettlementRequest {
  paymentId: string
  sourceAsset: string
  destinationAsset: string
  amount: string
  merchantAddress: string
}

export interface SettlementQuote {
  id: string
  request: SettlementRequest
  inputAmount: string
  outputAmount: string
  fee: string
  estimatedTimeSeconds: number
  expiresAt: string
  executable: boolean
  /** Populated when `executable` is false — e.g. "amount below FAssets lot size". */
  blockers: string[]
  provider: string
}

export interface SettlementResult {
  settlement: Settlement
}

export interface PaymentIntent {
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
  metadata?: Record<string, string>
  failureCode?: PaymentFailureCode
  failureDetail?: string
  /** Amount reconciliation, populated once a payment is observed. */
  reconciliation?: PaymentReconciliation
  /** Set once the intent commitment is written to PaymentRegistry on Coston2. */
  onChainIntentTransactionHash?: string
  /** Present when the XRP route reserved FAssets collateral so the payment can mint FXRP. */
  fassetsReservation?: FAssetsReservation
  /** Held while a worker is finalizing this payment. Internal — never serialized to the API. */
  processingClaim?: PaymentClaim
}

/**
 * An exclusive lease over the irreversible half of verification.
 *
 * Finalization writes to PaymentRegistry and mints FXRP. Neither can be undone and both cost
 * gas, so exactly one worker may run it. The claim is what stops the finalization sweeper and a
 * merchant calling `POST /v1/payments/:id/verify` from doing it at the same time — a race that
 * exists within a single process, not just across replicas.
 *
 * It is a lease rather than a payment status on purpose: the public lifecycle, its webhooks and
 * the state machine are all unchanged, and merchants never see it.
 *
 * `expiresAt` carries as much weight as the claim itself. A worker that dies mid-finalization
 * must not strand the payment in `verifying` forever, so the claim lapses and the next sweep
 * picks it up. The chain is the backstop if that retry duplicates work: PaymentRegistry rejects
 * a second registration outright.
 */
export interface PaymentClaim {
  /** Identifies the holder for diagnosis. Never used for authorization. */
  owner: string
  claimedAt: string
  expiresAt: string
}

/**
 * An FAssets collateral reservation, made *before* the customer pays.
 *
 * This is what makes real FXRP settlement possible. FAssets will only mint against a payment sent
 * to the agent's own underlying address carrying the agent's own reference — both of which only
 * exist once collateral is reserved. So the reservation has to happen when the customer picks the
 * XRP route, and the checkout then shows the agent's details rather than the merchant's.
 *
 * The consequence worth understanding: for this route the customer pays the *agent*, not the
 * merchant. The merchant is made whole in FXRP on Coston2, which is what they asked for.
 */
export interface FAssetsReservation {
  collateralReservationId: string
  agentVault: string
  /** The agent's XRPL address — where the customer must send XRP. */
  paymentAddress: string
  /** 32-byte reference dictated by the AssetManager. Must be the memo, verbatim. */
  paymentReference: string
  /** Underlying value that will be minted, in UBA (drops for XRP). */
  valueUBA: string
  /** The agent's minting fee, in UBA. The customer pays value + fee. */
  feeUBA: string
  totalUBA: string
  /** The reservation lapses after this — a payment arriving later cannot mint. */
  lastUnderlyingTimestamp: number
  /** C2FLR the merchant's PayFlux instance paid to hold the reservation. */
  reservationFeeWei: string
  transactionHash: string
  reservedAt: string
}

export interface PaymentReconciliation {
  expectedAmount: string
  receivedAmount: string
  differenceAmount: string
  asset: string
  outcome: "exact" | "underpaid" | "overpaid"
  toleranceApplied: string
}

export interface PaymentEvent {
  id: string
  paymentId: string
  type: string
  timestamp: string
  source: string
  metadata: Record<string, unknown>
}

/**
 * A developer account, provisioned on first Google sign-in.
 *
 * The account id is derived from the Firebase uid, and doubles as the `merchantId` that scopes
 * payments, settlements and webhooks — so a developer only ever sees their own data.
 */
export interface Account {
  id: string
  /** Firebase uid. The link between a human and their data. */
  uid: string
  email: string
  displayName?: string
  photoUrl?: string
  provider: "google"
  createdAt: string
  lastSeenAt: string
}

export type ApiKeyStatus = "active" | "rotating" | "revoked" | "expired"

/**
 * What a key is allowed to do.
 *
 * Split read from write so a reporting integration, a support tool or an analytics job can hold
 * a key that cannot move money. Management scopes are deliberately absent — no API key can mint,
 * rotate or revoke another key, whatever scopes it holds.
 */
export const API_SCOPES = [
  "payments:read",
  "payments:write",
  "settlements:read",
  "settlements:write",
  "webhooks:read",
  "webhooks:write",
] as const

export type ApiScope = (typeof API_SCOPES)[number]

/** What a key needs to accept a payment end to end, and nothing more. */
export const DEFAULT_SCOPES: ApiScope[] = ["payments:read", "payments:write"]

export const ALL_SCOPES: ApiScope[] = [...API_SCOPES]

export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "payments:read": "Read payment intents, routes and events",
  "payments:write": "Create payment intents and trigger verification",
  "settlements:read": "Read settlements and settlement quotes",
  "settlements:write": "Execute settlements into the merchant's asset",
  "webhooks:read": "Read webhook configuration and delivery history",
  "webhooks:write": "Send test webhook events",
}

/**
 * An API key as stored. The secret itself is never persisted — only its digest — so a database
 * dump cannot be used to call the API (master prompt §46).
 */
export interface ApiKeyRecord {
  /** Public lookup handle, safe to display and to log. */
  id: string
  accountId: string
  name: string
  /** First few characters of the full key, for recognising it in a list. */
  prefix: string
  hash: string
  status: ApiKeyStatus
  createdAt: string
  lastUsedAt?: string
  /** Set when rotated with a grace period: the key stops working at this instant. */
  expiresAt?: string
  revokedAt?: string
  /** The successor issued by a rotation, so the audit trail links the pair. */
  rotatedToId?: string
  /** The predecessor this key replaced. */
  rotatedFromId?: string
  environment: "testnet"
  /**
   * Absent on keys issued before scopes existed. Those are grandfathered as full access rather
   * than silently narrowed — quietly breaking a working integration is worse than the delay in
   * tightening it, and the dashboard flags them for rotation.
   */
  scopes?: ApiScope[]
}

/** What the API returns. Never includes `hash`, and includes `secret` exactly once. */
export interface ApiKeyView {
  id: string
  name: string
  prefix: string
  status: ApiKeyStatus
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string
  revokedAt?: string
  rotatedToId?: string
  rotatedFromId?: string
  environment: "testnet"
  scopes: ApiScope[]
  /** True when the key predates scopes and is running with implicit full access. */
  legacyFullAccess: boolean
  /** Present only in the response that created it. */
  secret?: string
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditEventType =
  | "account.created"
  | "account.signed_in"
  | "api_key.created"
  | "api_key.rotated"
  | "api_key.revoked"
  | "api_key.scope_denied"
  | "settings.updated"

export interface AuditActor {
  kind: "user" | "api_key" | "system"
  id: string
  email?: string
}

/**
 * An append-only record of who did what to an account.
 *
 * Separate from `paymentEvents`: that trail explains a payment, this one explains the account.
 * Both are immutable — nothing in the codebase updates or deletes an audit event.
 */
export interface AuditEvent {
  id: string
  accountId: string
  type: AuditEventType
  actor: AuditActor
  /** What was acted on, when it is not the account itself. */
  target?: { kind: "api_key" | "account" | "settings"; id: string }
  /** Never contains secrets — only field names, ids and non-sensitive values. */
  metadata: Record<string, unknown>
  requestId?: string
  ip?: string
  userAgent?: string
  createdAt: string
}

export interface Merchant {
  id: string
  name: string
  settlementPreference: {
    asset: string
    chain: string
  }
  /** Where the merchant receives XRPL payments. */
  xrplAddress?: string
  /** Where the merchant receives Flare-side value. */
  flareAddress?: string
  webhookUrl?: string
  webhookSecret?: string
}

export type WebhookEventType =
  | "payment.created"
  | "payment.detected"
  | "payment.verifying"
  | "payment.verified"
  | "payment.confirmed"
  | "payment.settling"
  | "payment.settled"
  | "payment.failed"
  | "payment.expired"
  | "payment.partially_paid"
  | "payment.overpaid"
  | "settlement.created"
  | "settlement.completed"
  | "settlement.failed"

export interface WebhookDelivery {
  id: string
  merchantId: string
  event: WebhookEventType
  paymentId: string
  url: string
  payload: Record<string, unknown>
  attempts: number
  lastAttemptAt?: string
  deliveredAt?: string
  lastError?: string
  status: "pending" | "delivered" | "failed"
  nextAttemptAt?: string
}
