import type {
  SettlementQuote,
  SettlementRequest,
  SettlementResult,
  SettlementStatus,
} from "../domain/types.js"

/**
 * The settlement abstraction (master prompt §13).
 *
 * Adding a new settlement mechanism means adding a provider, not changing the payment engine.
 * The contract every provider must honour:
 *
 *   - `quote()` may only return `executable: true` if the provider has *checked* that it can
 *     execute right now. Optimism here becomes a broken promise to a merchant.
 *   - `execute()` may only return a completed settlement backed by a confirmed transaction hash.
 *     A database write is not a settlement (master prompt §14, §58).
 */
export interface SettlementProvider {
  readonly id: string
  readonly name: string
  /** Which (sourceAsset, destinationAsset) pairs this provider claims. */
  supports(sourceAsset: string, destinationAsset: string): boolean
  quote(request: SettlementRequest): Promise<SettlementQuote>
  execute(request: SettlementRequest, context: SettlementContext): Promise<SettlementResult>
  getStatus(settlementId: string): Promise<SettlementStatus>
}

/** Everything a provider may need from the verified payment, passed explicitly. */
export interface SettlementContext {
  paymentId: string
  /** The FDC proof of the customer's payment, when the source chain is external. */
  proof?: unknown
  /** FAssets collateral reservation id, when the payment was routed through a mint. */
  collateralReservationId?: string
  onProgress?: (stage: string, metadata: Record<string, unknown>) => void
}

export class SettlementUnavailableError extends Error {
  readonly code = "SETTLEMENT_FAILED"
  constructor(
    readonly provider: string,
    detail: string,
  ) {
    super(`${provider}: ${detail}`)
    this.name = "SettlementUnavailableError"
  }
}
