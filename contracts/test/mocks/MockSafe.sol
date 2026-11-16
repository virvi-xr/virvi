// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

/// Stand-in for a Safe multisig: answers `getThreshold()` and `getOwners()` like Safe v1.x does.
contract MockSafe is ERC1155Holder {
    uint256 internal threshold;
    address[] internal owners;

    constructor(uint256 t, address[] memory o) {
        threshold = t;
        owners = o;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }
}

/// A contract that isn't a Safe: it has code but no `getThreshold()`.
contract NotASafe {}
