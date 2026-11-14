// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VirviBeat} from "../src/VirviBeat.sol";

/// Deploys VirviBeat. Reads BEAT_ADMIN, BEAT_MINTER and BEAT_BASE_URI from the environment.
/// The signer is chosen on the command line (e.g. `--interactives 1`), never here.
contract Deploy is Script {
    function run() external returns (VirviBeat beat) {
        address admin = vm.envAddress("BEAT_ADMIN");
        address minter = vm.envAddress("BEAT_MINTER");
        string memory baseURI = vm.envString("BEAT_BASE_URI");

        vm.startBroadcast();
        beat = new VirviBeat(admin, minter, baseURI);
        vm.stopBroadcast();

        console.log("VirviBeat deployed at", address(beat));
    }
}
