// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IPayment} from "@flarenetwork/flare-periphery-contracts/coston2/IPayment.sol";

/**
 * Test doubles only. These exist so PaymentRegistry's *matching* logic can be exercised in
 * isolation on a local Hardhat network, where Flare's real Contract Registry does not exist.
 *
 * They are never deployed to Coston2 and are not part of the demo path. The genuine FDC
 * verification path is exercised by scripts/poc/e2e.ts against live Coston2.
 */

/// @dev Stands in for Flare's FdcVerification. Returns whatever the test tells it to.
contract MockFdcVerification {
    bool public shouldVerify = true;

    function setShouldVerify(bool value) external {
        shouldVerify = value;
    }

    function verifyPayment(IPayment.Proof calldata) external view returns (bool) {
        return shouldVerify;
    }
}

/// @dev Stands in for Flare's Contract Registry, deployed at the canonical address via setCode.
contract MockFlareContractRegistry {
    mapping(bytes32 => address) private _addresses;

    function setAddress(string memory name, address addr) external {
        _addresses[keccak256(abi.encode(name))] = addr;
    }

    function getContractAddressByName(string calldata name) external view returns (address) {
        return _addresses[keccak256(abi.encode(name))];
    }

    function getContractAddressByHash(bytes32 nameHash) external view returns (address) {
        return _addresses[nameHash];
    }
}
