import { randomUUID } from "node:crypto"
import { formatUnits, parseUnits } from "ethers"
import type { Settlement, SettlementQuote, SettlementRequest, SettlementResult, SettlementStatus } from "../domain/types.js"
import { SettlementUnavailableError, type SettlementContext, type SettlementProvider } from "./provider.js"
import { getProvider, tryGetSigner } from "../chain/provider.js"
import * as fassets from "../chain/fassets.js"
import { getStore } from "../store/index.js"
import { NETWORKS } from "../config/env.js"

/**
 * Settlement for payments that were already made on Coston2.
 *
 * When the customer pays FXRP or C2FLR directly to the merchant, the payment *is* the settlement
 * — there is nothing to convert. This provider's job is to confirm the merchant's balance really
 * changed and record the transaction, not to move anything.
 *
 * Reporting "settled" without that confirmation would be exactly the database-update-as-settlement
 * anti-pattern the architecture is designed to avoid.
 */
export class FlareNativeProvider implements SettlementProvider {
  readonly id = "flare-native"
  readonly name = "Coston2 native settlement"

  supports(sourceAsset: string, destinationAsset: string): boolean {
    const source = sourceAsset.toUpperCase()
    const destination = destinationAsset.toUpperCase()
    return source === destination && (source === "FXRP" || source === "C2FLR")
  }

  async quote(request: SettlementRequest): Promise<SettlementQuote> {
    const blockers: string[] = []
    if (!request.merchantAddress) blockers.push("The merchant has no Coston2 address configured.")

    if (request.destinationAsset.toUpperCase() === "FXRP") {
      try {
        await fassets.getFXRPAddress()
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : String(error))
      }
    }

    return {
      id: `sq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      request,
      inputAmount: request.amount,
      // Same asset, same chain: no conversion, so no spread.
      outputAmount: request.amount,
      fee: "0",
      estimatedTimeSeconds: 5,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      executable: blockers.length === 0,
      blockers,
      provider: this.id,
    }
  }

  async execute(request: SettlementRequest, context: SettlementContext): Promise<SettlementResult> {
    const store = await getStore()
    const asset = request.destinationAsset.toUpperCase()

    const settlement: Settlement = {
      id: `set_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      paymentId: request.paymentId,
      sourceAsset: asset,
      destinationAsset: asset,
      sourceChain: "coston2",
      destinationChain: "coston2",
      inputAmount: request.amount,
      outputAmount: request.amount,
      fee: "0",
      status: "processing",
      createdAt: new Date().toISOString(),
      provider: this.id,
    }
    await store.saveSettlement(settlement)

    // The funds are already with the merchant — confirm that against the chain.
    const confirmed = await this.confirmBalance(request, asset)
    if (!confirmed.ok) {
      const failed: Settlement = {
        ...settlement,
        status: "failed",
        failureCode: "SETTLEMENT_FAILED",
        failureDetail: confirmed.detail,
      }
      await store.saveSettlement(failed)
      throw new SettlementUnavailableError(this.id, confirmed.detail)
    }

    context.onProgress?.("native.confirmed", {
      balance: confirmed.balance,
      asset,
    })

    const completed: Settlement = {
      ...settlement,
      status: "completed",
      transactionHash: confirmed.transactionHash,
      completedAt: new Date().toISOString(),
    }
    await store.saveSettlement(completed)
    return { settlement: completed }
  }

  private async confirmBalance(
    request: SettlementRequest,
    asset: string,
  ): Promise<{ ok: true; balance: string; transactionHash?: string } | { ok: false; detail: string }> {
    try {
      if (asset === "C2FLR") {
        const balance = await getProvider().getBalance(request.merchantAddress)
        const required = parseUnits(request.amount, 18)
        if (balance < required) {
          return {
            ok: false,
            detail: `Merchant holds ${formatUnits(balance, 18)} C2FLR, expected at least ${request.amount}.`,
          }
        }
        return { ok: true, balance: formatUnits(balance, 18) }
      }

      const settings = await fassets.getFAssetSettings()
      const balance = await fassets.getFxrpBalance(request.merchantAddress)
      const required = parseUnits(request.amount, settings.assetMintingDecimals)
      if (balance.raw < required) {
        return {
          ok: false,
          detail: `Merchant holds ${balance.formatted} FXRP, expected at least ${request.amount}.`,
        }
      }
      return { ok: true, balance: balance.formatted }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async getStatus(settlementId: string): Promise<SettlementStatus> {
    const store = await getStore()
    const settlement = await store.getSettlement(settlementId)
    return settlement?.status ?? "failed"
  }
}

export const explorerFor = (hash: string) => NETWORKS.flare.txUrl(hash)
export const signerAvailable = () => Boolean(tryGetSigner())
