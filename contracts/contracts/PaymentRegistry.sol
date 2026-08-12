// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/coston2/ContractRegistry.sol";
import {IFdcVerification} from "@flarenetwork/flare-periphery-contracts/coston2/IFdcVerification.sol";
import {IPayment} from "@flarenetwork/flare-periphery-contracts/coston2/IPayment.sol";

/**
 * @title PaymentRegistry
 * @notice On-chain record of cross-ecosystem payments verified by the Flare Data Connector.
 *
 * @dev Trust model.
 *
 * The registry deliberately splits "what the merchant expected" from "what actually happened":
 *
 *   1. A PAYMENT_VERIFIER (the PayFlux backend) opens an intent commitment BEFORE the customer
 *      pays. The commitment pins the merchant, the destination address, the payment reference,
 *      the minimum acceptable amount and the expiry. The backend cannot change it afterwards.
 *
 *   2. Settling the intent requires an FDC `Payment` attestation proof. The proof is checked
 *      against the canonical `FdcVerification` contract resolved through the Flare Contract
 *      Registry — this contract never takes the backend's word that a payment happened.
 *
 * The backend therefore states the expectation; Flare's attestation providers state the fact.
 * Neither side can produce a verified payment alone.
 *
 * `recordNativePayment` covers payments made natively on Flare (C2FLR / FXRP), where no external
 * attestation exists because the transaction is already on this chain. That path is role-gated
 * and emitted with a distinct `verificationType` so off-chain consumers never confuse the two.
 */
