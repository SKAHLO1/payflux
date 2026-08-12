import { HardhatUserConfig } from "hardhat/config"
import "@nomicfoundation/hardhat-ethers"
import "@nomicfoundation/hardhat-chai-matchers"
import "@nomicfoundation/hardhat-verify"
import * as dotenv from "dotenv"

dotenv.config({ path: "../.env" })
dotenv.config()

const COSTON2_RPC_URL = process.env.COSTON2_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc"
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY

// Fail fast rather than silently deploying to the wrong network (master prompt §51).
const COSTON2_CHAIN_ID = 114

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.25",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "london",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    coston2: {
      url: COSTON2_RPC_URL,
      chainId: COSTON2_CHAIN_ID,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      coston2: process.env.FLARE_EXPLORER_API_KEY ?? "no-api-key-required",
    },
    customChains: [
      {
        network: "coston2",
        chainId: COSTON2_CHAIN_ID,
        urls: {
          apiURL: "https://coston2-explorer.flare.network/api",
          browserURL: "https://coston2-explorer.flare.network",
        },
      },
    ],
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    artifacts: "./artifacts",
  },
}

export default config
