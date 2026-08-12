import { Contract, formatUnits, parseUnits } from "ethers"
import { getProvider, tryGetSigner, withSigner } from "./provider.js"
import { tryResolve, FLARE_CONTRACTS } from "./contract-registry.js"
import { dropsToXrp } from "../verification/xrpl.payment.js"
import { env } from "../config/env.js"

/**
 * FAssets / FXRP on Coston2.
 *
 * ---------------------------------------------------------------------------
 * The architectural point that shapes this whole file
 * ---------------------------------------------------------------------------
 *
 * FXRP is not a wrapper PayFlux can mint by fiat. FAssets minting is a three-party protocol:
 *
 *   1. A minter reserves collateral against an *agent*, paying a reservation fee in C2FLR.
 *      The AssetManager responds with the agent's XRPL address and a payment reference.
 *   2. The minter sends the underlying XRP to *that* address with *that* reference.
 *   3. Anyone submits an FDC Payment attestation of step 2 to `executeMinting`, and FXRP is
 *      minted to the minter.
 *
 * There is no "XRP in, FXRP out" endpoint to call, and inventing one would be fiction.
 *
 * So PayFlux does not bolt a conversion onto the side of the payment — it makes the customer's
 * payment *be* the FAssets minting payment. The collateral reservation happens when the customer
 * picks the XRP route, the destination and reference shown at checkout come from the
 * CollateralReserved event, and the single FDC attestation of that one transfer is used twice:
 * once to register the payment in PaymentRegistry, once to execute the mint. The FXRP is minted
 * directly to the merchant's Flare address.
 *
 * That is a real settlement, with a real on-chain balance change, and no invented liquidity.
 *
 * The constraint this buys us is lot quantisation: FAssets mints in whole lots, so the XRP amount
 * is rounded up to a lot boundary. `preflight()` reports that plainly rather than hiding it.
 */

/**
 * Signatures transcribed from `@flarenetwork/flare-periphery-contracts/coston2/IAssetManager.sol`
 * and its `data/` structs, which is the same package the contracts compile against.
 *
 * Note the dedicated getters — `lotSize()`, `assetMintingDecimals()`,
 * `assetMintingGranularityUBA()`. They are used in preference to `getSettings()`, whose return
 * type is a ~60-field struct: transcribing that by hand would silently misdecode on any upstream
 * reordering, and misreading a lot size is exactly the kind of error that quotes a customer the
 * wrong amount.
 */
const ASSET_MANAGER_ABI = [
  "function fAsset() external view returns (address)",
  "function lotSize() external view returns (uint256 _lotSizeUBA)",
  "function assetMintingDecimals() external view returns (uint256)",
  "function assetMintingGranularityUBA() external view returns (uint256)",
  "function assetManagerController() external view returns (address)",
  "function collateralReservationFee(uint256 _lots) external view returns (uint256)",
  // NOTE the trailing `uint8 status` (AgentInfo.Status). Omitting it does not fail loudly — it
  // silently shifts every element after the first, so `agentVault` reads as garbage and
  // reserveCollateral reverts with InvalidAgentVaultAddress. Struct arrays must be transcribed
  // in full.
  "function getAvailableAgentsDetailedList(uint256 _start, uint256 _end) external view returns (tuple(address agentVault, address ownerManagementAddress, uint256 feeBIPS, uint256 mintingVaultCollateralRatioBIPS, uint256 mintingPoolCollateralRatioBIPS, uint256 freeCollateralLots, uint8 status)[] _agents, uint256 _totalLength)",
  "function reserveCollateral(address _agentVault, uint256 _lots, uint256 _maxMintingFeeBIPS, address payable _executor) external payable returns (uint256)",
  "function executeMinting(tuple(bytes32[] merkleProof, tuple(bytes32 attestationType, bytes32 sourceId, uint64 votingRound, uint64 lowestUsedTimestamp, tuple(bytes32 transactionId, uint256 inUtxo, uint256 utxo) requestBody, tuple(uint64 blockNumber, uint64 blockTimestamp, bytes32 sourceAddressHash, bytes32 sourceAddressesRoot, bytes32 receivingAddressHash, bytes32 intendedReceivingAddressHash, int256 spentAmount, int256 intendedSpentAmount, int256 receivedAmount, int256 intendedReceivedAmount, bytes32 standardPaymentReference, bool oneToOne, uint8 status) responseBody) data) _payment, uint256 _collateralReservationId) external",
  "event CollateralReserved(address indexed agentVault, address indexed minter, uint256 indexed collateralReservationId, uint256 valueUBA, uint256 feeUBA, uint256 firstUnderlyingBlock, uint256 lastUnderlyingBlock, uint256 lastUnderlyingTimestamp, string paymentAddress, bytes32 paymentReference, address executor, uint256 executorFeeNatWei)",
]

