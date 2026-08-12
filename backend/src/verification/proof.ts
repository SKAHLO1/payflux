import { AbiCoder, zeroPadBytes, toUtf8Bytes, hexlify } from "ethers"

/**
 * ABI shapes for the FDC `Payment` attestation, and helpers to move between the Data
 * Availability layer's wire format and the struct `IFdcVerification.verifyPayment` expects.
 */

/**
 * Transcribed from `@flarenetwork/flare-periphery-contracts/coston2/IPayment.sol`.
 *
 * `inUtxo` and `utxo` are `uint256`, not `uint16`. They are always 0 for XRPL, which makes the
 * difference invisible when decoding — but the function selector is computed from the type
 * string, so encoding them as uint16 produces a call no contract has. It lands in the fallback
 * and reverts with no data, which looks like a proof failure and is not one.
 */
export const PAYMENT_RESPONSE_ABI =
  "tuple(" +
  "bytes32 attestationType," +
  "bytes32 sourceId," +
  "uint64 votingRound," +
  "uint64 lowestUsedTimestamp," +
  "tuple(bytes32 transactionId,uint256 inUtxo,uint256 utxo) requestBody," +
  "tuple(" +
  "uint64 blockNumber," +
  "uint64 blockTimestamp," +
  "bytes32 sourceAddressHash," +
  "bytes32 sourceAddressesRoot," +
  "bytes32 receivingAddressHash," +
  "bytes32 intendedReceivingAddressHash," +
  "int256 spentAmount," +
  "int256 intendedSpentAmount," +
  "int256 receivedAmount," +
  "int256 intendedReceivedAmount," +
  "bytes32 standardPaymentReference," +
  "bool oneToOne," +
  "uint8 status" +
  ") responseBody" +
  ")"

export interface PaymentResponse {
  attestationType: string
  sourceId: string
  votingRound: bigint
  lowestUsedTimestamp: bigint
  requestBody: {
    transactionId: string
    inUtxo: number
    utxo: number
  }
  responseBody: {
    blockNumber: bigint
    blockTimestamp: bigint
    sourceAddressHash: string
    sourceAddressesRoot: string
    receivingAddressHash: string
    intendedReceivingAddressHash: string
    spentAmount: bigint
    intendedSpentAmount: bigint
    receivedAmount: bigint
    intendedReceivedAmount: bigint
    standardPaymentReference: string
    oneToOne: boolean
    status: number
  }
}

export interface PaymentProof {
  merkleProof: string[]
  data: PaymentResponse
}

/** Attestation type / source identifiers are UTF-8, right-padded to 32 bytes. */
export function encodeBytes32Utf8(value: string): string {
  return hexlify(zeroPadBytes(toUtf8Bytes(value), 32))
}

export const ATTESTATION_TYPE_PAYMENT = encodeBytes32Utf8("Payment")
export const ATTESTATION_TYPE_REFERENCED_PAYMENT_NONEXISTENCE = encodeBytes32Utf8(
  "ReferencedPaymentNonexistence",
)

const coder = AbiCoder.defaultAbiCoder()

export function decodePaymentResponse(responseHex: string): PaymentResponse {
  const [decoded] = coder.decode([PAYMENT_RESPONSE_ABI], responseHex)
  return {
    attestationType: decoded.attestationType,
    sourceId: decoded.sourceId,
    votingRound: decoded.votingRound,
    lowestUsedTimestamp: decoded.lowestUsedTimestamp,
    requestBody: {
      transactionId: decoded.requestBody.transactionId,
      inUtxo: Number(decoded.requestBody.inUtxo),
      utxo: Number(decoded.requestBody.utxo),
    },
    responseBody: {
      blockNumber: decoded.responseBody.blockNumber,
      blockTimestamp: decoded.responseBody.blockTimestamp,
      sourceAddressHash: decoded.responseBody.sourceAddressHash,
      sourceAddressesRoot: decoded.responseBody.sourceAddressesRoot,
      receivingAddressHash: decoded.responseBody.receivingAddressHash,
      intendedReceivingAddressHash: decoded.responseBody.intendedReceivingAddressHash,
      spentAmount: decoded.responseBody.spentAmount,
      intendedSpentAmount: decoded.responseBody.intendedSpentAmount,
      receivedAmount: decoded.responseBody.receivedAmount,
      intendedReceivedAmount: decoded.responseBody.intendedReceivedAmount,
      standardPaymentReference: decoded.responseBody.standardPaymentReference,
      oneToOne: decoded.responseBody.oneToOne,
      status: Number(decoded.responseBody.status),
    },
  }
}

/** The tuple layout ethers needs when passing the proof to PaymentRegistry. */
export function toContractProof(proof: PaymentProof) {
  const { data } = proof
  return {
    merkleProof: proof.merkleProof,
    data: {
      attestationType: data.attestationType,
      sourceId: data.sourceId,
      votingRound: data.votingRound,
      lowestUsedTimestamp: data.lowestUsedTimestamp,
      requestBody: {
        transactionId: data.requestBody.transactionId,
        inUtxo: data.requestBody.inUtxo,
        utxo: data.requestBody.utxo,
      },
      responseBody: { ...data.responseBody },
    },
  }
}

/** JSON-safe view of a proof, for API responses and the dashboard's proof inspector. */
export function serializeProof(proof: PaymentProof) {
  return JSON.parse(
    JSON.stringify(proof, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
  ) as Record<string, unknown>
}
