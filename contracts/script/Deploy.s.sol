// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VirviBeat} from "../src/VirviBeat.sol";

/// Deploys VirviBeat to whichever network `--rpc-url` points at. It reads four settings from the
/// environment: BEAT_ADMIN (controls the settings), BEAT_MINTER (creates and sends BEATs), BEAT_BASE_URI
/// (where names and images are loaded from, ending in "/") and EXPECTED_CHAIN_ID (80002 for Amoy, 137 for
/// Polygon). It stops before sending anything if one is missing or wrong. The deployer wallet is chosen on
/// the command line (e.g. `--interactives 1`), never here, and gets no role.
contract Deploy is Script {
    error WrongChain(uint256 expected, uint256 actual);
    error AdminIsMinter();
    error RoleCheckFailed();

    /// The wallet that sent the deploy transaction.
    address public broadcaster;

    function run() external returns (VirviBeat) {
        return deploy(
            vm.envAddress("BEAT_ADMIN"),
            vm.envAddress("BEAT_MINTER"),
            vm.envString("BEAT_BASE_URI"),
            vm.envUint("EXPECTED_CHAIN_ID")
        );
    }

    /// Checks the settings, deploys, then checks the roles on chain.
    function deploy(address admin, address minter, string memory baseURI, uint256 expectedChainId)
        public
        returns (VirviBeat beat)
    {
        if (block.chainid != expectedChainId) revert WrongChain(expectedChainId, block.chainid);
        if (admin == minter) revert AdminIsMinter();

        vm.startBroadcast();
        (, broadcaster,) = vm.readCallers();
        beat = new VirviBeat(admin, minter, baseURI);
        vm.stopBroadcast();

        bytes32 adminRole = beat.DEFAULT_ADMIN_ROLE();
        bytes32 minterRole = beat.MINTER_ROLE();
        if (
            !beat.hasRole(adminRole, admin) || beat.owner() != admin || !beat.hasRole(minterRole, minter)
                || beat.hasRole(adminRole, broadcaster) || beat.hasRole(minterRole, broadcaster)
        ) revert RoleCheckFailed();

        console.log("VirviBeat deployed at", address(beat));
        console.log("Chain id", block.chainid);
        console.log("Base URI", baseURI);
        console.log("Admin", admin);
        console.log("Minter", minter);
    }
}
