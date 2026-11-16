// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {VirviBeat} from "../src/VirviBeat.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockSafe, NotASafe} from "./mocks/MockSafe.sol";

/// A new wallet whose batch hook tries everything it can while `reissue` is minting to it.
contract ReentrantTo is ERC1155Holder {
    VirviBeat public beat;
    address public from;
    address public sink;
    uint256 public calls;
    bool public reissueOk;
    bool public mintToOk;
    bool public moveFromOk;
    bool public moveOwnOk;

    function set(VirviBeat b, address f, address s) external {
        beat = b;
        from = f;
        sink = s;
    }

    function onERC1155BatchReceived(address, address, uint256[] memory ids, uint256[] memory, bytes memory)
        public
        override
        returns (bytes4)
    {
        calls++;
        uint256 id = ids[0];
        uint256[] memory one = new uint256[](1);
        one[0] = id;
        try beat.reissue(address(this), sink, one) {
            reissueOk = true;
        } catch {}
        address[] memory l = new address[](1);
        l[0] = address(this);
        try beat.mintTo(id, l) {
            mintToOk = true;
        } catch {}
        // Moving its own fresh copy of a tradeable BEAT is allowed: it's its copy.
        try beat.safeTransferFrom(address(this), sink, id, 1, "") {
            moveOwnOk = true;
        } catch {}
        // Moving the old wallet's replaced copy (it holds the old wallet's approval) must fail.
        try beat.safeTransferFrom(from, sink, id, 1, "") {
            moveFromOk = true;
        } catch {}
        return this.onERC1155BatchReceived.selector;
    }
}

contract ERC1155HolderImpl is ERC1155Holder {}

