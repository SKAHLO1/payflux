import { randomUUID } from "node:crypto"
import { parseUnits, formatUnits } from "ethers"
import type { Settlement, SettlementQuote, SettlementRequest, SettlementResult, SettlementStatus } from "../domain/types.js"
import { SettlementUnavailableError, type SettlementContext, type SettlementProvider } from "./provider.js"
import * as fassets from "../chain/fassets.js"
import { getStore } from "../store/index.js"
import { env, NETWORKS } from "../config/env.js"
import { xrpToDrops, dropsToXrp } from "../verification/xrpl.payment.js"

/**
 * XRP -> FXRP settlement via the FAssets system.
 *
 * This provider does not convert anything itself. It drives the real FAssets minting protocol:
 * the customer's attested XRP payment is presented to `executeMinting`, the AssetManager mints
 * FXRP to PayFlux's minter account, and the FXRP is forwarded to the merchant.
 *
 * Both steps are on-chain transactions with real hashes and real balance changes. If either is
 * impossible right now, the settlement fails loudly with the reason — it is never marked
 * complete on the strength of the payment alone.
 */
export class FAssetsMintProvider implements SettlementProvider {
  readonly id = "fassets-mint"
  readonly name = "FAssets FXRP minting (Coston2)"

  supports(sourceAsset: string, destinationAsset: string): boolean {
    return sourceAsset.toUpperCase() === "XRP" && destinationAsset.toUpperCase() === "FXRP"
  }

  async quote(request: SettlementRequest): Promise<SettlementQuote> {
    const desiredDrops = xrpToDrops(request.amount)
    const check = await fassets.preflight(desiredDrops)

    const outputXrp = check.lots > 0 && check.settings
      ? formatUnits(BigInt(check.lots) * check.settings.lotSizeUBA, check.settings.assetMintingDecimals)
      : "0"

    const feeDrops = check.requiredDrops > 0n ? check.requiredDrops - xrpToDrops(outputXrp) : 0n

    return {
      id: `sq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      request,
      inputAmount: check.requiredXrp,
      outputAmount: outputXrp,
      fee: dropsToXrp(feeDrops > 0n ? feeDrops : 0n),
      // Dominated by the FDC round, which has already elapsed by the time we execute.
      estimatedTimeSeconds: 60,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      executable: check.ok,
      blockers: check.blockers,
      provider: this.id,
    }
  }

  async execute(request: SettlementRequest, context: SettlementContext): Promise<SettlementResult> {
    const store = await getStore()
    const now = new Date().toISOString()

    if (!context.collateralReservationId) {
      throw new SettlementUnavailableError(
        this.id,
        "no FAssets collateral reservation is associated with this payment, so there is nothing to mint against",
      )
    }
    if (!context.proof) {
      throw new SettlementUnavailableError(
        this.id,
        "executeMinting requires the FDC payment proof, which has not been retrieved",
      )
    }

    let settlement: Settlement = {
      id: `set_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      paymentId: request.paymentId,
      sourceAsset: "XRP",
      destinationAsset: "FXRP",
      sourceChain: "xrpl-testnet",
      destinationChain: "coston2",
      inputAmount: request.amount,
      outputAmount: "0",
      fee: "0",
      status: "processing",
      createdAt: now,
      provider: this.id,
    }
    await store.saveSettlement(settlement)

    // Snapshot before minting. Taking it afterwards measures only the forwarding transfer and
    // would report a zero delta whenever the mint already credited the merchant directly.
    const settings = await fassets.getFAssetSettings()
    const before = await fassets.getFxrpBalance(request.merchantAddress)

    // --- Mint -------------------------------------------------------
    context.onProgress?.("fassets.minting", {
      collateralReservationId: context.collateralReservationId,
      merchantBalanceBefore: before.formatted,
    })

    let mint: { transactionHash: string; blockNumber: number }
    try {
      mint = await fassets.executeMinting(context.proof, context.collateralReservationId)
    } catch (error) {
      settlement = {
        ...settlement,
        status: "failed",
        failureCode: "SETTLEMENT_FAILED",
        failureDetail: error instanceof Error ? error.message : String(error),
      }
      await store.saveSettlement(settlement)
      throw new SettlementUnavailableError(this.id, settlement.failureDetail!)
    }

    context.onProgress?.("fassets.minted", {
      transactionHash: mint.transactionHash,
      explorerUrl: NETWORKS.flare.txUrl(mint.transactionHash),
    })

    /*
     * Forward to the merchant — unless they are already the minter.
     *
     * FAssets mints to whoever reserved the collateral. When PayFlux is operated by the merchant
     * themselves, that is the same account, the FXRP has already arrived, and attempting a
     * transfer reverts with CannotTransferToSelf. Treating that as a settlement failure would
     * report a payment as failed when the merchant has actually been paid.
     */
    const minter = await fassets.minterAddress()
    const merchantIsMinter =
      minter.toLowerCase() === request.merchantAddress.toLowerCase()

    const amountUBA = parseUnits(request.amount, settings.assetMintingDecimals)
    let settlementTxHash = mint.transactionHash

    if (!merchantIsMinter) {
      try {
        const transfer = await fassets.transferFxrp(request.merchantAddress, amountUBA)
        settlementTxHash = transfer.transactionHash
      } catch (error) {
        settlement = {
          ...settlement,
          status: "failed",
          transactionHash: mint.transactionHash,
          failureCode: "SETTLEMENT_FAILED",
          failureDetail:
            `FXRP was minted (${mint.transactionHash}) but the transfer to the merchant failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        }
        await store.saveSettlement(settlement)
        throw new SettlementUnavailableError(this.id, settlement.failureDetail!)
      }
    } else {
      context.onProgress?.("fassets.minted_to_merchant", {
        detail: "The merchant is the minting account, so the FXRP needed no forwarding transfer.",
      })
    }

    // Either way, settlement is only complete if the merchant's balance actually rose.
    const after = await fassets.getFxrpBalance(request.merchantAddress)
    const delta = after.raw - before.raw
    if (delta <= 0n) {
      settlement = {
        ...settlement,
        status: "failed",
        transactionHash: settlementTxHash,
        failureCode: "SETTLEMENT_FAILED",
        failureDetail:
          "The merchant's FXRP balance did not increase — refusing to report this settlement " +
          "as complete.",
      }
      await store.saveSettlement(settlement)
      throw new SettlementUnavailableError(this.id, settlement.failureDetail!)
    }

    settlement = {
      ...settlement,
      status: "completed",
      outputAmount: formatUnits(delta, settings.assetMintingDecimals),
      fee: "0",
      transactionHash: settlementTxHash,
      completedAt: new Date().toISOString(),
    }
    await store.saveSettlement(settlement)

    context.onProgress?.("fassets.settled", {
      transactionHash: settlementTxHash,
      merchantBalanceDelta: settlement.outputAmount,
      explorerUrl: NETWORKS.flare.txUrl(settlementTxHash),
      forwarded: !merchantIsMinter,
    })

    return { settlement }
  }

  async getStatus(settlementId: string): Promise<SettlementStatus> {
    const store = await getStore()
    const settlement = await store.getSettlement(settlementId)
    return settlement?.status ?? "failed"
  }
}
