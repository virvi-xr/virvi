import { describe, it, expect } from 'vitest'
import { Wallet, getAddress } from 'ethers'
import { beatSettingsFrom } from '../src/config.js'

const ADDR = '0x01d871870cbbdde934526e17637c0cfef0b3b38b'

describe('beatSettingsFrom', () => {
  it('has the defaults, and is off', () => {
    const b = beatSettingsFrom({})
    expect(b.enabled).toBe(false)
    expect(b.chain).toBe('polygon-amoy')
    expect(b.contracts).toEqual({})
    expect(b.minterKey).toBeNull()
    expect(b.rpc['polygon-amoy']).toBe('https://polygon-amoy-bor-rpc.publicnode.com')
    expect(b.rpc.polygon).toBe('https://polygon-bor-rpc.publicnode.com')
    expect(b.price).toEqual({ baseCents: 500, includedMints: 100, extraMintCents: 2 })
    expect(b.minGasWei).toBe(10n ** 18n)
    expect(b).not.toHaveProperty('metadataBase')
  })
  it('reads settings', () => {
    const key = Wallet.createRandom().privateKey
    const b = beatSettingsFrom({
      BEAT_ENABLED: 'true', BEAT_CHAIN: 'polygon', BEAT_CONTRACT_POLYGON_AMOY: ADDR, BEAT_MINTER_KEY: key,
      POLYGON_RPC_URL: 'https://rpc.example', BEAT_PRICE_BASE_CENTS: '700', BEAT_INCLUDED_MINTS: '50',
      BEAT_PRICE_EXTRA_MINT_CENTS: '3', BEAT_MIN_GAS_POL: '0.5',
    })
    expect(b.enabled).toBe(true)
    expect(b.chain).toBe('polygon')
    expect(b.contracts['polygon-amoy']).toBe(getAddress(ADDR))
    expect(b.minterKey).toBe(key)
    expect(b.rpc.polygon).toBe('https://rpc.example')
    expect(b.price).toEqual({ baseCents: 700, includedMints: 50, extraMintCents: 3 })
    expect(b.minGasWei).toBe(5n * 10n ** 17n)
  })
  it('refuses a base price of 0, which would make paid BEATs free', () => {
    expect(() => beatSettingsFrom({ BEAT_PRICE_BASE_CENTS: '0' })).toThrow('BEAT_PRICE_BASE_CENTS must be at least 50')
    expect(() => beatSettingsFrom({ BEAT_PRICE_BASE_CENTS: '49' })).toThrow('BEAT_PRICE_BASE_CENTS must be at least 50')
    expect(() => beatSettingsFrom({ BEAT_PRICE_BASE_CENTS: '-5' })).toThrow(/BEAT_PRICE_BASE_CENTS/)
    expect(beatSettingsFrom({ BEAT_PRICE_BASE_CENTS: '50' }).price.baseCents).toBe(50)
  })
  it('refuses a bad chain', () => {
    expect(() => beatSettingsFrom({ BEAT_CHAIN: 'ethereum' })).toThrow(/BEAT_CHAIN/)
  })
  it('refuses a bad contract address', () => {
    expect(() => beatSettingsFrom({ BEAT_CONTRACT_POLYGON: 'nope' })).toThrow(/BEAT_CONTRACT_POLYGON/)
    expect(() => beatSettingsFrom({ BEAT_CONTRACT_POLYGON_AMOY: '0x01d871870CbBddE934526E17637c0cfEf0b3b38b' })).toThrow(/BEAT_CONTRACT_POLYGON_AMOY/)
  })
  it('refuses a malformed minter key without echoing it', () => {
    const bad = 'not-a-key-SECRETVALUE'
    try { beatSettingsFrom({ BEAT_MINTER_KEY: bad }); throw new Error('did not throw') } catch (e) {
      expect((e as Error).message).toMatch(/BEAT_MINTER_KEY/)
      expect((e as Error).message).not.toContain('SECRETVALUE')
    }
  })
})