/// The attack and wording findings from the 2026-11-15 reissue review, as tests of the fixed behaviour.
contract VirviBeatReissueReviewTest is Test {
    string internal constant BASE = "https://api.virvi.io/api/beats/metadata/polygon-amoy/";
    string internal constant POLYGON_BASE = "https://api.virvi.io/api/beats/metadata/polygon/";
    address internal admin = makeAddr("admin");
    address internal minter = makeAddr("minter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal thief = makeAddr("thief");
    address internal thief2 = makeAddr("thief2");
    address internal buyer = makeAddr("buyer");
    uint256 internal constant LOCKED = 1;
    uint256 internal constant OPEN = 2;
    VirviBeat internal beat;

    function setUp() public {
        beat = new VirviBeat(admin, minter, BASE);
        vm.startPrank(minter);
        beat.createBeat(LOCKED, false);
        beat.createBeat(OPEN, true);
        vm.stopPrank();
    }

    function _l(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory l) {
        l = new uint256[](1);
        l[0] = a;
    }

    function _mint(uint256 id, address to) internal {
        vm.prank(minter);
        beat.mintTo(id, _l(to));
    }

    function _owners(uint256 n) internal pure returns (address[] memory o) {
        o = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            o[i] = address(uint160(0x5AFE0 + i));
        }
    }

    function _safe(uint256 threshold) internal returns (address) {
        return address(new MockSafe(threshold, _owners(3)));
    }

    function _handover(address to) internal {
        vm.prank(admin);
        beat.beginDefaultAdminTransfer(to);
        vm.warp(block.timestamp + 1 days + 1);
        if (to == address(0)) {
            bytes32 adminRole = beat.DEFAULT_ADMIN_ROLE();
            vm.prank(admin);
            beat.renounceRole(adminRole, admin);
        } else {
            vm.prank(to);
            beat.acceptDefaultAdminTransfer();
        }
    }

    // ------------------------------------------------- I1: nothing to replace

    /// The thief, holding the compromised key, moves the tradeable copy out before the Safe's reissue
    /// lands. The reissue now reverts, so no second sellable copy is minted.
    function test_I1_ThiefMovesCopyFirst_ReissueReverts() public {
        _mint(OPEN, alice);
        vm.prank(alice);
        beat.safeTransferFrom(alice, thief2, OPEN, 1, "");
        vm.prank(minter);
        beat.closeBeat(OPEN);

        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NothingToReplace.selector, OPEN, alice));
        vm.prank(admin);
        beat.reissue(alice, bob, _ids(OPEN));
        assertEq(beat.balanceOf(bob, OPEN), 0);
        assertFalse(beat.minted(OPEN, bob));
        assertEq(beat.replacedBy(OPEN, alice), address(0));
    }

    /// A seller sells, then asks support for a reissue: it reverts.
    function test_I1_SellerSellsThenReissueReverts() public {
        _mint(OPEN, alice);
        vm.prank(alice);
        beat.safeTransferFrom(alice, buyer, OPEN, 1, "");
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NothingToReplace.selector, OPEN, alice));
        vm.prank(admin);
        beat.reissue(alice, bob, _ids(OPEN));
    }

    /// A burned tradeable copy can't be reissued either (nothing left to freeze).
    function test_I1_BurnedTradeableCopyReverts() public {
        _mint(OPEN, alice);
        vm.prank(alice);
        beat.burn(alice, OPEN, 1);
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NothingToReplace.selector, OPEN, alice));
        vm.prank(admin);
        beat.reissue(alice, bob, _ids(OPEN));
    }

    /// A non-tradeable copy can't have moved, so a burned one can still be reissued: the person isn't
    /// punished for burning.
    function test_I1_BurnedNonTradeableCopyCanStillBeReissued() public {
        _mint(LOCKED, alice);
        vm.prank(alice);
        beat.burn(alice, LOCKED, 1);
        vm.prank(admin);
        beat.reissue(alice, bob, _ids(LOCKED));
        assertEq(beat.balanceOf(bob, LOCKED), 1);
        assertEq(beat.replacedBy(LOCKED, alice), bob);
    }

    /// If the thief buys another copy back into the old wallet to pass the check, that copy is frozen, so
    /// the number of copies that can move doesn't grow.
    function test_I1_CopyBoughtBackIntoOldWalletIsFrozen() public {
        _mint(OPEN, alice);
        _mint(OPEN, buyer);
        vm.prank(alice);
        beat.safeTransferFrom(alice, thief2, OPEN, 1, "");
        vm.prank(buyer);
        beat.safeTransferFrom(buyer, alice, OPEN, 1, "");
        vm.prank(admin);
        beat.reissue(alice, bob, _ids(OPEN));
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.ReplacedCopy.selector, OPEN, alice));
        vm.prank(alice);
        beat.safeTransferFrom(alice, thief, OPEN, 1, "");
    }

    /// All or nothing: a good id with a tradeable id that was moved out reverts the whole call.
    function test_I1_MixedCallIsAllOrNothing() public {
        _mint(LOCKED, alice);
        _mint(OPEN, alice);
        vm.prank(alice);
        beat.safeTransferFrom(alice, thief2, OPEN, 1, "");
        uint256[] memory ids = new uint256[](2);
        ids[0] = LOCKED;
        ids[1] = OPEN;
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NothingToReplace.selector, OPEN, alice));
        vm.prank(admin);
        beat.reissue(alice, bob, ids);
        assertEq(beat.replacedBy(LOCKED, alice), address(0));
        assertEq(beat.balanceOf(bob, LOCKED), 0);
    }

    /// A tradeable chain works while each wallet still holds its copy, and stops once the copy moved out.
    function test_I1_TradeableChain() public {
        _mint(OPEN, alice);
        vm.startPrank(admin);
        beat.reissue(alice, bob, _ids(OPEN));
        beat.reissue(bob, carol, _ids(OPEN));
        vm.stopPrank();
        assertEq(beat.balanceOf(carol, OPEN), 1);

        vm.prank(carol);
        beat.safeTransferFrom(carol, buyer, OPEN, 1, "");
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NothingToReplace.selector, OPEN, carol));
        vm.prank(admin);
        beat.reissue(carol, thief, _ids(OPEN));
    }

    /// The review's "unlimited sellable copies by chaining" attack: moving each fresh copy out before the
    /// next hop now stops the chain at the first hop, so at most one copy per chain can move.
    function test_I1_ChainingCannotMintSellableCopies() public {
        address support = makeAddr("support");
        bytes32 r = beat.REISSUER_ROLE();
        vm.prank(admin);
        beat.grantRole(r, support);
        _mint(OPEN, alice);
        vm.prank(minter);
        beat.closeBeat(OPEN);

        address next = address(uint160(0xBEEF0000));
        vm.prank(support);
        beat.reissue(alice, next, _ids(OPEN));
        vm.prank(next);
        beat.safeTransferFrom(next, thief, OPEN, 1, "");

        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NothingToReplace.selector, OPEN, next));
        vm.prank(support);
        beat.reissue(next, address(uint160(0xBEEF0001)), _ids(OPEN));
        assertEq(beat.balanceOf(thief, OPEN), 1);
        assertFalse(beat.isTransferable(OPEN, alice, buyer), "alice's copy is frozen");
    }

    // -------------------------------------------- M1: reissuer follows the seat

    function test_M1_HandoverMovesReissuer() public {
        address newAdmin = makeAddr("newAdmin");
        bytes32 r = beat.REISSUER_ROLE();
        _handover(newAdmin);
        assertEq(beat.owner(), newAdmin);
        assertTrue(beat.hasRole(r, newAdmin), "new admin gets reissuer");
        assertFalse(beat.hasRole(r, admin), "old admin loses reissuer");

        _mint(LOCKED, alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, r));
        vm.prank(admin);
        beat.reissue(alice, bob, _ids(LOCKED));
        vm.prank(newAdmin);
        beat.reissue(alice, bob, _ids(LOCKED));
        assertEq(beat.balanceOf(bob, LOCKED), 1);
    }

    function test_M1_RenounceDropsReissuer() public {
        bytes32 r = beat.REISSUER_ROLE();
        _handover(address(0));
        assertEq(beat.owner(), address(0));
        assertFalse(beat.hasRole(r, admin));

        _mint(OPEN, alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, r));
        vm.prank(admin);
        beat.reissue(alice, thief, _ids(OPEN));
    }

    /// Someone the admin granted reissuer to separately (for example a host contract's event admin) keeps
    /// it across the handover, until the admin revokes it.
    function test_M1_SeparateHolderKeepsReissuerUntilRevoked() public {
        address support = makeAddr("support");
        address newAdmin = makeAddr("newAdmin");
        bytes32 r = beat.REISSUER_ROLE();
        vm.prank(admin);
        beat.grantRole(r, support);

        _handover(newAdmin);
        assertTrue(beat.hasRole(r, support), "separate holder keeps it");

        _mint(LOCKED, alice);
        vm.prank(support);
        beat.reissue(alice, bob, _ids(LOCKED));

        vm.prank(newAdmin);
        beat.revokeRole(r, support);
        assertFalse(beat.hasRole(r, support));
    }

    /// The admin can still drop the reissuer role from itself while staying admin, and take it back.
    function test_M1_AdminCanDropAndRetakeReissuerAndStaysAdmin() public {
        bytes32 r = beat.REISSUER_ROLE();
        vm.prank(admin);
        beat.revokeRole(r, admin);
        assertFalse(beat.hasRole(r, admin));
        assertEq(beat.owner(), admin);
        vm.prank(admin);
        beat.grantRole(r, admin);
        assertTrue(beat.hasRole(r, admin));
    }

    /// Wording check behind M3: the admin can grant reissuer to the minter. The README must not claim
    /// otherwise.
    function test_M3_AdminCanGrantReissuerToMinter() public {
        bytes32 r = beat.REISSUER_ROLE();
        vm.prank(admin);
        beat.grantRole(r, minter);
        assertTrue(beat.hasRole(r, minter));
    }

    /// Wording check behind M3: "never minted", not "never given". A wallet that bought a copy can receive a
    /// reissue and ends with two.
    function test_M3_ReissueToWalletThatBoughtACopy() public {
        _mint(OPEN, alice);
        _mint(OPEN, buyer);
        vm.prank(buyer);
        beat.safeTransferFrom(buyer, bob, OPEN, 1, "");
        vm.prank(admin);
        beat.reissue(alice, bob, _ids(OPEN));
        assertEq(beat.balanceOf(bob, OPEN), 2);
    }

    // ------------------------------------------------------------- M5: batch

    function test_M5_OneBatchMintAndOneHook() public {
        ReentrantTo to = new ReentrantTo();
        to.set(beat, alice, thief);
        _mint(OPEN, alice);
        _mint(LOCKED, alice);
        vm.prank(alice);
        beat.setApprovalForAll(address(to), true); // even with the old wallet's approval
        uint256[] memory ids = new uint256[](2);
        ids[0] = OPEN;
        ids[1] = LOCKED;
        uint256[] memory ones = new uint256[](2);
        ones[0] = 1;
        ones[1] = 1;

        vm.expectEmit(true, true, true, true, address(beat));
        emit VirviBeat.Reissued(OPEN, alice, address(to));
        vm.expectEmit(true, true, true, true, address(beat));
        emit VirviBeat.Reissued(LOCKED, alice, address(to));
        vm.expectEmit(true, true, true, true, address(beat));
        emit IERC1155.TransferBatch(admin, address(0), address(to), ids, ones);
        vm.prank(admin);
        beat.reissue(alice, address(to), ids);

        assertEq(to.calls(), 1, "one receiver hook for the whole call");
        assertFalse(to.reissueOk());
        assertFalse(to.mintToOk());
        assertFalse(to.moveFromOk());
        assertTrue(to.moveOwnOk());
        assertEq(beat.balanceOf(thief, OPEN), 1);
        assertEq(beat.balanceOf(address(to), LOCKED), 1);
        assertEq(beat.balanceOf(alice, OPEN), 1);
        assertEq(beat.mintedCount(OPEN), 2);
    }

    // ------------------------------------------------------------ freeze edges

    function test_FreezeEdges() public {
        vm.prank(minter);
        beat.createBeat(3, true);
        _mint(OPEN, alice);
        _mint(3, alice);
        vm.prank(admin);
        beat.reissue(alice, bob, _ids(OPEN));
        uint256[] memory ids = new uint256[](2);
        ids[0] = 3;
        ids[1] = OPEN;
        uint256[] memory v = new uint256[](2);
        v[0] = 1;
        v[1] = 0; // a zero-value move of the replaced id
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.ReplacedCopy.selector, OPEN, alice));
        beat.safeBatchTransferFrom(alice, buyer, ids, v, "");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.ReplacedCopy.selector, OPEN, alice));
        beat.safeTransferFrom(alice, buyer, OPEN, 0, "");
        // An operator can't burn it either: only the holder can.
        vm.prank(alice);
        beat.setApprovalForAll(thief, true);
        vm.prank(thief);
        vm.expectRevert(VirviBeat.OnlyHolderCanBurn.selector);
        beat.burn(alice, OPEN, 1);
        // A copy that arrives in the replaced wallet later is stuck there too.
        _mint(OPEN, buyer);
        vm.prank(buyer);
        beat.safeTransferFrom(buyer, alice, OPEN, 1, "");
        assertEq(beat.balanceOf(alice, OPEN), 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.ReplacedCopy.selector, OPEN, alice));
        beat.safeTransferFrom(alice, buyer, OPEN, 1, "");
    }

    /// The old wallet gaining code (EIP-7702 delegation, simulated with etch since the repo builds for
    /// cancun) can't escape the storage-keyed freeze.
    function test_WalletWithCodeCannotEscapeFreeze() public {
        _mint(OPEN, alice);
        vm.prank(admin);
        beat.reissue(alice, bob, _ids(OPEN));
        vm.etch(alice, address(new ERC1155HolderImpl()).code);
        assertGt(alice.code.length, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.ReplacedCopy.selector, OPEN, alice));
        beat.safeTransferFrom(alice, buyer, OPEN, 1, "");
    }

    /// 200 ids (MAX_BATCH) fit well under Polygon's 30M block gas limit.
    function test_Reissue_Gas_200Ids() public {
        uint256[] memory ids = new uint256[](200);
        vm.startPrank(minter);
        for (uint256 i = 0; i < 200; i++) {
            ids[i] = 100 + i;
            beat.createBeat(ids[i], false);
            beat.mintTo(ids[i], _l(alice));
        }
        vm.stopPrank();
        vm.prank(admin);
        uint256 g = gasleft();
        beat.reissue(alice, bob, ids);
        uint256 used = g - gasleft();
        emit log_named_uint("reissue 200 ids, gas", used);
        assertLt(used, 20_000_000);
    }

    // ------------------------------------------- I2: the mainnet admin is a Safe

    function test_I2_MainnetRejectsEoaAdmin() public {
        vm.chainId(137);
        Deploy d = new Deploy();
        address eoa = 0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220;
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminNotAContract.selector, eoa));
        d.deploy(eoa, minter, POLYGON_BASE, 137);
    }

    function test_I2_MainnetRejectsContractThatIsNotASafe() public {
        vm.chainId(137);
        Deploy d = new Deploy();
        address notSafe = address(new NotASafe());
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminNotASafe.selector, notSafe));
        d.deploy(notSafe, minter, POLYGON_BASE, 137);
    }

    function test_I2_MainnetRejectsSafeWithThresholdUnderTwo() public {
        vm.chainId(137);
        Deploy d = new Deploy();
        address safe = _safe(1);
        vm.expectRevert(abi.encodeWithSelector(Deploy.SafeThresholdTooLow.selector, 1));
        d.deploy(safe, minter, POLYGON_BASE, 137);
    }

    function test_I2_MainnetAcceptsTwoOfThreeSafe() public {
        vm.chainId(137);
        Deploy d = new Deploy();
        address safe = _safe(2);
        VirviBeat b = d.deploy(safe, minter, POLYGON_BASE, 137);
        assertEq(b.owner(), safe);
        assertTrue(b.hasRole(b.REISSUER_ROLE(), safe));
        assertFalse(b.hasRole(b.REISSUER_ROLE(), minter));
    }

    /// Amoy still allows an EOA admin (it only warns), and a Safe.
    function test_I2_AmoyAllowsEoaAdminAndSafe() public {
        vm.chainId(80002);
        Deploy d = new Deploy();
        address eoa = 0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220;
        assertEq(d.deploy(eoa, minter, BASE, 80002).owner(), eoa);
        address safe = _safe(2);
        assertEq(d.deploy(safe, minter, BASE, 80002).owner(), safe);
    }
}
