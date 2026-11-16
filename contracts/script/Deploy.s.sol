// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VirviBeat} from "../src/VirviBeat.sol";

/// Deploys VirviBeat to whichever network `--rpc-url` points at. It reads four settings from the
/// environment: BEAT_ADMIN (controls the settings and can reissue; may be a contract such as a Safe, and on
/// mainnet it should be the Safe multisig's address), BEAT_MINTER (creates and sends BEATs), BEAT_BASE_URI
/// (where names and images are loaded from, ending in "/") and EXPECTED_CHAIN_ID (80002 for Amoy, 137 for
/// Polygon). It stops before sending anything if one is missing or wrong, including a base URI for the wrong
/// network: on Polygon (137) it must end in "/polygon/", on Amoy (80002) in "/polygon-amoy/" (token ids count from 1
/// on each chain, so a copied Amoy URI would show the test tokens on mainnet). The deployer wallet is chosen on
/// the command line (e.g. `--interactives 1`), never here, and gets no role.
contract Deploy is Script {
    error WrongChain(uint256 expected, uint256 actual);
    error AdminIsMinter();
    error RoleCheckFailed();
    error WrongBaseURI(string expectedSuffix);

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
        string memory suffix = block.chainid == 137 ? "/polygon/" : block.chainid == 80002 ? "/polygon-amoy/" : "";
        if (!_endsWith(baseURI, suffix)) revert WrongBaseURI(suffix);

        vm.startBroadcast();
        (, broadcaster,) = vm.readCallers();
        beat = new VirviBeat(admin, minter, baseURI);
        vm.stopBroadcast();

        bytes32 adminRole = beat.DEFAULT_ADMIN_ROLE();
        bytes32 minterRole = beat.MINTER_ROLE();
        bytes32 reissuerRole = beat.REISSUER_ROLE();
        if (
            !beat.hasRole(adminRole, admin) || beat.owner() != admin || !beat.hasRole(minterRole, minter)
                || !beat.hasRole(reissuerRole, admin) || beat.hasRole(reissuerRole, minter)
                || beat.hasRole(adminRole, broadcaster) || beat.hasRole(minterRole, broadcaster)
                || beat.hasRole(reissuerRole, broadcaster)
        ) revert RoleCheckFailed();

        console.log("VirviBeat deployed at", address(beat));
        console.log("Chain id", block.chainid);
        console.log("Base URI", baseURI);
        console.log("Admin (also reissuer)", admin);
        console.log("Minter", minter);
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suffix);
        if (b.length > a.length) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }
}
