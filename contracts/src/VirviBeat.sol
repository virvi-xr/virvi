// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Burnable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Burnable.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC6454} from "./interfaces/IERC6454.sol";

/// @title VirviBeat
/// @notice Free attendance tokens (BEATs) for Virvi events. Each BEAT is a token number (id). The minter
/// sends a given BEAT to a wallet at most once, ever. A BEAT created as non-tradeable can't be moved to
/// another wallet; only its holder can burn it. A closed BEAT can never be minted again.
/// @notice The admin (one wallet, handed over only in two steps with a 1-day wait) can add or remove
/// minters, including itself, and can change where names and images are looked up. Nobody can move, burn
/// or take back a BEAT already in someone's wallet.
contract VirviBeat is ERC1155, ERC1155Burnable, AccessControlDefaultAdminRules, IERC6454 {
    /// @notice The role allowed to create, mint and close BEATs.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice The most addresses one `mintTo` call accepts.
    uint256 public constant MAX_BATCH = 200;

    /// @notice Gas given to each mint to a recipient that has code, including its receiver hook.
    uint256 public constant RECEIVER_GAS = 120_000;

    /// @notice Gas required on top of the capped call (beyond the 1/64 the EVM keeps back) before a guarded
    /// mint starts: it pays for the catch path, the `MintSkipped` log, the loop step and returning, even when
    /// the receiver uses its whole cap. The catch path needs a few thousand; 10k leaves margin and costs
    /// nothing, because it is only checked, not spent.
    uint256 public constant GUARD_RESERVE = 10_000;

    /// @notice How long the admin role takes to hand over.
    uint48 public constant ADMIN_DELAY = 1 days;

    /// @notice Collection name shown by explorers and wallets.
    string public constant name = "Virvi BEAT";

    /// @notice Collection symbol shown by explorers and wallets.
    string public constant symbol = "BEAT";

    /// @notice Whether a BEAT id has been created.
    mapping(uint256 id => bool) public exists;

    /// @notice Whether a BEAT id can be transferred. Fixed when the BEAT is created.
    mapping(uint256 id => bool) public tradeable;

    /// @notice Whether a BEAT id is closed. Closed BEATs can never be minted again.
    mapping(uint256 id => bool) public closed;

    /// @notice Whether an address has ever been minted this BEAT. Stays true after a burn or transfer.
    mapping(uint256 id => mapping(address account => bool)) public minted;

    /// @notice How many addresses have been minted this BEAT.
    mapping(uint256 id => uint256) public mintedCount;

    error ZeroAddress();
    error SameAdminAndMinter();
    error BadBaseURI();
    error ZeroId();
    error BeatExists(uint256 id);
    error UnknownBeat(uint256 id);
    error BeatClosedError(uint256 id);
    error BatchTooLarge(uint256 n);
    error NotTradeable(uint256 id);
    error OnlyHolderCanBurn();
    error OnlySelf();
    error InsufficientGas();

    event BeatCreated(uint256 indexed id, bool tradeable);
    event BeatClosed(uint256 indexed id);
    event MintSkipped(uint256 indexed id, address indexed to);
    event BaseURISet(string baseURI);
    /// @dev ERC-7572.
    event ContractURIUpdated();
    /// @dev ERC-4906.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    /// @param admin Gets DEFAULT_ADMIN_ROLE (and is `owner()`). The deployer gets no role.
    /// @param minter Gets MINTER_ROLE. Must differ from `admin`.
    /// @param baseURI Metadata base, ending in "/"; `uri(id)` is `{baseURI}{id}.json`.
    constructor(address admin, address minter, string memory baseURI)
        ERC1155(baseURI)
        AccessControlDefaultAdminRules(ADMIN_DELAY, _nonZero(admin))
    {
        if (minter == address(0)) revert ZeroAddress();
        if (minter == admin) revert SameAdminAndMinter();
        _checkBase(baseURI);
        _grantRole(MINTER_ROLE, minter);
    }

    // ------------------------------------------------------------- minter

    /// @notice Creates a BEAT. The id must be above 0 and unused. Whether it can be traded is set now and
    /// can never change.
    function createBeat(uint256 id, bool isTradeable) external onlyRole(MINTER_ROLE) {
        if (id == 0) revert ZeroId();
        if (exists[id]) revert BeatExists(id);
        exists[id] = true;
        tradeable[id] = isTradeable;
        emit BeatCreated(id, isTradeable);
        // `uri` is this contract's own view, not an external call.
        // forge-lint: disable-next-line(reentrancy-events)
        emit URI(uri(id), id);
    }

    /// @notice Closes a BEAT for good: it can never be minted again. Tokens already out are untouched.
    /// Callable by a minter or the admin.
    function closeBeat(uint256 id) external {
        address sender = _msgSender();
        if (!hasRole(MINTER_ROLE, sender) && !hasRole(DEFAULT_ADMIN_ROLE, sender)) {
            revert AccessControlUnauthorizedAccount(sender, MINTER_ROLE);
        }
        if (!exists[id]) revert UnknownBeat(id);
        if (closed[id]) revert BeatClosedError(id);
        closed[id] = true;
        emit BeatClosed(id);
    }

    /// @notice Mints one of `id` to each address in `to`. The empty address (0x0) and any address already
    /// minted this BEAT, including repeats in the same list, are skipped, so a retry never gives anyone a
    /// second one.
    /// @dev A recipient with code (a contract, or an EIP-7702 delegated wallet) is minted through a
    /// self-call capped at RECEIVER_GAS. If its receiver hook fails, it is skipped with `MintSkipped`, stays
    /// un-minted so a later retry can succeed, and the rest of the batch still mints. If too little gas is
    /// left to give that call its full cap, the whole call reverts with `InsufficientGas`.
    /// @return newlyMinted How many addresses this call minted.
    function mintTo(uint256 id, address[] calldata to)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 newlyMinted)
    {
        if (!exists[id]) revert UnknownBeat(id);
        if (closed[id]) revert BeatClosedError(id);
        uint256 n = to.length;
        if (n == 0 || n > MAX_BATCH) revert BatchTooLarge(n);

        for (uint256 i = 0; i < n; ++i) {
            address account = to[i];
            if (account == address(0) || minted[id][account]) continue;
            if (account.code.length == 0) {
                _recordAndMint(id, account);
                ++newlyMinted;
            } else {
                // The call must get its full RECEIVER_GAS (the 63/64 rule hands on less when gas is short).
                // A receiver starved of gas would otherwise be skipped while the transaction still succeeds,
                // and gas estimation would settle on exactly that. Reverting forces it to budget the cap.
                // forge-lint: disable-next-line(require-revert-in-loop)
                if (gasleft() < RECEIVER_GAS * 64 / 63 + GUARD_RESERVE) revert InsufficientGas();
                // The capped self-call is the isolation: one bad receiver can't fail or drain the batch.
                // forge-lint: disable-next-line(calls-loop)
                try this.mintOneGuarded{gas: RECEIVER_GAS}(id, account) {
                    ++newlyMinted;
                } catch {
                    // Reports the outcome of the call above, so it must come after it.
                    // forge-lint: disable-next-line(reentrancy-events)
                    emit MintSkipped(id, account);
                }
            }
        }
    }

    /// @notice Internal step of `mintTo`, external only so its gas can be capped. Only this contract can
    /// call it.
    function mintOneGuarded(uint256 id, address account) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _recordAndMint(id, account);
    }

    // -------------------------------------------------------------- admin

    /// @notice Admin only. Changes where the name and image of every BEAT are looked up, including BEATs
    /// already given out. Takes effect at once. Must end in "/".
    function setBaseURI(string calldata baseURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _checkBase(baseURI);
        _setURI(baseURI);
        emit BaseURISet(baseURI);
        emit ContractURIUpdated();
        emit BatchMetadataUpdate(1, type(uint256).max);
    }

    // ------------------------------------------------------------- holder

    /// @notice Burns your own BEATs. Only the holder can burn; approved operators can't.
    function burn(address account, uint256 id, uint256 value) public override {
        if (account != _msgSender()) revert OnlyHolderCanBurn();
        super.burn(account, id, value);
    }

    /// @notice Burns several of your own BEATs. Only the holder can burn; approved operators can't.
    function burnBatch(address account, uint256[] memory ids, uint256[] memory values) public override {
        if (account != _msgSender()) revert OnlyHolderCanBurn();
        super.burnBatch(account, ids, values);
    }

    // -------------------------------------------------------------- views

    /// @notice The web address of a BEAT's name and image: the base, the BEAT's number, then ".json".
    /// For example BEAT 7 with base "https://x.io/" gives "https://x.io/7.json".
    function uri(uint256 id) public view override returns (string memory) {
        return string.concat(super.uri(id), Strings.toString(id), ".json");
    }

    /// @notice ERC-7572 collection metadata: `{base}contract.json`.
    function contractURI() external view returns (string memory) {
        return string.concat(super.uri(0), "contract.json");
    }

    /// @notice ERC-6454. False only for a move between two wallets of a non-tradeable (or unknown) id.
    function isTransferable(uint256 id, address from, address to) external view returns (bool) {
        return from == address(0) || to == address(0) || tradeable[id];
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == type(IERC6454).interfaceId || interfaceId == bytes4(0x49064906)
            || super.supportsInterface(interfaceId);
    }

    // ----------------------------------------------------------- internal

    /// @dev Effects before the interaction: the flag and count are set before `_mint` calls any receiver
    /// hook, and a failed guarded mint rolls all three back together.
    function _recordAndMint(uint256 id, address account) private {
        minted[id][account] = true;
        ++mintedCount[id];
        _mint(account, id, 1, "");
    }

    /// @dev Runs on every mint, move and burn. Moving a non-tradeable BEAT between two wallets always
    /// fails. Minting (`from == 0`) and burning (`to == 0`) always pass.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; ++i) {
                // Reverting on the first locked id is the point: no transfer may include one.
                // forge-lint: disable-next-line(require-revert-in-loop)
                if (!tradeable[ids[i]]) revert NotTradeable(ids[i]);
            }
        }
        super._update(from, to, ids, values);
    }

    function _checkBase(string memory baseURI) private pure {
        bytes memory b = bytes(baseURI);
        if (b.length == 0 || b[b.length - 1] != "/") revert BadBaseURI();
    }

    function _nonZero(address account) private pure returns (address) {
        if (account == address(0)) revert ZeroAddress();
        return account;
    }
}
