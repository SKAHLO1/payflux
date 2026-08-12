import { Contract } from "ethers"
import { getProvider } from "./provider.js"

/**
 * The Flare Contract Registry.
 *
 * Deployed at the same address on every Flare network, and the documented way to discover
 * FdcHub, FdcRequestFeeConfigurations, FlareSystemsManager, FtsoV2 and the FAssets AssetManagers.
 * PayFlux resolves every one of these through here rather than hardcoding addresses, so the
 * integration survives Flare's contract upgrades (master prompt §4, §15).
 */
export const FLARE_CONTRACT_REGISTRY_ADDRESS = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019"

const REGISTRY_ABI = [
  "function getContractAddressByName(string calldata _name) external view returns (address)",
  "function getAllContracts() external view returns (string[] memory, address[] memory)",
]

const cache = new Map<string, string>()

export function contractRegistry(): Contract {
  return new Contract(FLARE_CONTRACT_REGISTRY_ADDRESS, REGISTRY_ABI, getProvider())
}

export class ContractNotRegisteredError extends Error {
  readonly code = "CONTRACT_NOT_REGISTERED"
  constructor(readonly contractName: string) {
    super(
      `"${contractName}" is not registered in the Flare Contract Registry on this network. ` +
        `This capability is UNAVAILABLE rather than broken.`,
    )
    this.name = "ContractNotRegisteredError"
  }
}

const ZERO = "0x0000000000000000000000000000000000000000"

/** Resolve a contract address by registry name. Returns undefined when not registered. */
export async function tryResolve(name: string): Promise<string | undefined> {
  const cached = cache.get(name)
  if (cached) return cached

  const address: string = await contractRegistry().getContractAddressByName(name)
  if (!address || address === ZERO) return undefined

  cache.set(name, address)
  return address
}

export async function resolve(name: string): Promise<string> {
  const address = await tryResolve(name)
  if (!address) throw new ContractNotRegisteredError(name)
  return address
}

/** Everything the registry knows about — useful for the dashboard's diagnostics view. */
export async function listRegisteredContracts(): Promise<Array<{ name: string; address: string }>> {
  const [names, addresses]: [string[], string[]] = await contractRegistry().getAllContracts()
  return names.map((name, i) => ({ name, address: addresses[i] }))
}

export const FLARE_CONTRACTS = {
  fdcHub: "FdcHub",
  fdcRequestFeeConfigurations: "FdcRequestFeeConfigurations",
  fdcVerification: "FdcVerification",
  flareSystemsManager: "FlareSystemsManager",
  relay: "Relay",
  ftsoV2: "FtsoV2",
  assetManagerFXRP: "AssetManagerFXRP",
} as const