contract PaymentRegistry is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant PAYMENT_VERIFIER = keccak256("PAYMENT_VERIFIER");
    bytes32 public constant SETTLEMENT_OPERATOR = keccak256("SETTLEMENT_OPERATOR");

    bytes32 public constant VERIFICATION_FDC_PAYMENT = keccak256("FDC_PAYMENT");
    bytes32 public constant VERIFICATION_FLARE_NATIVE = keccak256("FLARE_NATIVE");

    /// @notice What the merchant asked for, committed before the customer pays.
    struct PaymentIntent {
        bytes32 paymentId;
        address merchant;
        bytes32 sourceChain;
        bytes32 sourceAsset;
        /// @dev keccak256(utf8(destination address)) — matches FDC's address hashing.
        bytes32 destinationAddressHash;
        /// @dev XRPL standard payment reference carrying the PayFlux reference (e.g. pay_8F92K2).
        bytes32 paymentReference;
        /// @dev Smallest unit of the source asset (drops for XRP). Lower bound, not equality.
        uint256 minAmount;
        uint64 expiresAt;
        bool open;
    }

    /// @notice What actually happened, proven by FDC (or by this chain itself).
    struct VerifiedPayment {
        bytes32 paymentId;
        address merchant;
        bytes32 sourceChain;
        bytes32 sourceAsset;
        bytes32 externalTransactionId;
        uint256 amount;
        uint256 timestamp;
        bool verified;
        bytes32 verificationType;
    }

    mapping(bytes32 => PaymentIntent) private _intents;
    mapping(bytes32 => VerifiedPayment) private _payments;

    /// @dev Guards against the same external transaction settling two different intents.
    mapping(bytes32 => bytes32) public transactionToPayment;

    event PaymentIntentOpened(
        bytes32 indexed paymentId,
        address indexed merchant,
        bytes32 sourceChain,
        bytes32 sourceAsset,
        bytes32 paymentReference,
        uint256 minAmount,
        uint64 expiresAt
    );

    event PaymentVerified(
        bytes32 indexed paymentId,
        address indexed merchant,
        bytes32 sourceChain,
        bytes32 sourceAsset,
        uint256 amount,
        bytes32 externalTransactionId
    );

    event PaymentIntentClosed(bytes32 indexed paymentId, bytes32 reason);

    error IntentAlreadyExists(bytes32 paymentId);
    error IntentUnknown(bytes32 paymentId);
    error IntentClosed(bytes32 paymentId);
    error IntentExpired(bytes32 paymentId, uint64 expiresAt, uint64 blockTimestamp);
    error PaymentAlreadyRegistered(bytes32 paymentId);
    error TransactionAlreadyUsed(bytes32 externalTransactionId, bytes32 paymentId);
    error InvalidFdcProof();
    error UnexpectedAttestationType(bytes32 attestationType);
    error SourceMismatch(bytes32 expected, bytes32 actual);
    error DestinationMismatch(bytes32 expected, bytes32 actual);
    error ReferenceMismatch(bytes32 expected, bytes32 actual);
    error AmountBelowMinimum(uint256 minAmount, uint256 receivedAmount);
    error SourceTransactionFailed(uint8 status);
    error InvalidMerchant();

    constructor(address admin) {
        if (admin == address(0)) revert InvalidMerchant();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAYMENT_VERIFIER, admin);
        _grantRole(SETTLEMENT_OPERATOR, admin);
    }

    // ---------------------------------------------------------------------
    // Intent commitment
    // ---------------------------------------------------------------------

    /**
     * @notice Commit the expected shape of a payment before the customer pays.
     * @dev Callable only by PAYMENT_VERIFIER. Immutable once written.
     */
    function openPaymentIntent(PaymentIntent calldata intent)
        external
        whenNotPaused
        onlyRole(PAYMENT_VERIFIER)
    {
        if (intent.merchant == address(0)) revert InvalidMerchant();
        if (_intents[intent.paymentId].paymentId != bytes32(0)) {
            revert IntentAlreadyExists(intent.paymentId);
        }

        PaymentIntent storage stored = _intents[intent.paymentId];
        stored.paymentId = intent.paymentId;
        stored.merchant = intent.merchant;
        stored.sourceChain = intent.sourceChain;
        stored.sourceAsset = intent.sourceAsset;
        stored.destinationAddressHash = intent.destinationAddressHash;
        stored.paymentReference = intent.paymentReference;
        stored.minAmount = intent.minAmount;
        stored.expiresAt = intent.expiresAt;
        stored.open = true;

        emit PaymentIntentOpened(
            intent.paymentId,
            intent.merchant,
            intent.sourceChain,
            intent.sourceAsset,
            intent.paymentReference,
            intent.minAmount,
            intent.expiresAt
        );
    }

    /**
     * @notice Close an intent that will never be settled (expired, cancelled).
     * @dev Does not mark the payment verified — an expired intent stays unpaid.
     */
    function closePaymentIntent(bytes32 paymentId, bytes32 reason)
        external
        onlyRole(PAYMENT_VERIFIER)
    {
        PaymentIntent storage intent = _intents[paymentId];
        if (intent.paymentId == bytes32(0)) revert IntentUnknown(paymentId);
        intent.open = false;
        emit PaymentIntentClosed(paymentId, reason);
    }

    // ---------------------------------------------------------------------
    // FDC-verified settlement
    // ---------------------------------------------------------------------

    /**
     * @notice Register an external-chain payment using an FDC `Payment` attestation proof.
     * @dev Permissionless on purpose: the proof is the authority, not the caller. Anyone
     *      (customer, merchant, a watcher, a judge) can push a valid proof for an open intent.
     */
    function registerVerifiedPayment(bytes32 paymentId, IPayment.Proof calldata proof)
        external
        nonReentrant
        whenNotPaused
    {
        PaymentIntent storage intent = _intents[paymentId];
        if (intent.paymentId == bytes32(0)) revert IntentUnknown(paymentId);
        if (!intent.open) revert IntentClosed(paymentId);
        if (_payments[paymentId].verified) revert PaymentAlreadyRegistered(paymentId);

        // 1. The proof must verify against Flare's canonical FDC verification contract.
        if (!_verifyFdcProof(proof)) revert InvalidFdcProof();

        IPayment.Response calldata response = proof.data;
        IPayment.ResponseBody calldata body = response.responseBody;

        // 2. The attestation must be about the chain and asset the intent expects.
        if (response.sourceId != intent.sourceChain) {
            revert SourceMismatch(intent.sourceChain, response.sourceId);
        }

        // 3. The source-chain transaction must itself have succeeded (0 == success).
        if (body.status != 0) revert SourceTransactionFailed(body.status);

        // 4. The funds must have reached the merchant's destination, carrying our reference.
        if (body.receivingAddressHash != intent.destinationAddressHash) {
            revert DestinationMismatch(intent.destinationAddressHash, body.receivingAddressHash);
        }
        if (body.standardPaymentReference != intent.paymentReference) {
            revert ReferenceMismatch(intent.paymentReference, body.standardPaymentReference);
        }

        // 5. The payment must have landed before the intent expired. `blockTimestamp` comes
        //    from the attested source-chain block, not from this chain's clock.
        if (intent.expiresAt != 0 && body.blockTimestamp > intent.expiresAt) {
            revert IntentExpired(paymentId, intent.expiresAt, body.blockTimestamp);
        }

        // 6. Amount floor. Overpayment is accepted here and reconciled off-chain; underpayment
        //    is rejected so a partial transfer can never present as a settled payment.
        uint256 received = body.receivedAmount <= 0 ? 0 : uint256(body.receivedAmount);
        if (received < intent.minAmount) revert AmountBelowMinimum(intent.minAmount, received);

        // 7. One external transaction may settle at most one intent.
        bytes32 txId = response.requestBody.transactionId;
        bytes32 claimedBy = transactionToPayment[txId];
        if (claimedBy != bytes32(0)) revert TransactionAlreadyUsed(txId, claimedBy);
        transactionToPayment[txId] = paymentId;

        intent.open = false;

        _payments[paymentId] = VerifiedPayment({
            paymentId: paymentId,
            merchant: intent.merchant,
            sourceChain: intent.sourceChain,
            sourceAsset: intent.sourceAsset,
            externalTransactionId: txId,
            amount: received,
            timestamp: body.blockTimestamp,
            verified: true,
            verificationType: VERIFICATION_FDC_PAYMENT
        });

        emit PaymentVerified(
            paymentId,
            intent.merchant,
            intent.sourceChain,
            intent.sourceAsset,
            received,
            txId
        );
    }

    /**
     * @notice Record a payment that happened natively on this chain (C2FLR / FXRP transfer).
     * @dev No FDC attestation exists for a Flare-native transfer — the transaction is already
     *      final here. Role-gated and tagged FLARE_NATIVE so it is never mistaken for an
     *      FDC-verified cross-chain payment.
     */
    function recordNativePayment(
        bytes32 paymentId,
        bytes32 sourceAsset,
        bytes32 transactionHash,
        uint256 amount
    ) external nonReentrant whenNotPaused onlyRole(PAYMENT_VERIFIER) {
        PaymentIntent storage intent = _intents[paymentId];
        if (intent.paymentId == bytes32(0)) revert IntentUnknown(paymentId);
        if (!intent.open) revert IntentClosed(paymentId);
        if (_payments[paymentId].verified) revert PaymentAlreadyRegistered(paymentId);
        if (amount < intent.minAmount) revert AmountBelowMinimum(intent.minAmount, amount);

        bytes32 claimedBy = transactionToPayment[transactionHash];
        if (claimedBy != bytes32(0)) revert TransactionAlreadyUsed(transactionHash, claimedBy);
        transactionToPayment[transactionHash] = paymentId;

        intent.open = false;

        _payments[paymentId] = VerifiedPayment({
            paymentId: paymentId,
            merchant: intent.merchant,
            sourceChain: intent.sourceChain,
            sourceAsset: sourceAsset,
            externalTransactionId: transactionHash,
            amount: amount,
            timestamp: block.timestamp,
            verified: true,
            verificationType: VERIFICATION_FLARE_NATIVE
        });

        emit PaymentVerified(
            paymentId,
            intent.merchant,
            intent.sourceChain,
            sourceAsset,
            amount,
            transactionHash
        );
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getPaymentIntent(bytes32 paymentId) external view returns (PaymentIntent memory) {
        return _intents[paymentId];
    }

    function getVerifiedPayment(bytes32 paymentId) external view returns (VerifiedPayment memory) {
        return _payments[paymentId];
    }

    function isVerified(bytes32 paymentId) external view returns (bool) {
        return _payments[paymentId].verified;
    }

    /// @notice Address of the FDC verification contract this registry trusts, for auditability.
    function fdcVerification() external view returns (address) {
        return address(ContractRegistry.getFdcVerification());
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /**
     * @dev Resolved through the Flare Contract Registry rather than a hardcoded address, so the
     *      registry keeps working across FDC verification contract upgrades.
     */
    function _verifyFdcProof(IPayment.Proof calldata proof) internal view returns (bool) {
        IFdcVerification verification = ContractRegistry.getFdcVerification();
        if (address(verification) == address(0)) return false;
        return verification.verifyPayment(proof);
    }
}
