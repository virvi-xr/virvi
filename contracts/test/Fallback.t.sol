// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;
import {Test, console} from "forge-std/Test.sol";
import {VirviBeat} from "../src/VirviBeat.sol";

/// From the fix-round-1 re-review (LIV-11): the budget's all-code fallback and mixed batches against the worst hook.
/// Worst-case receiver: burns almost all it is given, then accepts (so the mint also writes the balance).
contract BurnThenAccept {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        while (gasleft() > 1_500) {}
        return this.onERC1155Received.selector;
    }
}
contract AcceptingFallback {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC1155Received.selector; }
}

contract FallbackTest is Test {
    VirviBeat beat;
    address minter = address(0xBEEF);
    uint256 constant PER = 131_904;
    uint256 nextId = 1;

    function setUp() public { beat = new VirviBeat(address(0xA11CE), minter, "https://x.io/"); }
    function _intrinsic(uint256 n) internal pure returns (uint256) { return 21_000 + (4 + 32 * (3 + n)) * 16; }
    function _fresh() internal returns (uint256 id) { id = nextId++; vm.prank(minter); beat.createBeat(id, false); }
    function _wallets(uint256 n, uint256 seed) internal pure returns (address[] memory w) {
        w = new address[](n); for (uint256 i = 0; i < n; i++) w[i] = vm.addr(seed + i + 1);
    }
    function _run(uint256 id, address[] memory w, uint256 limit) internal returns (bool ok, uint256 used) {
        vm.prank(minter);
        uint256 g = gasleft();
        (ok,) = address(beat).call{gas: limit - _intrinsic(w.length)}(abi.encodeCall(VirviBeat.mintTo, (id, w)));
        used = g - gasleft() + _intrinsic(w.length);
    }

    /// All wallets had code at plan time: plain part = 80k + 60k*n (no estimate used), +10%, + n*PER.
    function test_AllCodeFallback_WorstHooks() public {
        address hook = address(new BurnThenAccept());
        uint256[6] memory ns = [uint256(1), 2, 5, 20, 50, 100];
        for (uint256 i = 0; i < ns.length; i++) {
            uint256 n = ns[i];
            uint256 id = _fresh();
            address[] memory w = _wallets(n, 1000 * (i + 1));
            for (uint256 j = 0; j < n; j++) vm.etch(w[j], hook.code);
            uint256 limit = (80_000 + 60_000 * n) * 110 / 100 + n * PER;
            (bool ok, uint256 used) = _run(id, w, limit);
            console.log(n, ok ? 1 : 0, beat.mintedCount(id));
            console.log("   limit / used", limit, used);
            assertTrue(ok, "all-code fallback reverted");
            assertEq(beat.mintedCount(id), n);
        }
    }

    function _mixed(uint256 p, uint256 seed) internal {
        uint256 n = 100;
        uint256 id = _fresh();
        address[] memory w = _wallets(n, seed);
        _etchAll(w, 0, n - p, address(new AcceptingFallback()).code);
        uint256 limit = _mixedLimit(id, w, p);
        _etchAll(w, 0, n - p, address(new BurnThenAccept()).code);
        (bool ok, uint256 used) = _run(id, w, limit);
        console.log(p, ok ? 1 : 0, beat.mintedCount(id));
        console.log("   limit / used", limit, used);
        assertTrue(ok, "mixed reverted");
    }
    function _etchAll(address[] memory w, uint256 a, uint256 b, bytes memory code) internal { for (uint256 j = a; j < b; j++) vm.etch(w[j], code); }
    function _mixedLimit(uint256 id, address[] memory w, uint256 p) internal returns (uint256) {
        uint256 c = w.length - p;
        address[] memory plain = new address[](p);
        for (uint256 j = 0; j < p; j++) plain[j] = w[c + j];
        uint256 snap = vm.snapshotState();
        vm.prank(minter); uint256 g = gasleft(); beat.mintTo(id, plain); uint256 est = g - gasleft() + _intrinsic(p);
        vm.revertToState(snap);
        return (est + c * (est / p)) * 110 / 100 + w.length * PER;
    }
    function test_Mixed_FewPlain_WorstHooks() public { _mixed(1, 50_000); _mixed(10, 60_000); _mixed(50, 70_000); }
}
