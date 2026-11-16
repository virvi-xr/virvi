// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IAccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155MetadataURI} from "@openzeppelin/contracts/token/ERC1155/extensions/IERC1155MetadataURI.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {VirviBeat} from "../src/VirviBeat.sol";
import {IERC6454} from "../src/interfaces/IERC6454.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// A contract that does not implement onERC1155Received, so it can't take a BEAT.
contract NoReceiver {}

/// Accepts BEATs only once switched on, so a skipped mint can be retried after it's fixed.
contract SwitchableReceiver is ERC1155Holder {
    bool public accepting;

    function setAccepting(bool on) external {
        accepting = on;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes memory)
        public
        view
        override
        returns (bytes4)
    {
        require(accepting, "not accepting");
        return this.onERC1155Received.selector;
    }
}

/// Burns every bit of gas it is given.
contract GasBurner {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        while (true) {}
        return this.onERC1155Received.selector;
    }
}

/// A plain contract wallet built on OpenZeppelin's ERC1155Holder.
contract HolderWallet is ERC1155Holder {}

/// A legitimate wallet whose receiver hook needs about 30k gas, then accepts.
contract NeedyReceiver is ERC1155Holder {
    function onERC1155Received(address, address, uint256, uint256, bytes memory)
        public
        view
        override
        returns (bytes4)
    {
        uint256 start = gasleft();
        while (start - gasleft() < 30_000) {}
        return this.onERC1155Received.selector;
    }
}

/// Stand-in for Safe's CompatibilityFallbackHandler: answers the ERC-1155 receiver hook.
contract SafeFallbackHandler is ERC1155Holder {}

/// Stand-in for the Safe singleton: unknown calls go to the fallback handler with the caller appended,
/// the way Safe's FallbackManager does.
contract SafeSingleton {
    address internal immutable handler;

    constructor(address h) {
        handler = h;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        (bool ok, bytes memory ret) = handler.call(abi.encodePacked(msg.data, msg.sender));
        require(ok, "handler failed");
        return ret;
    }
}

