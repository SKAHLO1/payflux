import { expect } from "chai"
import { ethers } from "hardhat"
import type { Signer } from "ethers"

/**
 * Flare's Contract Registry lives at the same address on every Flare network. On the local
 * Hardhat network we place a mock there with `hardhat_setCode`, so PaymentRegistry resolves
 * FdcVerification exactly the way it will on Coston2 — through the registry, never hardcoded.
 */
const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019"

const XRPL_TESTNET = ethers.encodeBytes32String("testXRP")
const ASSET_XRP = ethers.encodeBytes32String("XRP")
const ATTESTATION_PAYMENT = ethers.encodeBytes32String("Payment")

const MERCHANT_XRPL_ADDRESS = "rMerchantDestinationAddressForPayFluxDemo"
const destinationHash = ethers.keccak256(ethers.toUtf8Bytes(MERCHANT_XRPL_ADDRESS))
const paymentReference = ethers.zeroPadValue(ethers.toUtf8Bytes("pay_8F92K2"), 32)

const FIFTY_XRP_IN_DROPS = 50_000_000n

type ProofOverrides = {
  transactionId?: string
  sourceId?: string
  receivingAddressHash?: string
  standardPaymentReference?: string
  receivedAmount?: bigint
  status?: number
  blockTimestamp?: bigint
}

function buildPaymentProof(overrides: ProofOverrides = {}) {
  return {
    merkleProof: [] as string[],
    data: {
      attestationType: ATTESTATION_PAYMENT,
      sourceId: overrides.sourceId ?? XRPL_TESTNET,
      votingRound: 1_000_000n,
      lowestUsedTimestamp: 0n,
      requestBody: {
        transactionId: overrides.transactionId ?? ethers.id("xrpl-tx-1"),
        inUtxo: 0,
        utxo: 0,
      },
      responseBody: {
        blockNumber: 42n,
        blockTimestamp: overrides.blockTimestamp ?? 1_800_000_000n,
        sourceAddressHash: ethers.id("rCustomerAddress"),
        sourceAddressesRoot: ethers.ZeroHash,
        receivingAddressHash: overrides.receivingAddressHash ?? destinationHash,
        intendedReceivingAddressHash: overrides.receivingAddressHash ?? destinationHash,
        spentAmount: 0n,
        intendedSpentAmount: 0n,
        receivedAmount: overrides.receivedAmount ?? FIFTY_XRP_IN_DROPS,
        intendedReceivedAmount: overrides.receivedAmount ?? FIFTY_XRP_IN_DROPS,
        standardPaymentReference: overrides.standardPaymentReference ?? paymentReference,
        oneToOne: true,
        status: overrides.status ?? 0,
      },
    },
  }
}

