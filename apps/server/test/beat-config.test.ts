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
    // Per-chain defaults apply (beatMinGasWei, beatMaxFeeWei)
    expect(b.minGasWei).toBeNull()
    expect(b.maxFeeGwei).toBeNull()
    expect(b.rpcFailsBeforePause).toBe(10)
    expect(b.claimsPerIp).toBe(3)
    expect(b.newWalletsPerIpHour).toBe(10)
    expect(b.contractCommits).toEqual({ 'polygon-amoy': null, polygon: null })
    expect(b).not.toHaveProperty('metadataBase')
  })
  it('per-chain gas floor and fee ceiling defaults, and their settings', async () => {
    const { beatMinGasWei, beatMaxFeeWei } = await import('../src/beats/chain.js')
    const { config } = await import('../src/config.js')
    const prev = config.beats
    try {
      ;(config as any).beats = { ...prev, minGasWei: null, maxFeeGwei: null }
      expect(beatMinGasWei('polygon')).toBe(10n * 10n ** 18n)
      expect(beatMinGasWei('polygon-amoy')).toBe(10n ** 17n)
      expect(beatMaxFeeWei('polygon')).toBe(1000n * 10n ** 9n)
      expect(beatMaxFeeWei('polygon-amoy')).toBe(300n * 10n ** 9n)
      ;(config as any).beats = { ...prev, minGasWei: 5n, maxFeeGwei: 7 }
      expect(beatMinGasWei('polygon')).toBe(5n)
      expect(beatMaxFeeWei('polygon-amoy')).toBe(7n * 10n ** 9n)
    } finally {
      ;(config as any).beats = prev
    }
    expect(beatSettingsFrom({ BEAT_MAX_FEE_GWEI: '1500', BEAT_RPC_FAILS_BEFORE_PAUSE: '4' })).toMatchObject({ maxFeeGwei: 1500, rpcFailsBeforePause: 4 })
    expect(() => beatSettingsFrom({ BEAT_MAX_FEE_GWEI: '0' })).toThrow('BEAT_MAX_FEE_GWEI')
    expect(beatSettingsFrom({ BEAT_CONTRACT_COMMIT_POLYGON_AMOY: '6637054d' }).contractCommits['polygon-amoy']).toBe('6637054d')
    expect(() => beatSettingsFrom({ BEAT_CONTRACT_COMMIT_POLYGON: 'main' })).toThrow('BEAT_CONTRACT_COMMIT_POLYGON')
  })

  it('M-1: per-chain gas floors and fee ceilings win over the global ones, which still apply to a chain without its own', async () => {
    const { beatMinGasWei, beatMaxFeeWei } = await import('../src/beats/chain.js')
    const { config } = await import('../src/config.js')
    const b = beatSettingsFrom({
      BEAT_MIN_GAS_POL: '1', BEAT_MAX_FEE_GWEI: '400',
      BEAT_MIN_GAS_POL_POLYGON: '20', BEAT_MIN_GAS_POL_POLYGON_AMOY: '0.2', BEAT_MAX_FEE_GWEI_POLYGON: '1500', BEAT_MAX_FEE_GWEI_POLYGON_AMOY: '250',
    })
    expect(b.minGasWeiByChain).toEqual({ polygon: 20n * 10n ** 18n, 'polygon-amoy': 2n * 10n ** 17n })
    expect(b.maxFeeGweiByChain).toEqual({ polygon: 1500, 'polygon-amoy': 250 })
    const prev = config.beats
    try {
      ;(config as any).beats = { ...prev, ...b }
      expect(beatMinGasWei('polygon')).toBe(20n * 10n ** 18n)
      expect(beatMinGasWei('polygon-amoy')).toBe(2n * 10n ** 17n)
      expect(beatMaxFeeWei('polygon')).toBe(1500n * 10n ** 9n)
      expect(beatMaxFeeWei('polygon-amoy')).toBe(250n * 10n ** 9n)
      ;(config as any).beats = { ...prev, ...beatSettingsFrom({ BEAT_MIN_GAS_POL: '1', BEAT_MAX_FEE_GWEI: '400', BEAT_MIN_GAS_POL_POLYGON_AMOY: '0.2' }) }
      expect(beatMinGasWei('polygon')).toBe(10n ** 18n)
      expect(beatMinGasWei('polygon-amoy')).toBe(2n * 10n ** 17n)
      expect(beatMaxFeeWei('polygon')).toBe(400n * 10n ** 9n)
    } finally {
      ;(config as any).beats = prev
    }
    expect(() => beatSettingsFrom({ BEAT_MIN_GAS_POL_POLYGON: 'lots' })).toThrow('BEAT_MIN_GAS_POL_POLYGON')
    expect(() => beatSettingsFrom({ BEAT_MAX_FEE_GWEI_POLYGON_AMOY: '0' })).toThrow('BEAT_MAX_FEE_GWEI_POLYGON_AMOY')
  })

  it("M-2: a Safe address pasted from the Safe app with its chain prefix (matic:, pol:) is read without it", () => {
    const safe = getAddress(ADDR)
    expect(beatSettingsFrom({ BEAT_ADMIN_SAFE_POLYGON: `matic:${safe}`, BEAT_ADMIN_SAFE_POLYGON_AMOY: `pol:${safe}` }).adminSafes)
      .toEqual({ polygon: safe, 'polygon-amoy': safe })
    expect(beatSettingsFrom({ BEAT_ADMIN_SAFE_POLYGON: ` ${safe} ` }).adminSafes.polygon).toBe(safe)
    expect(() => beatSettingsFrom({ BEAT_ADMIN_SAFE_POLYGON: 'matic:0x01D871870cbbdde934526e17637c0cfef0b3b38b' })).toThrow('BEAT_ADMIN_SAFE_POLYGON')
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
