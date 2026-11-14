// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {VirviBeat} from "../src/VirviBeat.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// A contract that does not implement onERC1155Received, so it can't take a BEAT.
contract NoReceiver {}

contract VirviBeatTest is Test {
    string internal constant BASE = "https://api.virvi.io/api/beats/metadata/polygon-amoy/";

    address internal admin = makeAddr("admin");
    address internal minter = makeAddr("minter");
    address internal deployer = makeAddr("deployer");
    address internal stranger = makeAddr("stranger");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant LOCKED = 1;
    uint256 internal constant OPEN = 2;

    VirviBeat internal beat;

    function setUp() public {
        vm.prank(deployer);
        beat = new VirviBeat(admin, minter, BASE);
        vm.startPrank(minter);
        beat.createBeat(LOCKED, false);
        beat.createBeat(OPEN, true);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _list(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _list(address a, address b) internal pure returns (address[] memory l) {
        l = new address[](2);
        l[0] = a;
        l[1] = b;
    }

    function _distinct(uint256 n, uint256 offset) internal pure returns (address[] memory l) {
        l = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            l[i] = address(uint160(0x10000 + offset + i));
        }
    }

    function _mintOne(uint256 id, address to) internal {
        vm.prank(minter);
        beat.mintTo(id, _list(to));
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role);
    }

    // ----------------------------------------------------------------- deploy

    function test_Deploy_RolesGoToAdminAndMinterOnly() public view {
        bytes32 adminRole = beat.DEFAULT_ADMIN_ROLE();
        bytes32 minterRole = beat.MINTER_ROLE();
        assertEq(minterRole, keccak256("MINTER_ROLE"));
        assertTrue(beat.hasRole(adminRole, admin));
        assertTrue(beat.hasRole(minterRole, minter));
        assertFalse(beat.hasRole(adminRole, minter));
        assertFalse(beat.hasRole(minterRole, admin));
        assertFalse(beat.hasRole(adminRole, deployer));
        assertFalse(beat.hasRole(minterRole, deployer));
    }

    function test_Deploy_RevertsOnZeroAdmin() public {
        vm.expectRevert(VirviBeat.ZeroAddress.selector);
        new VirviBeat(address(0), minter, BASE);
    }

    function test_Deploy_RevertsOnZeroMinter() public {
        vm.expectRevert(VirviBeat.ZeroAddress.selector);
        new VirviBeat(admin, address(0), BASE);
    }

    function test_Deploy_MaxBatchIs200() public view {
        assertEq(beat.MAX_BATCH(), 200);
    }

    // ------------------------------------------------------------------ roles

    function test_Roles_NonMinterCannotCreateBeat() public {
        vm.expectRevert(_unauthorized(stranger, beat.MINTER_ROLE()));
        vm.prank(stranger);
        beat.createBeat(99, false);
    }

    function test_Roles_NonMinterCannotMint() public {
        vm.expectRevert(_unauthorized(stranger, beat.MINTER_ROLE()));
        vm.prank(stranger);
        beat.mintTo(LOCKED, _list(alice));
    }

    function test_Roles_AdminCannotMintUntilGranted() public {
        bytes32 minterRole = beat.MINTER_ROLE();
        vm.expectRevert(_unauthorized(admin, minterRole));
        vm.prank(admin);
        beat.mintTo(LOCKED, _list(alice));

        vm.prank(admin);
        beat.grantRole(minterRole, admin);
        vm.prank(admin);
        assertEq(beat.mintTo(LOCKED, _list(alice)), 1);
        assertEq(beat.balanceOf(alice, LOCKED), 1);
    }

    function test_Roles_NonAdminCannotSetBaseURI() public {
        vm.expectRevert(_unauthorized(minter, beat.DEFAULT_ADMIN_ROLE()));
        vm.prank(minter);
        beat.setBaseURI("https://evil.example/");
    }

    function test_Roles_RevokedMinterCannotMint() public {
        bytes32 minterRole = beat.MINTER_ROLE();
        vm.prank(admin);
        beat.revokeRole(minterRole, minter);

        vm.expectRevert(_unauthorized(minter, minterRole));
        vm.prank(minter);
        beat.mintTo(LOCKED, _list(alice));
    }

    // ------------------------------------------------------------- createBeat

    function test_CreateBeat_TwiceReverts() public {
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.BeatExists.selector, LOCKED));
        vm.prank(minter);
        beat.createBeat(LOCKED, true);
        assertFalse(beat.tradeable(LOCKED), "tradeable must never change");
    }

    function test_CreateBeat_ZeroIdReverts() public {
        vm.expectRevert(VirviBeat.ZeroId.selector);
        vm.prank(minter);
        beat.createBeat(0, false);
    }

    function test_CreateBeat_StoresTradeableAndEmits() public {
        vm.expectEmit(true, false, false, true, address(beat));
        emit VirviBeat.BeatCreated(7, true);
        vm.prank(minter);
        beat.createBeat(7, true);

        assertTrue(beat.exists(7));
        assertTrue(beat.tradeable(7));
        assertTrue(beat.exists(LOCKED));
        assertFalse(beat.tradeable(LOCKED));
        assertFalse(beat.exists(8));
    }

    // ----------------------------------------------------------------- mintTo

    function test_MintTo_UnknownBeatReverts() public {
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.UnknownBeat.selector, 999));
        vm.prank(minter);
        beat.mintTo(999, _list(alice));
    }

    function test_MintTo_201AddressesReverts() public {
        address[] memory to = _distinct(201, 0);
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.BatchTooLarge.selector, 201));
        vm.prank(minter);
        beat.mintTo(LOCKED, to);
    }

    function test_MintTo_EmptyListReverts() public {
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.BatchTooLarge.selector, 0));
        vm.prank(minter);
        beat.mintTo(LOCKED, new address[](0));
    }

    function test_MintTo_SkipsDuplicatesAndZeroThenRetriesAreNoOps() public {
        address[] memory to = new address[](4);
        to[0] = alice;
        to[1] = alice;
        to[2] = bob;
        to[3] = address(0);

        vm.prank(minter);
        assertEq(beat.mintTo(LOCKED, to), 2);
        assertEq(beat.balanceOf(alice, LOCKED), 1);
        assertEq(beat.balanceOf(bob, LOCKED), 1);
        assertTrue(beat.minted(LOCKED, alice));
        assertTrue(beat.minted(LOCKED, bob));
        assertFalse(beat.minted(LOCKED, address(0)));

        vm.prank(minter);
        assertEq(beat.mintTo(LOCKED, _list(alice, bob)), 0);
        assertEq(beat.balanceOf(alice, LOCKED), 1);
        assertEq(beat.balanceOf(bob, LOCKED), 1);
        assertEq(beat.mintedCount(LOCKED), 2);
        assertEq(beat.mintedCount(OPEN), 0);
    }

    function test_MintTo_200DistinctAddressesSucceed() public {
        address[] memory to = _distinct(200, 0);
        vm.prank(minter);
        assertEq(beat.mintTo(LOCKED, to), 200);
        assertEq(beat.mintedCount(LOCKED), 200);
        assertEq(beat.balanceOf(to[0], LOCKED), 1);
        assertEq(beat.balanceOf(to[199], LOCKED), 1);
    }

    // -------------------------------------------------------------- transfers

    function test_Transfer_NonTradeableSingleReverts() public {
        _mintOne(LOCKED, alice);
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NotTradeable.selector, LOCKED));
        vm.prank(alice);
        beat.safeTransferFrom(alice, bob, LOCKED, 1, "");
    }

    function test_Transfer_NonTradeableBatchReverts() public {
        _mintOne(LOCKED, alice);
        _mintOne(OPEN, alice);
        uint256[] memory ids = new uint256[](2);
        ids[0] = OPEN;
        ids[1] = LOCKED;
        uint256[] memory values = new uint256[](2);
        values[0] = 1;
        values[1] = 1;

        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NotTradeable.selector, LOCKED));
        vm.prank(alice);
        beat.safeBatchTransferFrom(alice, bob, ids, values, "");
        assertEq(beat.balanceOf(alice, OPEN), 1);
    }

    function test_Transfer_ApprovedOperatorCannotMoveNonTradeable() public {
        _mintOne(LOCKED, alice);
        vm.prank(alice);
        beat.setApprovalForAll(stranger, true);

        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NotTradeable.selector, LOCKED));
        vm.prank(stranger);
        beat.safeTransferFrom(alice, bob, LOCKED, 1, "");
        assertEq(beat.balanceOf(alice, LOCKED), 1);
    }

    function test_Transfer_TradeableWorks() public {
        _mintOne(OPEN, alice);
        vm.prank(alice);
        beat.safeTransferFrom(alice, bob, OPEN, 1, "");
        assertEq(beat.balanceOf(alice, OPEN), 0);
        assertEq(beat.balanceOf(bob, OPEN), 1);
    }

    // ------------------------------------------------------------------- burn

    function test_Burn_HolderCanBurnNonTradeableAndNeverGetsAnother() public {
        _mintOne(LOCKED, alice);
        vm.prank(alice);
        beat.burn(alice, LOCKED, 1);
        assertEq(beat.balanceOf(alice, LOCKED), 0);

        vm.prank(minter);
        assertEq(beat.mintTo(LOCKED, _list(alice)), 0);
        assertEq(beat.balanceOf(alice, LOCKED), 0);
        assertEq(beat.mintedCount(LOCKED), 1);
    }

    function test_Burn_StrangerCannotBurnSomeoneElsesToken() public {
        _mintOne(LOCKED, alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC1155Errors.ERC1155MissingApprovalForAll.selector, stranger, alice)
        );
        vm.prank(stranger);
        beat.burn(alice, LOCKED, 1);
    }

    // --------------------------------------------------------------- receiver

    /// One recipient that can't accept ERC-1155 reverts the whole batch, so nobody in it is minted.
    function test_Receiver_ContractWithoutHookRevertsWholeCall() public {
        address bad = address(new NoReceiver());
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, bad));
        vm.prank(minter);
        beat.mintTo(LOCKED, _list(alice, bad));

        assertEq(beat.balanceOf(alice, LOCKED), 0);
        assertFalse(beat.minted(LOCKED, alice));
        assertEq(beat.mintedCount(LOCKED), 0);
    }

    // -------------------------------------------------------------------- uri

    function test_Uri_IsBasePlusIdJson() public view {
        assertEq(beat.uri(42), string.concat(BASE, "42.json"));
    }

    function test_Uri_AdminCanChangeBase() public {
        string memory next = "https://api.virvi.io/api/beats/metadata/polygon/";
        vm.expectEmit(false, false, false, true, address(beat));
        emit VirviBeat.BaseURISet(next);
        vm.prank(admin);
        beat.setBaseURI(next);
        assertEq(beat.uri(42), string.concat(next, "42.json"));
    }

    // --------------------------------------------------------------- no funds

    function test_NoFunds_PlainValueTransferReverts() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(beat).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(beat).balance, 0);
    }

    function test_NoFunds_ValueWithFunctionCallReverts() public {
        vm.deal(minter, 1 ether);
        vm.prank(minter);
        (bool ok,) = address(beat).call{value: 1}(abi.encodeCall(VirviBeat.mintTo, (LOCKED, _list(alice))));
        assertFalse(ok);
        assertEq(address(beat).balance, 0);
    }

    // ------------------------------------------------------------------ fuzz

    /// Builds up to 200 addresses drawn from a small pool (so duplicates are common), with address(0) in the pool.
    function _fuzzList(uint256 seed, uint256 len) internal pure returns (address[] memory to) {
        to = new address[](len);
        for (uint256 i = 0; i < len; i++) {
            uint256 pick = uint256(keccak256(abi.encode(seed, i))) % 64;
            to[i] = pick == 0 ? address(0) : address(uint160(0x10000 + pick));
        }
    }

    function testFuzz_MintTo_EveryoneGetsExactlyOne(uint256 seed, uint256 len) public {
        len = _bound(len, 1, 200);
        address[] memory to = _fuzzList(seed, len);

        uint256 distinct;
        for (uint256 i = 0; i < len; i++) {
            if (to[i] == address(0)) continue;
            bool seen;
            for (uint256 j = 0; j < i; j++) {
                if (to[j] == to[i]) {
                    seen = true;
                    break;
                }
            }
            if (!seen) distinct++;
        }

        vm.prank(minter);
        uint256 minted = beat.mintTo(LOCKED, to);

        assertEq(minted, distinct);
        assertEq(beat.mintedCount(LOCKED), distinct);
        for (uint256 i = 0; i < len; i++) {
            if (to[i] != address(0)) assertEq(beat.balanceOf(to[i], LOCKED), 1);
        }

        // A second send of the same list mints nobody.
        vm.prank(minter);
        assertEq(beat.mintTo(LOCKED, to), 0);
        assertEq(beat.mintedCount(LOCKED), distinct);
    }

    function testFuzz_Transfer_NonTradeableAlwaysReverts(address holder, address recipient) public {
        vm.assume(holder != address(0) && recipient != address(0));
        vm.assume(holder.code.length == 0 && uint160(holder) > 0xffff);
        assumeNotForgeAddress(holder);
        _mintOne(LOCKED, holder);

        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NotTradeable.selector, LOCKED));
        vm.prank(holder);
        beat.safeTransferFrom(holder, recipient, LOCKED, 1, "");
        assertEq(beat.balanceOf(holder, LOCKED), 1);
    }

    // ----------------------------------------------------------------- script

    function test_DeployScript_GrantsRolesFromEnv() public {
        vm.setEnv("BEAT_ADMIN", vm.toString(admin));
        vm.setEnv("BEAT_MINTER", vm.toString(minter));
        vm.setEnv("BEAT_BASE_URI", BASE);

        VirviBeat deployed = new Deploy().run();

        assertTrue(deployed.hasRole(deployed.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(deployed.hasRole(deployed.MINTER_ROLE(), minter));
        assertFalse(deployed.hasRole(deployed.DEFAULT_ADMIN_ROLE(), address(this)));
        assertFalse(deployed.hasRole(deployed.MINTER_ROLE(), address(this)));
        assertEq(deployed.uri(1), string.concat(BASE, "1.json"));
    }
}