describe("PaymentRegistry", () => {
  let admin: Signer
  let outsider: Signer
  let merchant: string
  let registry: any
  let fdc: any

  const paymentId = ethers.id("pay_8F92K2")

  function intent(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      paymentId,
      merchant,
      sourceChain: XRPL_TESTNET,
      sourceAsset: ASSET_XRP,
      destinationAddressHash: destinationHash,
      paymentReference,
      minAmount: FIFTY_XRP_IN_DROPS,
      expiresAt: 1_900_000_000n,
      open: true,
      ...overrides,
    }
  }

  beforeEach(async () => {
    ;[admin, outsider] = await ethers.getSigners()
    merchant = await admin.getAddress()

    // Install the mock Contract Registry at Flare's canonical address.
    const registryMock = await (await ethers.getContractFactory("MockFlareContractRegistry")).deploy()
    await registryMock.waitForDeployment()
    const runtimeCode = await ethers.provider.getCode(await registryMock.getAddress())
    await ethers.provider.send("hardhat_setCode", [FLARE_CONTRACT_REGISTRY, runtimeCode])

    fdc = await (await ethers.getContractFactory("MockFdcVerification")).deploy()
    await fdc.waitForDeployment()

    const aliased = await ethers.getContractAt("MockFlareContractRegistry", FLARE_CONTRACT_REGISTRY)
    await aliased.setAddress("FdcVerification", await fdc.getAddress())

    registry = await (await ethers.getContractFactory("PaymentRegistry")).deploy(merchant)
    await registry.waitForDeployment()
  })

  describe("access control", () => {
    it("grants admin the verifier and operator roles", async () => {
      expect(await registry.hasRole(await registry.PAYMENT_VERIFIER(), merchant)).to.equal(true)
      expect(await registry.hasRole(await registry.SETTLEMENT_OPERATOR(), merchant)).to.equal(true)
    })

    it("rejects intent commitments from non-verifiers", async () => {
      await expect(
        registry.connect(outsider).openPaymentIntent(intent()),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
    })

    it("rejects native payment records from non-verifiers", async () => {
      await registry.openPaymentIntent(intent())
      await expect(
        registry
          .connect(outsider)
          .recordNativePayment(paymentId, ASSET_XRP, ethers.id("tx"), FIFTY_XRP_IN_DROPS),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
    })
  })

  describe("intent commitment", () => {
    it("emits PaymentIntentOpened and stores the commitment", async () => {
      await expect(registry.openPaymentIntent(intent()))
        .to.emit(registry, "PaymentIntentOpened")
        .withArgs(
          paymentId,
          merchant,
          XRPL_TESTNET,
          ASSET_XRP,
          paymentReference,
          FIFTY_XRP_IN_DROPS,
          1_900_000_000n,
        )

      const stored = await registry.getPaymentIntent(paymentId)
      expect(stored.open).to.equal(true)
      expect(stored.destinationAddressHash).to.equal(destinationHash)
    })

    it("refuses to overwrite an existing intent", async () => {
      await registry.openPaymentIntent(intent())
      await expect(registry.openPaymentIntent(intent())).to.be.revertedWithCustomError(
        registry,
        "IntentAlreadyExists",
      )
    })
  })

  describe("FDC-verified registration", () => {
    beforeEach(async () => {
      await registry.openPaymentIntent(intent())
    })

    it("registers a payment backed by a valid proof", async () => {
      const proof = buildPaymentProof()
      await expect(registry.connect(outsider).registerVerifiedPayment(paymentId, proof))
        .to.emit(registry, "PaymentVerified")
        .withArgs(
          paymentId,
          merchant,
          XRPL_TESTNET,
          ASSET_XRP,
          FIFTY_XRP_IN_DROPS,
          proof.data.requestBody.transactionId,
        )

      const recorded = await registry.getVerifiedPayment(paymentId)
      expect(recorded.verified).to.equal(true)
      expect(recorded.verificationType).to.equal(await registry.VERIFICATION_FDC_PAYMENT())
      expect(await registry.isVerified(paymentId)).to.equal(true)
    })

    it("rejects a proof the FDC verification contract does not accept", async () => {
      await fdc.setShouldVerify(false)
      await expect(
        registry.registerVerifiedPayment(paymentId, buildPaymentProof()),
      ).to.be.revertedWithCustomError(registry, "InvalidFdcProof")
    })

    it("rejects a payment sent to a different destination", async () => {
      const proof = buildPaymentProof({ receivingAddressHash: ethers.id("rSomeoneElse") })
      await expect(
        registry.registerVerifiedPayment(paymentId, proof),
      ).to.be.revertedWithCustomError(registry, "DestinationMismatch")
    })

    it("rejects a payment carrying the wrong reference", async () => {
      const proof = buildPaymentProof({
        standardPaymentReference: ethers.zeroPadValue(ethers.toUtf8Bytes("pay_OTHER"), 32),
      })
      await expect(
        registry.registerVerifiedPayment(paymentId, proof),
      ).to.be.revertedWithCustomError(registry, "ReferenceMismatch")
    })

    it("rejects an underpayment rather than settling it", async () => {
      const proof = buildPaymentProof({ receivedAmount: 48_000_000n })
      await expect(
        registry.registerVerifiedPayment(paymentId, proof),
      ).to.be.revertedWithCustomError(registry, "AmountBelowMinimum")
    })

    it("accepts an overpayment and records the real received amount", async () => {
      await registry.registerVerifiedPayment(paymentId, buildPaymentProof({ receivedAmount: 52_000_000n }))
      const recorded = await registry.getVerifiedPayment(paymentId)
      expect(recorded.amount).to.equal(52_000_000n)
    })

    it("rejects a failed source-chain transaction", async () => {
      await expect(
        registry.registerVerifiedPayment(paymentId, buildPaymentProof({ status: 1 })),
      ).to.be.revertedWithCustomError(registry, "SourceTransactionFailed")
    })

    it("rejects an attestation from a different source chain", async () => {
      const proof = buildPaymentProof({ sourceId: ethers.encodeBytes32String("testBTC") })
      await expect(
        registry.registerVerifiedPayment(paymentId, proof),
      ).to.be.revertedWithCustomError(registry, "SourceMismatch")
    })

    it("rejects a payment that landed after the intent expired", async () => {
      const proof = buildPaymentProof({ blockTimestamp: 1_900_000_001n })
      await expect(
        registry.registerVerifiedPayment(paymentId, proof),
      ).to.be.revertedWithCustomError(registry, "IntentExpired")
    })

    it("prevents registering the same intent twice", async () => {
      await registry.registerVerifiedPayment(paymentId, buildPaymentProof())
      await expect(
        registry.registerVerifiedPayment(paymentId, buildPaymentProof()),
      ).to.be.revertedWithCustomError(registry, "IntentClosed")
    })

    it("prevents one external transaction from settling two intents", async () => {
      const sharedTx = ethers.id("xrpl-tx-shared")
      await registry.registerVerifiedPayment(paymentId, buildPaymentProof({ transactionId: sharedTx }))

      const secondId = ethers.id("pay_SECOND")
      await registry.openPaymentIntent(intent({ paymentId: secondId }))

      await expect(
        registry.registerVerifiedPayment(secondId, buildPaymentProof({ transactionId: sharedTx })),
      ).to.be.revertedWithCustomError(registry, "TransactionAlreadyUsed")
    })

    it("rejects registration against an unknown intent", async () => {
      await expect(
        registry.registerVerifiedPayment(ethers.id("pay_NOPE"), buildPaymentProof()),
      ).to.be.revertedWithCustomError(registry, "IntentUnknown")
    })
  })

  describe("native Flare payments", () => {
    it("tags native records distinctly from FDC-verified ones", async () => {
      await registry.openPaymentIntent(
        intent({ sourceChain: ethers.encodeBytes32String("coston2") }),
      )
      await registry.recordNativePayment(
        paymentId,
        ethers.encodeBytes32String("C2FLR"),
        ethers.id("0xflare-tx"),
        FIFTY_XRP_IN_DROPS,
      )
      const recorded = await registry.getVerifiedPayment(paymentId)
      expect(recorded.verificationType).to.equal(await registry.VERIFICATION_FLARE_NATIVE())
    })
  })

  describe("pausing", () => {
    it("blocks registration while paused", async () => {
      await registry.openPaymentIntent(intent())
      await registry.pause()
      await expect(
        registry.registerVerifiedPayment(paymentId, buildPaymentProof()),
      ).to.be.revertedWithCustomError(registry, "EnforcedPause")
      await registry.unpause()
      await registry.registerVerifiedPayment(paymentId, buildPaymentProof())
      expect(await registry.isVerified(paymentId)).to.equal(true)
    })
  })

  describe("closing intents", () => {
    it("closes an expired intent without marking it paid", async () => {
      await registry.openPaymentIntent(intent())
      await registry.closePaymentIntent(paymentId, ethers.encodeBytes32String("expired"))
      expect(await registry.isVerified(paymentId)).to.equal(false)
      await expect(
        registry.registerVerifiedPayment(paymentId, buildPaymentProof()),
      ).to.be.revertedWithCustomError(registry, "IntentClosed")
    })
  })
})
