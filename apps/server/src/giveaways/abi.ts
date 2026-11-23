/** The parts of Decentraland's collection contract (ERC721CollectionV2, decentraland/wearables-contracts) the giveaway
 * client uses, as ethers human-readable fragments (LIV-194). test/giveaway-chain-anvil.test.ts checks these are a subset
 * of the test look-alike's artifact (contracts/src/test/MockDclCollection.sol), whose signatures match the real one. */
export const DCL_COLLECTION_ABI = [
  'function creator() view returns (address)',
  'function isApproved() view returns (bool)',
  'function isCompleted() view returns (bool)',
  'function globalMinters(address) view returns (bool)',
  'function itemMinters(uint256, address) view returns (uint256)',
  'function items(uint256) view returns (string rarity, uint256 maxSupply, uint256 totalSupply, uint256 price, address beneficiary, string metadata, string contentHash)',
  'function itemsCount() view returns (uint256)',
  'function issueTokens(address[] _beneficiaries, uint256[] _itemIds)',
  'function setMinters(address[] _minters, bool[] _values)',
  'function setItemsMinters(uint256[] _itemIds, address[] _minters, uint256[] _values)',
  'event Issue(address indexed _beneficiary, uint256 indexed _tokenId, uint256 indexed _itemId, uint256 _issuedId, address _caller)',
] as const