const FASSET_ABI = [
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function totalSupply() external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
]

export class FAssetsUnavailableError extends Error {
  readonly code = "FASSETS_UNAVAILABLE"
  constructor(readonly detail: string) {
    super(`FAssets settlement is UNAVAILABLE: ${detail}`)
    this.name = "FAssetsUnavailableError"
  }
}

export async function getAssetManagerAddress(): Promise<string | undefined> {
  return tryResolve(FLARE_CONTRACTS.assetManagerFXRP)
}

async function assetManager(): Promise<Contract> {
  const address = await getAssetManagerAddress()
  if (!address) {
    throw new FAssetsUnavailableError(
      "AssetManagerFXRP is not registered in the Flare Contract Registry on this network.",
    )
  }
  return new Contract(address, ASSET_MANAGER_ABI, getProvider())
}

export interface FAssetSettings {
  assetManager: string
  fAsset: string
  /** Lot size already in underlying base units (UBA) — the getter returns UBA directly. */
  lotSizeUBA: bigint
  lotSizeXrp: string
  assetMintingDecimals: number
  assetMintingGranularityUBA: bigint
}

let settingsCache: { value: FAssetSettings; fetchedAt: number } | undefined
const SETTINGS_TTL_MS = 60_000

/** Reads FAssets operating parameters from the chain. Never hardcoded (master prompt §16). */
export async function getFAssetSettings(): Promise<FAssetSettings> {
  if (settingsCache && Date.now() - settingsCache.fetchedAt < SETTINGS_TTL_MS) {
    return settingsCache.value
  }

  const address = await getAssetManagerAddress()
  if (!address) {
    throw new FAssetsUnavailableError("AssetManagerFXRP is not registered on this network.")
  }

  const manager = new Contract(address, ASSET_MANAGER_ABI, getProvider())

  let fAsset: string
  let lotSizeUBA: bigint
  let mintingDecimals: bigint
  let granularity: bigint
  try {
    ;[fAsset, lotSizeUBA, mintingDecimals, granularity] = await Promise.all([
      manager.fAsset(),
      manager.lotSize(),
      manager.assetMintingDecimals(),
      manager.assetMintingGranularityUBA(),
    ])
  } catch (error) {
    throw new FAssetsUnavailableError(
      `could not read AssetManager parameters: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const assetMintingDecimals = Number(mintingDecimals)
  if (lotSizeUBA <= 0n) {
    throw new FAssetsUnavailableError("AssetManager reported a zero lot size")
  }

  const value: FAssetSettings = {
    assetManager: address,
    fAsset,
    lotSizeUBA,
    lotSizeXrp: formatUnits(lotSizeUBA, assetMintingDecimals),
    assetMintingDecimals,
    assetMintingGranularityUBA: granularity,
  }

  settingsCache = { value, fetchedAt: Date.now() }
  return value
}

export async function getFXRPAddress(): Promise<string> {
  return (await getFAssetSettings()).fAsset
}

export async function getLotSize(): Promise<{ lotSizeUBA: bigint; lotSizeXrp: string }> {
  const settings = await getFAssetSettings()
  return { lotSizeUBA: settings.lotSizeUBA, lotSizeXrp: settings.lotSizeXrp }
}

export interface AgentQuote {
  agentVault: string
  feeBIPS: number
  freeCollateralLots: number
  /** AgentInfo.Status — 0 is NORMAL. Anything else means liquidation or wind-down. */
  status: number
}

/** Only a NORMAL agent can mint. */
const AGENT_STATUS_NORMAL = 0

/** Available agents with spare minting capacity, cheapest fee first. */
export async function getAvailableAgents(limit = 20): Promise<AgentQuote[]> {
  const manager = await assetManager()
  try {
    const [agents]: [any[], bigint] = await manager.getAvailableAgentsDetailedList(0, limit)
    return agents
      .map((a) => ({
        agentVault: a.agentVault as string,
        feeBIPS: Number(a.feeBIPS),
        freeCollateralLots: Number(a.freeCollateralLots),
        status: Number(a.status),
      }))
      // An agent in liquidation is listed but cannot mint — reserving against one reverts.
      .filter((a) => a.freeCollateralLots > 0 && a.status === AGENT_STATUS_NORMAL)
      .sort((a, b) => a.feeBIPS - b.feeBIPS || b.freeCollateralLots - a.freeCollateralLots)
  } catch (error) {
    throw new FAssetsUnavailableError(
      `could not enumerate agents: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export interface MintingLimits {
  lotSizeUBA: bigint
  lotSizeXrp: string
  totalFreeLots: number
  maxMintableUBA: bigint
  maxMintableXrp: string
  agentCount: number
}

export async function getMintingLimits(): Promise<MintingLimits> {
  const [settings, agents] = await Promise.all([getFAssetSettings(), getAvailableAgents()])
  const totalFreeLots = agents.reduce((sum, a) => sum + a.freeCollateralLots, 0)
  const maxMintableUBA = BigInt(totalFreeLots) * settings.lotSizeUBA
  return {
    lotSizeUBA: settings.lotSizeUBA,
    lotSizeXrp: settings.lotSizeXrp,
    totalFreeLots,
    maxMintableUBA,
    maxMintableXrp: formatUnits(maxMintableUBA, settings.assetMintingDecimals),
    agentCount: agents.length,
  }
}

// ---------------------------------------------------------------------------
// Pre-flight (master prompt §16)
// ---------------------------------------------------------------------------

export interface PreflightResult {
  ok: boolean
  blockers: string[]
  /** Whole lots the payment rounds up to. */
  lots: number
  /** Exact XRP the customer must send, in drops — a lot boundary plus the agent's minting fee. */
  requiredDrops: bigint
  requiredXrp: string
  /** How much the lot rounding added on top of the fiat-derived amount. */
  roundingDrops: bigint
  lotSizeXrp: string
  agent?: AgentQuote
  agentFeeBIPS?: number
  /** Collateral reservation fee PayFlux pays in C2FLR (wei). Not charged to the customer. */
  collateralReservationFeeWei?: bigint
  settings?: FAssetSettings
}

/**
 * Checks everything that is knowable before spending gas, so we never submit a transaction that
 * is guaranteed to revert.
 */
export async function preflight(desiredDrops: bigint): Promise<PreflightResult> {
  const blockers: string[] = []

  let settings: FAssetSettings
  try {
    settings = await getFAssetSettings()
  } catch (error) {
    return {
      ok: false,
      blockers: [error instanceof Error ? error.message : String(error)],
      lots: 0,
      requiredDrops: 0n,
      requiredXrp: "0",
      roundingDrops: 0n,
      lotSizeXrp: "0",
    }
  }

  // XRPL drops and FAssets UBA are both 6dp for XRP, but do not assume it.
  const scale =
    settings.assetMintingDecimals >= 6
      ? 10n ** BigInt(settings.assetMintingDecimals - 6)
      : 1n
  const desiredUBA = desiredDrops * scale

  const lots = Number((desiredUBA + settings.lotSizeUBA - 1n) / settings.lotSizeUBA)
  if (lots < 1) {
    blockers.push(
      `Amount is below the FAssets minimum lot size of ${settings.lotSizeXrp} XRP.`,
    )
  }

  let agent: AgentQuote | undefined
  try {
    const agents = await getAvailableAgents()
    agent = agents.find((a) => a.freeCollateralLots >= lots)
    if (!agent) {
      blockers.push(
        agents.length === 0
          ? "No FAssets agents are currently available to mint FXRP on Coston2."
          : `No agent has ${lots} free lots (best available: ${Math.max(
              ...agents.map((a) => a.freeCollateralLots),
            )}).`,
      )
    }
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error))
  }

  const lotAlignedUBA = BigInt(lots) * settings.lotSizeUBA
  const mintingFeeUBA = agent ? (lotAlignedUBA * BigInt(agent.feeBIPS)) / 10_000n : 0n
  const totalUBA = lotAlignedUBA + mintingFeeUBA
  const requiredDrops = totalUBA / scale

  let collateralReservationFeeWei: bigint | undefined
  if (agent && lots > 0) {
    try {
      const manager = await assetManager()
      collateralReservationFeeWei = await manager.collateralReservationFee(lots)
    } catch (error) {
      blockers.push(
        `Could not read the collateral reservation fee: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  if (!tryGetSigner()) {
    blockers.push("No Coston2 signer configured, so collateral cannot be reserved.")
  } else if (collateralReservationFeeWei !== undefined) {
    const signer = tryGetSigner()!
    const balance = await getProvider().getBalance(await signer.getAddress())

    // Hold back an operating reserve. FDC requests and registry writes also cost gas, so letting
    // reservations consume the last of the balance would stop verification for every payment on
    // the deployment, including ones already mid-round.
    const floor = parseUnits(String(env.MIN_OPERATIONAL_C2FLR), 18)
    if (balance < collateralReservationFeeWei + floor) {
      blockers.push(
        `Reserving would leave less than the ${env.MIN_OPERATIONAL_C2FLR} C2FLR operating ` +
          `reserve (balance ${formatUnits(balance, 18)}, fee ` +
          `${formatUnits(collateralReservationFeeWei, 18)}). Top up the PayFlux signer.`,
      )
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    lots,
    requiredDrops,
    requiredXrp: dropsToXrp(requiredDrops),
    roundingDrops: requiredDrops > desiredDrops ? requiredDrops - desiredDrops : 0n,
    lotSizeXrp: settings.lotSizeXrp,
    agent,
    agentFeeBIPS: agent?.feeBIPS,
    collateralReservationFeeWei,
    settings,
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface CollateralReservation {
  collateralReservationId: string
  agentVault: string
  /** The agent's XRPL address — this is where the customer must send XRP. */
  paymentAddress: string
  /** The reference the customer's memo must carry, dictated by the AssetManager. */
  paymentReference: string
  valueUBA: bigint
  feeUBA: bigint
  lastUnderlyingTimestamp: number
  transactionHash: string
}

/**
 * Reserves collateral with an agent. Returns the XRPL destination and reference the customer
 * must use — these come from the chain, not from PayFlux.
 */
export async function reserveCollateral(
  agentVault: string,
  lots: number,
  maxMintingFeeBIPS: number,
): Promise<CollateralReservation> {
  return withSigner(async (signer) => {

  const address = await getAssetManagerAddress()
  if (!address) throw new FAssetsUnavailableError("AssetManagerFXRP is not registered")

  const manager = new Contract(address, ASSET_MANAGER_ABI, signer)
  const fee: bigint = await manager.collateralReservationFee(lots)

  // Simulate first: a revert here is a clear, reportable "unavailable", not a lost fee.
  try {
    await manager.reserveCollateral.staticCall(
      agentVault,
      lots,
      maxMintingFeeBIPS,
      "0x0000000000000000000000000000000000000000",
      { value: fee },
    )
  } catch (error) {
    throw new FAssetsUnavailableError(
      `reserveCollateral simulation reverted: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const tx = await manager.reserveCollateral(
    agentVault,
    lots,
    maxMintingFeeBIPS,
    "0x0000000000000000000000000000000000000000",
    { value: fee },
  )
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) {
    throw new FAssetsUnavailableError(`reserveCollateral reverted (tx ${tx.hash})`)
  }

  const parsed = receipt.logs
    .map((log: any) => {
      try {
        return manager.interface.parseLog(log)
      } catch {
        return undefined
      }
    })
    .find((log: any) => log?.name === "CollateralReserved")

  if (!parsed) {
    throw new FAssetsUnavailableError(
      `reserveCollateral succeeded but emitted no CollateralReserved event (tx ${tx.hash})`,
    )
  }

  return {
    collateralReservationId: parsed.args.collateralReservationId.toString(),
    agentVault: parsed.args.agentVault,
    paymentAddress: parsed.args.paymentAddress,
    paymentReference: parsed.args.paymentReference,
    valueUBA: parsed.args.valueUBA,
    feeUBA: parsed.args.feeUBA,
    lastUnderlyingTimestamp: Number(parsed.args.lastUnderlyingTimestamp),
    transactionHash: tx.hash,
  }
  })
}

/**
 * Executes the mint using the FDC proof of the customer's XRP payment. FXRP is credited to the
 * minter — the account that reserved the collateral — and forwarded to the merchant by the
 * settlement service.
 */
export async function executeMinting(
  proof: unknown,
  collateralReservationId: string,
): Promise<{ transactionHash: string; blockNumber: number }> {
  return withSigner(async (signer) => {
    const address = await getAssetManagerAddress()
    if (!address) throw new FAssetsUnavailableError("AssetManagerFXRP is not registered")

    const manager = new Contract(address, ASSET_MANAGER_ABI, signer)
    const tx = await manager.executeMinting(proof, collateralReservationId)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) {
      throw new FAssetsUnavailableError(`executeMinting reverted (tx ${tx.hash})`)
    }
    return { transactionHash: tx.hash, blockNumber: receipt.blockNumber }
  })
}

