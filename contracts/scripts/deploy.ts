/**
 * Deploys PaymentRegistry to Coston2 and writes deployment metadata (master prompt §52).
 *
 * The metadata file is the single source of truth consumed by the backend, the SDK and the
 * dashboard — nothing hardcodes the registry address.
 *
 *   npm run deploy:coston2 --workspace @payflux/contracts
 */
import { ethers, network, artifacts } from "hardhat"
import * as fs from "node:fs"
import * as path from "node:path"

const EXPECTED_CHAIN_ID = 114n // Coston2

async function main() {
  const provider = ethers.provider
  const { chainId, name } = await provider.getNetwork()

  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: connected to chainId ${chainId} (${name}) but PayFlux targets ` +
        `Coston2 (${EXPECTED_CHAIN_ID}). Check COSTON2_RPC_URL.`,
    )
  }

  const [deployer] = await ethers.getSigners()
  if (!deployer) {
    throw new Error("No signer available. Set DEPLOYER_PRIVATE_KEY in .env.")
  }

  const balance = await provider.getBalance(deployer.address)
  console.log(`Deployer:  ${deployer.address}`)
  console.log(`Balance:   ${ethers.formatEther(balance)} C2FLR`)
  if (balance === 0n) {
    throw new Error("Deployer has no C2FLR. Fund it at https://faucet.flare.network/coston2")
  }

  const admin = process.env.PAYMENT_REGISTRY_ADMIN ?? deployer.address
  console.log(`Admin:     ${admin}`)

  const factory = await ethers.getContractFactory("PaymentRegistry")
  const registry = await factory.deploy(admin)
  const deployTx = registry.deploymentTransaction()
  console.log(`Deploy tx: ${deployTx?.hash}`)

  await registry.waitForDeployment()
  const address = await registry.getAddress()
  const receipt = deployTx ? await deployTx.wait() : null

  // Sanity check: the registry must be able to resolve FdcVerification via the Contract Registry.
  const fdcVerification = await registry.fdcVerification()
  if (fdcVerification === ethers.ZeroAddress) {
    console.warn(
      "WARNING: FdcVerification resolved to the zero address. FDC-verified registration will " +
        "revert until the Flare Contract Registry exposes it on this network.",
    )
  }

  const artifact = await artifacts.readArtifact("PaymentRegistry")

  const metadata = {
    contract: "PaymentRegistry",
    network: "coston2",
    chainId: Number(chainId),
    address,
    admin,
    deploymentTransaction: deployTx?.hash ?? null,
    blockNumber: receipt?.blockNumber ?? null,
    deployedAt: new Date().toISOString(),
    fdcVerification,
    explorer: {
      contract: `https://coston2-explorer.flare.network/address/${address}`,
      transaction: `https://coston2-explorer.flare.network/tx/${deployTx?.hash}`,
    },
    abi: artifact.abi,
  }

  const outDir = path.resolve(__dirname, "../deployments")
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, "coston2.json")
  fs.writeFileSync(outFile, `${JSON.stringify(metadata, null, 2)}\n`)

  console.log(`\nPaymentRegistry deployed at ${address}`)
  console.log(`FdcVerification:            ${fdcVerification}`)
  console.log(`Metadata written to:        ${outFile}`)
  console.log(`\nAdd to your .env:\n  PAYMENT_REGISTRY_ADDRESS=${address}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