/// Stand-in for a SafeProxy: delegatecalls everything to the singleton.
contract SafeProxy {
    address internal immutable singleton;

    constructor(address s) {
        singleton = s;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        (bool ok, bytes memory ret) = singleton.delegatecall(msg.data);
        require(ok, "singleton failed");
        return ret;
    }
}

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

    function test_Deploy_ReissuerGoesToAdminOnly() public view {
        bytes32 reissuerRole = beat.REISSUER_ROLE();
        assertEq(reissuerRole, keccak256("REISSUER_ROLE"));
        assertTrue(beat.hasRole(reissuerRole, admin));
        assertFalse(beat.hasRole(reissuerRole, minter), "the minter must never hold reissuer");
        assertFalse(beat.hasRole(reissuerRole, deployer));
        assertEq(beat.getRoleAdmin(reissuerRole), beat.DEFAULT_ADMIN_ROLE());
    }

    function test_Deploy_RevertsOnZeroAdmin() public {
        vm.expectRevert(VirviBeat.ZeroAddress.selector);
        new VirviBeat(address(0), minter, BASE);
    }

    function test_Deploy_RevertsOnZeroMinter() public {
        vm.expectRevert(VirviBeat.ZeroAddress.selector);
        new VirviBeat(admin, address(0), BASE);
    }

    function test_Deploy_RevertsWhenAdminIsMinter() public {
        vm.expectRevert(VirviBeat.SameAdminAndMinter.selector);
        new VirviBeat(admin, admin, BASE);
    }

    function test_Deploy_RevertsOnBadBaseURI() public {
        vm.expectRevert(VirviBeat.BadBaseURI.selector);
        new VirviBeat(admin, minter, "https://api.virvi.io/api/beats/metadata/polygon");
        vm.expectRevert(VirviBeat.BadBaseURI.selector);
        new VirviBeat(admin, minter, "");
    }

    function test_Deploy_MaxBatchIs200() public view {
        assertEq(beat.MAX_BATCH(), 200);
    }

    function test_Deploy_NameSymbolAndOwner() public view {
        assertEq(beat.name(), "Virvi BEAT");
        assertEq(beat.symbol(), "BEAT");
        assertEq(beat.owner(), admin);
        assertEq(beat.defaultAdmin(), admin);
        assertEq(beat.defaultAdminDelay(), 1 days);
    }

    // ------------------------------------------------------------ admin rules

    function test_Admin_SecondAdminGrantReverts() public {
        bytes32 adminRole = beat.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector);
        vm.prank(admin);
        beat.grantRole(adminRole, stranger);
    }

    function test_Admin_HandoverIsTwoStepWithOneDayDelay() public {
        address next = makeAddr("nextAdmin");
        vm.prank(admin);
        beat.beginDefaultAdminTransfer(next);
        (address pending, uint48 schedule) = beat.pendingDefaultAdmin();
        assertEq(pending, next);
        assertEq(schedule, block.timestamp + 1 days);

        // Too early (the delay passes only after `schedule`): the old admin is still in charge.
        vm.warp(schedule);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, schedule)
        );
        vm.prank(next);
        beat.acceptDefaultAdminTransfer();
        assertEq(beat.owner(), admin);

        // Only the pending admin can accept.
        vm.warp(uint256(schedule) + 1);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, stranger)
        );
        vm.prank(stranger);
        beat.acceptDefaultAdminTransfer();

        vm.prank(next);
        beat.acceptDefaultAdminTransfer();
        assertEq(beat.owner(), next);
        assertTrue(beat.hasRole(beat.DEFAULT_ADMIN_ROLE(), next));
        assertFalse(beat.hasRole(beat.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_Admin_CannotRenounceWithoutScheduledTwoStep() public {
        bytes32 adminRole = beat.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, 0)
        );
        vm.prank(admin);
        beat.renounceRole(adminRole, admin);
        assertEq(beat.owner(), admin);
    }

    function test_Admin_MinterGrantAndRevokeAreInstant() public {
        bytes32 minterRole = beat.MINTER_ROLE();
        address second = makeAddr("secondMinter");
        vm.prank(admin);
        beat.grantRole(minterRole, second);
        assertTrue(beat.hasRole(minterRole, second));
        vm.prank(admin);
        beat.revokeRole(minterRole, second);
        assertFalse(beat.hasRole(minterRole, second));
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
        vm.expectEmit(true, false, false, true, address(beat));
        emit IERC1155.URI(string.concat(BASE, "7.json"), 7);
        vm.prank(minter);
        beat.createBeat(7, true);

        assertTrue(beat.exists(7));
        assertTrue(beat.tradeable(7));
        assertTrue(beat.exists(LOCKED));
        assertFalse(beat.tradeable(LOCKED));
        assertFalse(beat.exists(8));
    }

    // -------------------------------------------------------------- closeBeat

    function test_Close_MinterCanCloseAndMintingThenReverts() public {
        _mintOne(LOCKED, alice);
        vm.expectEmit(true, false, false, true, address(beat));
        emit VirviBeat.BeatClosed(LOCKED);
        vm.prank(minter);
        beat.closeBeat(LOCKED);
        assertTrue(beat.closed(LOCKED));
        assertFalse(beat.closed(OPEN));

        vm.expectRevert(abi.encodeWithSelector(VirviBeat.BeatClosedError.selector, LOCKED));
        vm.prank(minter);
        beat.mintTo(LOCKED, _list(bob));
        // Tokens already out are untouched.
        assertEq(beat.balanceOf(alice, LOCKED), 1);
    }

    function test_Close_AdminCanClose() public {
        vm.prank(admin);
        beat.closeBeat(OPEN);
        assertTrue(beat.closed(OPEN));
    }

    function test_Close_NonRoleCallerReverts() public {
        vm.expectRevert(_unauthorized(stranger, beat.MINTER_ROLE()));
        vm.prank(stranger);
        beat.closeBeat(LOCKED);
        assertFalse(beat.closed(LOCKED));
    }

    function test_Close_TwiceReverts() public {
        vm.prank(minter);
        beat.closeBeat(LOCKED);
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.BeatClosedError.selector, LOCKED));
        vm.prank(admin);
        beat.closeBeat(LOCKED);
    }

    function test_Close_UnknownBeatReverts() public {
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.UnknownBeat.selector, 999));
        vm.prank(minter);
        beat.closeBeat(999);
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

    function test_Transfer_TradeableSentAwayIsNeverReMintedToOriginalHolder() public {
        _mintOne(OPEN, alice);
        vm.prank(alice);
        beat.safeTransferFrom(alice, bob, OPEN, 1, "");

        vm.prank(minter);
        assertEq(beat.mintTo(OPEN, _list(alice)), 0);
        assertEq(beat.balanceOf(alice, OPEN), 0);
        assertEq(beat.mintedCount(OPEN), 1);
    }

    function test_IsTransferable_MatchesTransferRules() public view {
        assertFalse(beat.isTransferable(LOCKED, alice, bob));
        assertTrue(beat.isTransferable(LOCKED, address(0), bob), "mint");
        assertTrue(beat.isTransferable(LOCKED, alice, address(0)), "burn");
        assertTrue(beat.isTransferable(OPEN, alice, bob));
        assertFalse(beat.isTransferable(999, alice, bob), "unknown id");
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

    function test_Burn_HolderCanBurnBatch() public {
        _mintOne(LOCKED, alice);
        _mintOne(OPEN, alice);
        uint256[] memory ids = new uint256[](2);
        ids[0] = LOCKED;
        ids[1] = OPEN;
        uint256[] memory values = new uint256[](2);
        values[0] = 1;
        values[1] = 1;
        vm.prank(alice);
        beat.burnBatch(alice, ids, values);
        assertEq(beat.balanceOf(alice, LOCKED), 0);
        assertEq(beat.balanceOf(alice, OPEN), 0);
    }

    function test_Burn_StrangerCannotBurnSomeoneElsesToken() public {
        _mintOne(LOCKED, alice);
        vm.expectRevert(VirviBeat.OnlyHolderCanBurn.selector);
        vm.prank(stranger);
        beat.burn(alice, LOCKED, 1);
    }

    function test_Burn_ApprovedOperatorCannotBurn() public {
        _mintOne(LOCKED, alice);
        _mintOne(OPEN, alice);
        vm.prank(alice);
        beat.setApprovalForAll(stranger, true);

        vm.expectRevert(VirviBeat.OnlyHolderCanBurn.selector);
        vm.prank(stranger);
        beat.burn(alice, LOCKED, 1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = OPEN;
        uint256[] memory values = new uint256[](1);
        values[0] = 1;
        vm.expectRevert(VirviBeat.OnlyHolderCanBurn.selector);
        vm.prank(stranger);
        beat.burnBatch(alice, ids, values);

        assertEq(beat.balanceOf(alice, LOCKED), 1);
        assertEq(beat.balanceOf(alice, OPEN), 1);
    }

    // -------------------------------------------------------------- receivers

    /// A rejecting receiver and a gas burner in a batch with 3 EOAs: the EOAs mint, the two are skipped,
    /// the call succeeds and its gas stays bounded.
    function test_Receiver_BadReceiversAreSkippedNotFatal() public {
        address rejecter = address(new NoReceiver());
        address burner = address(new GasBurner());
        address carol = makeAddr("carol");
        address[] memory to = new address[](5);
        to[0] = alice;
        to[1] = rejecter;
        to[2] = bob;
        to[3] = burner;
        to[4] = carol;

        vm.expectEmit(true, true, false, true, address(beat));
        emit VirviBeat.MintSkipped(LOCKED, rejecter);
        vm.expectEmit(true, true, false, true, address(beat));
        emit VirviBeat.MintSkipped(LOCKED, burner);

        vm.prank(minter);
        uint256 gasBefore = gasleft();
        uint256 count = beat.mintTo{gas: 10_000_000}(LOCKED, to);
        uint256 used = gasBefore - gasleft();

        assertEq(count, 3);
        assertLt(used, 3_000_000, "gas must stay bounded");
        assertEq(beat.balanceOf(alice, LOCKED), 1);
        assertEq(beat.balanceOf(bob, LOCKED), 1);
        assertEq(beat.balanceOf(carol, LOCKED), 1);
        assertEq(beat.balanceOf(rejecter, LOCKED), 0);
        assertEq(beat.balanceOf(burner, LOCKED), 0);
        assertFalse(beat.minted(LOCKED, rejecter));
        assertFalse(beat.minted(LOCKED, burner));
        assertEq(beat.mintedCount(LOCKED), 3);
    }

    function test_Receiver_SkippedReceiverCanBeRetriedOnceFixed() public {
        SwitchableReceiver r = new SwitchableReceiver();
        vm.prank(minter);
        assertEq(beat.mintTo(LOCKED, _list(address(r))), 0);
        assertFalse(beat.minted(LOCKED, address(r)));
        assertEq(beat.mintedCount(LOCKED), 0);

        r.setAccepting(true);
        vm.prank(minter);
        assertEq(beat.mintTo(LOCKED, _list(address(r))), 1);
        assertEq(beat.balanceOf(address(r), LOCKED), 1);
        assertTrue(beat.minted(LOCKED, address(r)));
        assertEq(beat.mintedCount(LOCKED), 1);

        vm.prank(minter);
        assertEq(beat.mintTo(LOCKED, _list(address(r))), 0);
        assertEq(beat.balanceOf(address(r), LOCKED), 1);
    }

    function test_Receiver_SafeAndHolderFitUnderReceiverGas() public {
        address safe = address(new SafeProxy(address(new SafeSingleton(address(new SafeFallbackHandler())))));
        address holder = address(new HolderWallet());
        vm.prank(minter);
        assertEq(beat.mintTo(LOCKED, _list(safe, holder)), 2);
        assertEq(beat.balanceOf(safe, LOCKED), 1);
        assertEq(beat.balanceOf(holder, LOCKED), 1);
        assertEq(beat.RECEIVER_GAS(), 120_000);
    }

    /// Raises the call-gas limit until `mintTo` first succeeds. Below that, every attempt must revert: a
    /// starved good receiver must never be skipped (that is what gas estimation would land on).
    function _firstSucceedingLimit(address r, uint256 from, uint256 step) internal returns (uint256) {
        for (uint256 lim = from; lim < 1_000_000; lim += step) {
            vm.prank(minter);
            try beat.mintTo{gas: lim}(LOCKED, _list(r)) returns (uint256 count) {
                assertEq(count, 1, "a starved good receiver was skipped instead of reverting");
                return lim;
            } catch {}
        }
        revert("never succeeded");
    }

    function test_Receiver_StarvedGoodReceiverRevertsNeverSkipped() public {
        address r = address(new NeedyReceiver());
        uint256 snap = vm.snapshotState();
        uint256 coarse = _firstSucceedingLimit(r, 60_000, 100);
        vm.revertToState(snap);
        uint256 exact = _firstSucceedingLimit(r, coarse - 100, 1);
        vm.revertToState(snap);

        // Just under the threshold: the whole call reverts with InsufficientGas.
        vm.expectRevert(VirviBeat.InsufficientGas.selector);
        vm.prank(minter);
        beat.mintTo{gas: exact - 1}(LOCKED, _list(r));
        assertFalse(beat.minted(LOCKED, r));

        // Just over: it mints.
        vm.prank(minter);
        assertEq(beat.mintTo{gas: exact}(LOCKED, _list(r)), 1);
        assertEq(beat.balanceOf(r, LOCKED), 1);
    }

    function test_Receiver_MintOneGuardedIsSelfOnly() public {
        vm.expectRevert(VirviBeat.OnlySelf.selector);
        vm.prank(minter);
        beat.mintOneGuarded(LOCKED, alice);
        assertEq(beat.balanceOf(alice, LOCKED), 0);
    }

    // -------------------------------------------------------------------- uri

    function test_Uri_IsBasePlusIdJson() public view {
        assertEq(beat.uri(42), string.concat(BASE, "42.json"));
        assertEq(beat.contractURI(), string.concat(BASE, "contract.json"));
    }

    function test_Uri_AdminCanChangeBase() public {
        string memory next = "https://api.virvi.io/api/beats/metadata/polygon/";
        vm.expectEmit(false, false, false, true, address(beat));
        emit VirviBeat.BaseURISet(next);
        vm.expectEmit(false, false, false, true, address(beat));
        emit VirviBeat.ContractURIUpdated();
        vm.expectEmit(false, false, false, true, address(beat));
        emit VirviBeat.BatchMetadataUpdate(1, type(uint256).max);
        vm.prank(admin);
        beat.setBaseURI(next);
        assertEq(beat.uri(42), string.concat(next, "42.json"));
        assertEq(beat.contractURI(), string.concat(next, "contract.json"));
    }

    function test_Uri_BaseMustEndInSlash() public {
        vm.startPrank(admin);
        vm.expectRevert(VirviBeat.BadBaseURI.selector);
        beat.setBaseURI("https://api.virvi.io/api/beats/metadata/polygon");
        vm.expectRevert(VirviBeat.BadBaseURI.selector);
        beat.setBaseURI("");
        vm.stopPrank();
        assertEq(beat.uri(1), string.concat(BASE, "1.json"));
    }

    // ------------------------------------------------------------- interfaces

    function test_SupportsInterface() public view {
        assertEq(type(IERC6454).interfaceId, bytes4(0x91a6262f));
        assertTrue(beat.supportsInterface(type(IERC165).interfaceId), "ERC-165");
        assertTrue(beat.supportsInterface(type(IERC1155).interfaceId), "ERC-1155");
        assertTrue(beat.supportsInterface(type(IERC1155MetadataURI).interfaceId), "ERC-1155 metadata");
        assertTrue(beat.supportsInterface(type(IAccessControl).interfaceId), "AccessControl");
        assertTrue(
            beat.supportsInterface(type(IAccessControlDefaultAdminRules).interfaceId), "AccessControlDefaultAdminRules"
        );
        assertTrue(beat.supportsInterface(0x91a6262f), "ERC-6454");
        assertTrue(beat.supportsInterface(0x49064906), "ERC-4906");
        assertFalse(beat.supportsInterface(0xffffffff));
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

    // ---------------------------------------------------------------- reissue

    function _ids(uint256 a) internal pure returns (uint256[] memory l) {
        l = new uint256[](1);
        l[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory l) {
        l = new uint256[](2);
        l[0] = a;
        l[1] = b;
    }

    function _reissue(address from, address to, uint256[] memory ids) internal {
        vm.prank(admin);
        beat.reissue(from, to, ids);
    }

    function test_Reissue_MintsToFreshWalletEmitsAndRecords() public {
        _mintOne(LOCKED, alice);
        vm.expectEmit(true, true, true, true, address(beat));
        emit VirviBeat.Reissued(LOCKED, alice, bob);
        vm.expectEmit(true, true, true, true, address(beat));
        emit IERC1155.TransferSingle(admin, address(0), bob, LOCKED, 1);
        _reissue(alice, bob, _ids(LOCKED));

        assertEq(beat.balanceOf(bob, LOCKED), 1);
        assertEq(beat.balanceOf(alice, LOCKED), 1, "the old copy stays where it is");
        assertTrue(beat.minted(LOCKED, bob));
        assertEq(beat.replacedBy(LOCKED, alice), bob);
        assertEq(beat.replacedBy(LOCKED, bob), address(0));
        assertEq(beat.mintedCount(LOCKED), 2, "mintedCount counts every address ever minted");
    }

    function test_Reissue_WorksOnClosedBeat() public {
        _mintOne(LOCKED, alice);
        vm.prank(minter);
        beat.closeBeat(LOCKED);
        _reissue(alice, bob, _ids(LOCKED));
        assertEq(beat.balanceOf(bob, LOCKED), 1);
        assertTrue(beat.closed(LOCKED));

        // Closed still means no new mints for anyone else.
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.BeatClosedError.selector, LOCKED));
        vm.prank(minter);
        beat.mintTo(LOCKED, _list(stranger));
    }

    function test_Reissue_SeveralIdsInOneCall() public {
        _mintOne(LOCKED, alice);
        _mintOne(OPEN, alice);
        vm.expectEmit(true, true, true, true, address(beat));
        emit VirviBeat.Reissued(LOCKED, alice, bob);
        vm.expectEmit(true, true, true, true, address(beat));
        emit VirviBeat.Reissued(OPEN, alice, bob);
        _reissue(alice, bob, _ids(LOCKED, OPEN));
        assertEq(beat.balanceOf(bob, LOCKED), 1);
        assertEq(beat.balanceOf(bob, OPEN), 1);
        assertEq(beat.replacedBy(OPEN, alice), bob);
    }

    function test_Reissue_ToSafeStyleWallet() public {
        address safe = address(new SafeProxy(address(new SafeSingleton(address(new SafeFallbackHandler())))));
        _mintOne(LOCKED, alice);
        _reissue(alice, safe, _ids(LOCKED));
        assertEq(beat.balanceOf(safe, LOCKED), 1);
    }

    function test_Reissue_RecipientThatRejectsRevertsWholeCall() public {
        address rejecter = address(new NoReceiver());
        _mintOne(LOCKED, alice);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, rejecter));
        _reissue(alice, rejecter, _ids(LOCKED));
        assertEq(beat.replacedBy(LOCKED, alice), address(0));
        assertFalse(beat.minted(LOCKED, rejecter));
    }

    function test_Reissue_CallerWithoutRoleReverts() public {
        _mintOne(LOCKED, alice);
        bytes32 reissuerRole = beat.REISSUER_ROLE();

        vm.expectRevert(_unauthorized(minter, reissuerRole));
        vm.prank(minter);
        beat.reissue(alice, bob, _ids(LOCKED));

        vm.expectRevert(_unauthorized(stranger, reissuerRole));
        vm.prank(stranger);
        beat.reissue(alice, bob, _ids(LOCKED));

        // The holder can't do it for themselves either.
        vm.expectRevert(_unauthorized(alice, reissuerRole));
        vm.prank(alice);
        beat.reissue(alice, bob, _ids(LOCKED));

        vm.prank(admin);
        beat.revokeRole(reissuerRole, admin);
        vm.expectRevert(_unauthorized(admin, reissuerRole));
        vm.prank(admin);
        beat.reissue(alice, bob, _ids(LOCKED));

        assertEq(beat.balanceOf(bob, LOCKED), 0);
        assertEq(beat.replacedBy(LOCKED, alice), address(0));
    }

    function test_Reissue_AdminRenouncedRoleCanBeRegranted() public {
        bytes32 reissuerRole = beat.REISSUER_ROLE();
        vm.startPrank(admin);
        beat.renounceRole(reissuerRole, admin);
        assertFalse(beat.hasRole(reissuerRole, admin));
        beat.grantRole(reissuerRole, admin);
        vm.stopPrank();
        assertTrue(beat.hasRole(reissuerRole, admin));
    }

    function test_Reissue_AdminCanGrantAndRevokeReissuer() public {
        bytes32 reissuerRole = beat.REISSUER_ROLE();
        address support = makeAddr("support");
        _mintOne(LOCKED, alice);
        _mintOne(OPEN, alice);

        vm.prank(admin);
        beat.grantRole(reissuerRole, support);
        vm.prank(support);
        beat.reissue(alice, bob, _ids(LOCKED));
        assertEq(beat.balanceOf(bob, LOCKED), 1);

        vm.prank(admin);
        beat.revokeRole(reissuerRole, support);
        vm.expectRevert(_unauthorized(support, reissuerRole));
        vm.prank(support);
        beat.reissue(alice, bob, _ids(OPEN));
    }

    function test_Reissue_OnlyAdminCanGrantReissuer() public {
        bytes32 reissuerRole = beat.REISSUER_ROLE();
        vm.expectRevert(_unauthorized(minter, beat.DEFAULT_ADMIN_ROLE()));
        vm.prank(minter);
        beat.grantRole(reissuerRole, minter);
        assertFalse(beat.hasRole(reissuerRole, minter));
    }

    function test_Reissue_ContractAdminCanReissue() public {
        address safe = address(new SafeProxy(address(new SafeSingleton(address(new SafeFallbackHandler())))));
        VirviBeat b = new VirviBeat(safe, minter, BASE);
        vm.startPrank(minter);
        b.createBeat(LOCKED, false);
        b.mintTo(LOCKED, _list(alice));
        vm.stopPrank();
        assertTrue(b.hasRole(b.REISSUER_ROLE(), safe));
        vm.prank(safe);
        b.reissue(alice, bob, _ids(LOCKED));
        assertEq(b.balanceOf(bob, LOCKED), 1);
    }

    function test_Reissue_UnknownBeatReverts() public {
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.UnknownBeat.selector, 999));
        _reissue(alice, bob, _ids(999));
    }

    function test_Reissue_NotMintedToFromReverts() public {
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NotMintedTo.selector, LOCKED, alice));
        _reissue(alice, bob, _ids(LOCKED));
    }

    function test_Reissue_TradeableReceivedByTransferIsNotMintedTo() public {
        _mintOne(OPEN, alice);
        vm.prank(alice);
        beat.safeTransferFrom(alice, stranger, OPEN, 1, "");
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.NotMintedTo.selector, OPEN, stranger));
        _reissue(stranger, bob, _ids(OPEN));
    }

    function test_Reissue_ToAlreadyMintedReverts() public {
        _mintOne(LOCKED, alice);
        _mintOne(LOCKED, bob);
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.AlreadyMinted.selector, LOCKED, bob));
        _reissue(alice, bob, _ids(LOCKED));
    }

    function test_Reissue_SecondReissueFromSameWalletReverts() public {
        address carol = makeAddr("carol");
        _mintOne(LOCKED, alice);
        _reissue(alice, bob, _ids(LOCKED));
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.AlreadyReplaced.selector, LOCKED, alice));
        _reissue(alice, carol, _ids(LOCKED));
        assertEq(beat.balanceOf(carol, LOCKED), 0);
    }

    function test_Reissue_ChainOldToNewToNewer() public {
        address carol = makeAddr("carol");
        _mintOne(LOCKED, alice);
        _reissue(alice, bob, _ids(LOCKED));
        _reissue(bob, carol, _ids(LOCKED));
        assertEq(beat.replacedBy(LOCKED, alice), bob);
        assertEq(beat.replacedBy(LOCKED, bob), carol);
        assertEq(beat.replacedBy(LOCKED, carol), address(0));
        assertEq(beat.balanceOf(carol, LOCKED), 1);
        assertEq(beat.mintedCount(LOCKED), 3);

        // Back to the first wallet is never possible: it was minted already.
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.AlreadyMinted.selector, LOCKED, alice));
        _reissue(carol, alice, _ids(LOCKED));
    }

    function test_Reissue_SameFromAndToReverts() public {
        _mintOne(LOCKED, alice);
        vm.expectRevert(VirviBeat.SameFromAndTo.selector);
        _reissue(alice, alice, _ids(LOCKED));
    }

    function test_Reissue_ZeroAddressesRevert() public {
        _mintOne(LOCKED, alice);
        vm.expectRevert(VirviBeat.ZeroAddress.selector);
        _reissue(alice, address(0), _ids(LOCKED));
        vm.expectRevert(VirviBeat.ZeroAddress.selector);
        _reissue(address(0), bob, _ids(LOCKED));
    }

    function test_Reissue_BatchLimits() public {
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.BatchTooLarge.selector, 0));
        _reissue(alice, bob, new uint256[](0));

        uint256[] memory ids = new uint256[](201);
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.BatchTooLarge.selector, 201));
        _reissue(alice, bob, ids);
    }

    function test_Reissue_IsAllOrNothing() public {
        _mintOne(LOCKED, alice);
        _mintOne(OPEN, alice);
        _mintOne(OPEN, bob);
        // The first id is fine, the second is not: nothing happens.
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.AlreadyMinted.selector, OPEN, bob));
        _reissue(alice, bob, _ids(LOCKED, OPEN));
        assertEq(beat.balanceOf(bob, LOCKED), 0);
        assertFalse(beat.minted(LOCKED, bob));
        assertEq(beat.replacedBy(LOCKED, alice), address(0));
        assertEq(beat.mintedCount(LOCKED), 1);

        // A repeated id in one call fails on the repeat, and rolls back the first.
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.AlreadyReplaced.selector, LOCKED, alice));
        _reissue(alice, makeAddr("carol"), _ids(LOCKED, LOCKED));
        assertEq(beat.replacedBy(LOCKED, alice), address(0));
    }

    function test_Reissue_ReplacedTradeableCopyCannotMove() public {
        _mintOne(OPEN, alice);
        vm.prank(alice);
        beat.setApprovalForAll(stranger, true);
        _reissue(alice, bob, _ids(OPEN));

        vm.expectRevert(abi.encodeWithSelector(VirviBeat.ReplacedCopy.selector, OPEN, alice));
        vm.prank(alice);
        beat.safeTransferFrom(alice, stranger, OPEN, 1, "");

        vm.expectRevert(abi.encodeWithSelector(VirviBeat.ReplacedCopy.selector, OPEN, alice));
        vm.prank(stranger);
        beat.safeTransferFrom(alice, stranger, OPEN, 1, "");

        uint256[] memory values = new uint256[](1);
        values[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(VirviBeat.ReplacedCopy.selector, OPEN, alice));
        vm.prank(stranger);
        beat.safeBatchTransferFrom(alice, stranger, _ids(OPEN), values, "");

        assertEq(beat.balanceOf(alice, OPEN), 1);

        // The holder can still burn it.
        vm.prank(alice);
        beat.burn(alice, OPEN, 1);
        assertEq(beat.balanceOf(alice, OPEN), 0);
    }

    function test_Reissue_ReplacedCopyCanBeBurnedInBatch() public {
        _mintOne(OPEN, alice);
        _mintOne(LOCKED, alice);
        _reissue(alice, bob, _ids(OPEN, LOCKED));
        uint256[] memory values = new uint256[](2);
        values[0] = 1;
        values[1] = 1;
        vm.prank(alice);
        beat.burnBatch(alice, _ids(OPEN, LOCKED), values);
        assertEq(beat.balanceOf(alice, OPEN), 0);
        assertEq(beat.balanceOf(alice, LOCKED), 0);
    }

    function test_Reissue_NewCopyAndOtherCopiesOfTradeableStillTransfer() public {
        address carol = makeAddr("carol");
        _mintOne(OPEN, alice);
        _mintOne(OPEN, carol);
        _reissue(alice, bob, _ids(OPEN));

        vm.prank(bob);
        beat.safeTransferFrom(bob, stranger, OPEN, 1, "");
        assertEq(beat.balanceOf(stranger, OPEN), 1);

        vm.prank(carol);
        beat.safeTransferFrom(carol, stranger, OPEN, 1, "");
        assertEq(beat.balanceOf(stranger, OPEN), 2);
    }

    function test_Reissue_ReplacingOneIdLeavesOtherIdsOfSameWalletMovable() public {
        uint256 other = 3;
        vm.prank(minter);
        beat.createBeat(other, true);
        _mintOne(OPEN, alice);
        _mintOne(other, alice);
        _reissue(alice, bob, _ids(OPEN));
        vm.prank(alice);
        beat.safeTransferFrom(alice, stranger, other, 1, "");
        assertEq(beat.balanceOf(stranger, other), 1);
    }

    function test_Reissue_IsTransferableReflectsReplacement() public {
        _mintOne(OPEN, alice);
        assertTrue(beat.isTransferable(OPEN, alice, stranger));
        _reissue(alice, bob, _ids(OPEN));
        assertFalse(beat.isTransferable(OPEN, alice, stranger), "replaced copy");
        assertTrue(beat.isTransferable(OPEN, alice, address(0)), "burn still allowed");
        assertTrue(beat.isTransferable(OPEN, bob, stranger), "the new copy");
        assertFalse(beat.isTransferable(LOCKED, bob, stranger), "non-tradeable is unchanged");
    }

    function test_Reissue_SupportsInterfaceUnchanged() public view {
        // Same set as test_SupportsInterface: reissue adds no interface.
        assertTrue(beat.supportsInterface(type(IERC1155).interfaceId));
        assertTrue(beat.supportsInterface(type(IAccessControl).interfaceId));
        assertTrue(beat.supportsInterface(0x91a6262f));
        assertTrue(beat.supportsInterface(0x49064906));
        assertFalse(beat.supportsInterface(0xffffffff));
    }

    /// Creates `n` BEATs (ids 100..), mints each to alice, then measures reissuing all of them to bob.
    function _reissueGas(uint256 n) internal returns (uint256 used) {
        uint256[] memory ids = new uint256[](n);
        vm.startPrank(minter);
        for (uint256 i = 0; i < n; i++) {
            ids[i] = 100 + i;
            beat.createBeat(ids[i], i % 2 == 0);
            beat.mintTo(ids[i], _list(alice));
        }
        vm.stopPrank();
        vm.prank(admin);
        uint256 before = gasleft();
        beat.reissue(alice, bob, ids);
        used = before - gasleft();
        for (uint256 i = 0; i < n; i++) {
            assertEq(beat.balanceOf(bob, ids[i]), 1);
        }
    }

    function test_Reissue_Gas_1Id() public {
        uint256 used = _reissueGas(1);
        emit log_named_uint("reissue 1 id, gas", used);
        assertLt(used, 120_000);
    }

    function test_Reissue_Gas_10Ids() public {
        uint256 used = _reissueGas(10);
        emit log_named_uint("reissue 10 ids, gas", used);
        assertLt(used, 1_000_000);
    }

    function test_Reissue_Gas_50Ids() public {
        uint256 used = _reissueGas(50);
        emit log_named_uint("reissue 50 ids, gas", used);
        assertLt(used, 5_000_000);
    }

    /// A random sequence of mints and reissues over a small pool of wallets on a non-tradeable BEAT
    /// (so balances only change by minting): no wallet ever holds two, `minted` matches the balance, and
    /// `mintedCount` matches the number of wallets ever minted.
    function testFuzz_Reissue_NeverMintsTwiceToOneAddress(uint256 seed, uint8 steps) public {
        uint256 n = _bound(steps, 1, 60);
        address[] memory pool = new address[](8);
        for (uint256 i = 0; i < 8; i++) {
            pool[i] = address(uint160(0x20000 + i));
        }
        for (uint256 s = 0; s < n; s++) {
            uint256 r = uint256(keccak256(abi.encode(seed, s)));
            address a = pool[r % 8];
            address b = pool[(r >> 8) % 8];
            if ((r >> 16) % 3 == 0) {
                vm.prank(minter);
                try beat.mintTo(LOCKED, _list(a)) {} catch {} // reverts once closed
            } else {
                vm.prank(admin);
                try beat.reissue(a, b, _ids(LOCKED)) {} catch {}
            }
            if ((r >> 24) % 17 == 0) {
                vm.prank(admin);
                try beat.closeBeat(LOCKED) {} catch {}
            }
        }
        uint256 count;
        for (uint256 i = 0; i < 8; i++) {
            uint256 bal = beat.balanceOf(pool[i], LOCKED);
            assertLe(bal, 1, "one address minted twice");
            assertEq(bal == 1, beat.minted(LOCKED, pool[i]));
            if (beat.minted(LOCKED, pool[i])) count++;
            address next = beat.replacedBy(LOCKED, pool[i]);
            if (next != address(0)) assertTrue(beat.minted(LOCKED, next));
        }
        assertEq(beat.mintedCount(LOCKED), count);
    }

    // ----------------------------------------------------------------- script

    /// The only test that sets environment variables (they are process-wide, and tests run in parallel).
    function test_DeployScript_RunReadsEnvAndGrantsRoles() public {
        vm.setEnv("BEAT_ADMIN", vm.toString(admin));
        vm.setEnv("BEAT_MINTER", vm.toString(minter));
        vm.setEnv("BEAT_BASE_URI", BASE);
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));

        Deploy script = new Deploy();
        VirviBeat deployed = script.run();
        address broadcaster = script.broadcaster();

        vm.setEnv("BEAT_ADMIN", "");
        vm.setEnv("BEAT_MINTER", "");
        vm.setEnv("BEAT_BASE_URI", "");
        vm.setEnv("EXPECTED_CHAIN_ID", "");

        assertTrue(broadcaster != address(0));
        assertTrue(broadcaster != admin && broadcaster != minter);
        assertTrue(deployed.hasRole(deployed.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(deployed.owner(), admin);
        assertTrue(deployed.hasRole(deployed.MINTER_ROLE(), minter));
        assertFalse(deployed.hasRole(deployed.DEFAULT_ADMIN_ROLE(), broadcaster));
        assertFalse(deployed.hasRole(deployed.MINTER_ROLE(), broadcaster));
        assertTrue(deployed.hasRole(deployed.REISSUER_ROLE(), admin));
        assertFalse(deployed.hasRole(deployed.REISSUER_ROLE(), minter));
        assertFalse(deployed.hasRole(deployed.REISSUER_ROLE(), broadcaster));
        assertEq(deployed.uri(1), string.concat(BASE, "1.json"));
    }

    function test_DeployScript_AdminCanBeAContract() public {
        address safe = address(new SafeProxy(address(new SafeSingleton(address(new SafeFallbackHandler())))));
        Deploy script = new Deploy();
        VirviBeat deployed = script.deploy(safe, minter, BASE, block.chainid);
        assertEq(deployed.owner(), safe);
        assertTrue(deployed.hasRole(deployed.REISSUER_ROLE(), safe));
        assertFalse(deployed.hasRole(deployed.REISSUER_ROLE(), minter));
    }

    function test_DeployScript_RevertsOnWrongChain() public {
        Deploy script = new Deploy();
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, 137, block.chainid));
        script.deploy(admin, minter, BASE, 137);
    }

    function test_DeployScript_BaseURIMustMatchTheChain() public {
        Deploy script = new Deploy();
        vm.chainId(137);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongBaseURI.selector, "/polygon/"));
        script.deploy(admin, minter, BASE, 137);
        VirviBeat onPolygon = script.deploy(admin, minter, "https://api.virvi.io/api/beats/metadata/polygon/", 137);
        assertEq(onPolygon.uri(1), "https://api.virvi.io/api/beats/metadata/polygon/1.json");

        vm.chainId(80002);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongBaseURI.selector, "/polygon-amoy/"));
        script.deploy(admin, minter, "https://api.virvi.io/api/beats/metadata/polygon/", 80002);
        script.deploy(admin, minter, BASE, 80002);
    }

    function test_DeployScript_RevertsWhenAdminIsMinter() public {
        Deploy script = new Deploy();
        vm.expectRevert(Deploy.AdminIsMinter.selector);
        script.deploy(admin, admin, BASE, block.chainid);
    }
}