/** The account that reserves collateral and therefore receives minted FXRP. */
export async function minterAddress(): Promise<string> {
  const signer = tryGetSigner()
  if (!signer) throw new FAssetsUnavailableError("no Coston2 signer configured")
  return signer.getAddress()
}

export async function getFxrpBalance(account: string): Promise<{ raw: bigint; formatted: string }> {
  const settings = await getFAssetSettings()
  const fxrp = new Contract(settings.fAsset, FASSET_ABI, getProvider())
  const raw: bigint = await fxrp.balanceOf(account)
  return { raw, formatted: formatUnits(raw, settings.assetMintingDecimals) }
}

export async function transferFxrp(
  to: string,
  amount: bigint,
): Promise<{ transactionHash: string }> {
  return withSigner(async (signer) => {
    const settings = await getFAssetSettings()
    const fxrp = new Contract(
      settings.fAsset,
      ["function transfer(address to, uint256 amount) external returns (bool)"],
      signer,
    )
    const tx = await fxrp.transfer(to, amount)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) {
      throw new FAssetsUnavailableError(`FXRP transfer reverted (tx ${tx.hash})`)
    }
    return { transactionHash: tx.hash }
  })
}

/** Diagnostics for the dashboard. Reports UNAVAILABLE plainly rather than throwing. */
export async function fassetsHealth() {
  try {
    const [settings, limits] = await Promise.all([getFAssetSettings(), getMintingLimits()])
    return {
      available: limits.totalFreeLots > 0,
      assetManager: settings.assetManager,
      fxrp: settings.fAsset,
      lotSizeXrp: settings.lotSizeXrp,
      totalFreeLots: limits.totalFreeLots,
      agentCount: limits.agentCount,
      maxMintableXrp: limits.maxMintableXrp,
      detail:
        limits.totalFreeLots > 0
          ? undefined
          : "No agent currently has free collateral lots, so FXRP minting is unavailable.",
    }
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
