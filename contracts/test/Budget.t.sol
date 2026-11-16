// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VirviBeat} from "../src/VirviBeat.sol";

/// A receiver that accepts, cheaply (a wallet with code whose hook is cheap when the job estimates).
contract Accepting {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }
}

/// The minting job's gas budget (apps/server/src/beats/job.ts gasLimitOf, LIV-11 fix round I-4) against the real
/// contract: 100 recipients, each budgeted once as a plain mint plus RECEIVER_GAS * 64/63 + GUARD_RESERVE. Wallets
/// with code at plan time are costed at the plain wallets' per-wallet rate. Whatever gains code, or turns its hook into
/// one that burns all its gas, between the estimate and the mine, the batch never reverts.
contract BudgetTest is Test {
    VirviBeat beat;
    address minter = address(0xBEEF);
    address[] to;
    uint256 constant N = 100;
    /// BEAT_GAS_PER_RECIPIENT in apps/server/src/beats/abi.ts
    uint256 constant PER = 131_904;

    function setUp() public {
        beat = new VirviBeat(address(0xA11CE), minter, "https://x.io/");
        vm.prank(minter);
        beat.createBeat(1, false);
        for (uint256 i = 0; i < N; i++) to.push(vm.addr(i + 1));
    }

    function _intrinsic(uint256 n) internal pure returns (uint256) {
        return 21_000 + (4 + 32 * (3 + n)) * 16;
    }

    /// eth_estimateGas of mintTo(1, wallets) as the node would answer: execution plus intrinsic gas.
    function _estimate(address[] memory wallets) internal returns (uint256 est) {
        uint256 snap = vm.snapshotState();
        vm.prank(minter);
        uint256 g = gasleft();
        beat.mintTo(1, wallets);
        est = g - gasleft() + _intrinsic(wallets.length);
        vm.revertToState(snap);
    }

    /// gasLimitOf: the plain wallets estimated alone, the code wallets at their per-wallet rate, +10%, + N * PER.
    function _limit(uint256 withCode) internal returns (uint256) {
        address[] memory plain = new address[](N - withCode);
        for (uint256 i = withCode; i < N; i++) plain[i - withCode] = to[i];
        uint256 est = _estimate(plain);
        uint256 plainPart = est + withCode * (est / (N - withCode));
        return plainPart * 110 / 100 + N * PER;
    }

    function _mints(uint256 limit) internal returns (bool ok) {
        vm.prank(minter);
        (ok,) = address(beat).call{gas: limit - _intrinsic(N)}(abi.encodeCall(VirviBeat.mintTo, (1, to)));
    }

    function test_PerRecipientMatchesTheContract() public view {
        assertEq(PER, beat.RECEIVER_GAS() * 64 / 63 + beat.GUARD_RESERVE());
    }

    function test_Budget_WalletsGainingBurningCodeAfterThePlanNeverRevertTheBatch() public {
        uint256 limit = _limit(0);
        for (uint256 k = 0; k <= N; k += 25) {
            uint256 snap = vm.snapshotState();
            for (uint256 j = 0; j < k; j++) vm.etch(to[j], hex"fe");
            assertTrue(_mints(limit), "reverted");
            assertEq(beat.mintedCount(1), N - k);
            vm.revertToState(snap);
        }
    }

    function test_Budget_CheapHooksAtPlanTimeThatBurnAtMineTimeNeverRevertTheBatch() public {
        Accepting cheap = new Accepting();
        uint256 withCode = 60;
        for (uint256 j = 0; j < withCode; j++) vm.etch(to[j], address(cheap).code);
        uint256 limit = _limit(withCode);
        // Between the estimate and the mine every code wallet's hook turns into one that burns all it is given
        for (uint256 j = 0; j < withCode; j++) vm.etch(to[j], hex"fe");
        assertTrue(_mints(limit), "reverted");
        assertEq(beat.mintedCount(1), N - withCode);
    }
}
