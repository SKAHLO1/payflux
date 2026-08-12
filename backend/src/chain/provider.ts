import { JsonRpcProvider, Wallet, Network } from "ethers"
import { env } from "../config/env.js"

/**
 * A single, network-pinned Coston2 provider.
 *
 * The chain ID is baked into the provider's `Network` and `staticNetwork`, so ethers will reject
 * an RPC endpoint that turns out to be a different chain instead of quietly transacting on it.
 */
const COSTON2 = Network.from({ name: "coston2", chainId: env.FLARE_CHAIN_ID })

let providerInstance: JsonRpcProvider | undefined
let signerInstance: Wallet | undefined

export function getProvider(): JsonRpcProvider {
  if (!providerInstance) {
    providerInstance = new JsonRpcProvider(env.COSTON2_RPC_URL, COSTON2, {
      staticNetwork: COSTON2,
      batchMaxCount: 1,
    })
  }
  return providerInstance
}

export class SignerUnavailableError extends Error {
  readonly code = "SIGNER_UNAVAILABLE"
  constructor() {
    super(
      "No Coston2 signer configured. Set COSTON2_PRIVATE_KEY to enable on-chain writes " +
        "(FDC attestation requests, PaymentRegistry commits, FAssets settlement).",
    )
    this.name = "SignerUnavailableError"
  }
}

/** Returns the configured signer, or undefined. Callers must handle absence explicitly. */
export function tryGetSigner(): Wallet | undefined {
  if (!env.COSTON2_PRIVATE_KEY) return undefined
  if (!signerInstance) {
    signerInstance = new Wallet(env.COSTON2_PRIVATE_KEY, getProvider())
  }
  return signerInstance
}

export function getSigner(): Wallet {
  const signer = tryGetSigner()
  if (!signer) throw new SignerUnavailableError()
  return signer
}

/**
 * Serializes everything that sends a transaction from the shared signer.
 *
 * One account signs every write PayFlux makes: FDC attestation requests, PaymentRegistry commits,
 * FAssets minting. Those are triggered independently by the watchers, the finalization sweeper
 * and the API, so without a queue two of them fetch the same nonce and the second is rejected
 * with `nonce too low` — which surfaces as a payment failing for a reason that has nothing to do
 * with the payment.
 *
 * A promise chain is enough: the signer is in-process, and serializing writes costs nothing next
 * to block time. If PayFlux ever runs multiple instances this has to become a distributed lock or
 * a per-instance signer — a shared key across processes would race exactly the same way.
 */
let signerQueue: Promise<unknown> = Promise.resolve()

export function withSigner<T>(operation: (signer: Wallet) => Promise<T>): Promise<T> {
  const result = signerQueue.then(() => operation(getSigner()))
  // Keep the chain alive after a failure, otherwise one rejection stalls every later write.
  signerQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** Confirms the RPC really is Coston2. Called once at boot; failure is fatal. */
export async function assertCoston2(): Promise<void> {
  const network = await getProvider().getNetwork()
  if (network.chainId !== BigInt(env.FLARE_CHAIN_ID)) {
    throw new Error(
      `RPC ${env.COSTON2_RPC_URL} reports chainId ${network.chainId}, expected ` +
        `${env.FLARE_CHAIN_ID} (Coston2). Refusing to operate on the wrong network.`,
    )
  }
}
