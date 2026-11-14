// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

/// @title ERC-6454: Minimalistic Non-Transferable interface (interface id 0x91a6262f)
interface IERC6454 {
    /// @notice Whether `tokenId` can move from `from` to `to`. `from == 0` is a mint, `to == 0` a burn.
    function isTransferable(uint256 tokenId, address from, address to) external view returns (bool);
}
