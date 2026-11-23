// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

/// @title MockDclCollection (TEST ONLY, never deploy)
/// @notice A minimal look-alike of Decentraland's ERC721CollectionV2 for the giveaway chain client's anvil test
///         (LIV-194). The functions, the Issue event, the token id encoding and the revert strings match
///         decentraland/wearables-contracts' ERC721BaseCollectionV2.sol; everything else (rarities, managers, meta
///         transactions, ERC-721 transfers) is left out. setApproved and addItem are simplified test helpers.
/// Requires in loops are kept on purpose: they are the real contract's checks, in its order.
// forge-lint: disable-start(require-revert-in-loop)
contract MockDclCollection {
    struct Item {
        string rarity;
        uint256 maxSupply;
        uint256 totalSupply;
        uint256 price;
        address beneficiary;
        string metadata;
        string contentHash;
    }

    uint8 public constant ISSUED_ID_BITS = 216;

    address public creator;
    mapping(address => bool) public globalMinters;
    mapping(uint256 => mapping(address => uint256)) public itemMinters;
    Item[] public items;
    bool public isCompleted;
    bool public isApproved;
    mapping(uint256 => address) public ownerOf;

    event SetGlobalMinter(address indexed _minter, bool _value);
    event SetItemMinter(uint256 indexed _itemId, address indexed _minter, uint256 _value);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Issue(address indexed _beneficiary, uint256 indexed _tokenId, uint256 indexed _itemId, uint256 _issuedId, address _caller);

    constructor() {
        creator = msg.sender;
    }

    modifier onlyCreator() {
        require(msg.sender == creator, "onlyCreator: CALLER_IS_NOT_CREATOR");
        _;
    }

    function setMinters(address[] calldata _minters, bool[] calldata _values) external onlyCreator {
        require(_minters.length == _values.length, "setMinters: LENGTH_MISMATCH");
        for (uint256 i = 0; i < _minters.length; i++) {
            require(_minters[i] != address(0), "setMinters: INVALID_MINTER_ADDRESS");
            require(globalMinters[_minters[i]] != _values[i], "setMinters: VALUE_IS_THE_SAME");
            globalMinters[_minters[i]] = _values[i];
            emit SetGlobalMinter(_minters[i], _values[i]);
        }
    }

    function setItemsMinters(uint256[] calldata _itemIds, address[] calldata _minters, uint256[] calldata _values)
        external
        onlyCreator
    {
        require(
            _itemIds.length == _minters.length && _minters.length == _values.length, "setItemsMinters: LENGTH_MISMATCH"
        );
        for (uint256 i = 0; i < _minters.length; i++) {
            require(_minters[i] != address(0), "setItemsMinters: INVALID_MINTER_ADDRESS");
            require(_itemIds[i] < items.length, "setItemsMinters: ITEM_DOES_NOT_EXIST");
            require(itemMinters[_itemIds[i]][_minters[i]] != _values[i], "setItemsMinters: VALUE_IS_THE_SAME");
            itemMinters[_itemIds[i]][_minters[i]] = _values[i];
            emit SetItemMinter(_itemIds[i], _minters[i], _values[i]);
        }
    }

    /// @notice Test helper: sets the approval flag (the real one is the committee's).
    function setApproved(bool _value) external {
        isApproved = _value;
    }

    /// @notice Marks the collection complete (no more items), as the real completeCollection does.
    function completeCollection() external onlyCreator {
        require(!isCompleted, "completeCollection: COLLECTION_ALREADY_COMPLETED");
        isCompleted = true;
    }

    /// @notice Test helper: adds a "common" item with this max supply, even after completion.
    function addItem(uint256 _maxSupply) external onlyCreator returns (uint256 itemId) {
        itemId = items.length;
        items.push(Item("common", _maxSupply, 0, 0, address(0), "1:w:mock:mock:upper_body:BaseMale", ""));
    }

    function itemsCount() external view returns (uint256) {
        return items.length;
    }

    function isMintingAllowed() public view returns (bool) {
        return isCompleted && isApproved;
    }

    function issueTokens(address[] calldata _beneficiaries, uint256[] calldata _itemIds) external {
        require(isMintingAllowed(), "issueTokens: MINT_NOT_ALLOWED");
        require(_beneficiaries.length == _itemIds.length, "issueTokens: LENGTH_MISMATCH");
        for (uint256 i = 0; i < _itemIds.length; i++) {
            _issueToken(_beneficiaries[i], _itemIds[i], msg.sender);
        }
    }

    function _issueToken(address _beneficiary, uint256 _itemId, address _sender) internal {
        if (!(_sender == creator || globalMinters[_sender])) {
            uint256 allowance = itemMinters[_itemId][_sender];
            require(allowance > 0, "_issueToken: CALLER_CAN_NOT_MINT");
            if (allowance != type(uint256).max) {
                itemMinters[_itemId][_sender]--;
            }
        }
        require(_itemId < items.length, "_issueToken: ITEM_DOES_NOT_EXIST");
        Item storage item = items[_itemId];
        uint256 currentIssuance = item.totalSupply + 1;
        require(currentIssuance <= item.maxSupply, "_issueToken: ITEM_EXHAUSTED");
        uint256 tokenId = (_itemId << ISSUED_ID_BITS) | currentIssuance;
        item.totalSupply = currentIssuance;
        ownerOf[tokenId] = _beneficiary;
        emit Transfer(address(0), _beneficiary, tokenId);
        emit Issue(_beneficiary, tokenId, _itemId, currentIssuance, _sender);
    }
}
// forge-lint: disable-end(require-revert-in-loop)
