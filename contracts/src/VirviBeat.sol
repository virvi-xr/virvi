// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Burnable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title VirviBeat
/// @notice Free attendance tokens (BEATs) for Virvi events. Each BEAT is a token id; each address can be
/// minted at most one of each id, ever. A BEAT created as non-tradeable can't be transferred, only burned
/// by its holder. The admin can manage the minter and the metadata base URI, and has no power over tokens.
contract VirviBeat is ERC1155, ERC1155Burnable, AccessControl {
    /// @notice The role allowed to create BEATs and mint them.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice The most addresses one `mintTo` call accepts.
    uint256 public constant MAX_BATCH = 200;

    /// @notice Whether a BEAT id has been created.
    mapping(uint256 id => bool) public exists;

    /// @notice Whether a BEAT id can be transferred. Fixed when the BEAT is created.
    mapping(uint256 id => bool) public tradeable;

    /// @notice Whether an address has ever been minted this BEAT. Stays true after a burn or transfer.
    mapping(uint256 id => mapping(address account => bool)) public minted;

    /// @notice How many addresses have been minted this BEAT.
    mapping(uint256 id => uint256) public mintedCount;

    error ZeroAddress();
    error ZeroId();
    error BeatExists(uint256 id);
    error UnknownBeat(uint256 id);
    error BatchTooLarge(uint256 n);
    error NotTradeable(uint256 id);

    event BeatCreated(uint256 indexed id, bool tradeable);
    event BaseURISet(string baseURI);

    /// @param admin Gets DEFAULT_ADMIN_ROLE. The deployer gets no role.
    /// @param minter Gets MINTER_ROLE.
    /// @param baseURI Metadata base; `uri(id)` is `{baseURI}{id}.json`.
    constructor(address admin, address minter, string memory baseURI) ERC1155(baseURI) {
        if (admin == address(0) || minter == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
    }

    /// @notice Registers a BEAT id once. `isTradeable` can never change afterwards.
    function createBeat(uint256 id, bool isTradeable) external onlyRole(MINTER_ROLE) {
        if (id == 0) revert ZeroId();
        if (exists[id]) revert BeatExists(id);
        exists[id] = true;
        tradeable[id] = isTradeable;
        emit BeatCreated(id, isTradeable);
    }

    /// @notice Mints one of `id` to each address in `to`, skipping address(0) and any address already minted
    /// this BEAT (including repeats in the same list), so a retry never gives anyone a second one.
    /// @dev A recipient contract that rejects ERC-1155 reverts the whole call.
    /// @return newlyMinted How many addresses were minted by this call.
    function mintTo(uint256 id, address[] calldata to)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 newlyMinted)
    {
        if (!exists[id]) revert UnknownBeat(id);
        uint256 n = to.length;
        if (n == 0 || n > MAX_BATCH) revert BatchTooLarge(n);

        for (uint256 i = 0; i < n; ++i) {
            address account = to[i];
            if (account == address(0) || minted[id][account]) continue;
            minted[id][account] = true;
            ++mintedCount[id];
            ++newlyMinted;
            _mint(account, id, 1, "");
        }
    }

    /// @notice Sets the metadata base URI.
    function setBaseURI(string calldata baseURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setURI(baseURI);
        emit BaseURISet(baseURI);
    }

    /// @notice `{base}{id}.json`.
    function uri(uint256 id) public view override returns (string memory) {
        return string.concat(super.uri(id), Strings.toString(id), ".json");
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /// @dev Blocks every transfer of a non-tradeable id. Mint (`from == 0`) and burn (`to == 0`) always pass.
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
}
