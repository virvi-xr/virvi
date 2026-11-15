/**
 * Settings that make the configured BEAT chain usable (LIV-11): a contract on each chain and a minter key, so create and
 * checkout don't refuse with `not_configured`. The key is anvil's well-known dev key #0, never a real one.
 */
export const BEATS_READY = {
  contracts: { 'polygon-amoy': '0x00000000000000000000000000000000000b3a75', polygon: '0x00000000000000000000000000000000000b3a75' },
  minterKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
}
