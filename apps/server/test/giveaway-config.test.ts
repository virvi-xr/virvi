import { describe, it, expect } from 'vitest'
import { giveawaysFrom } from '../src/config.js'

const SECRET = 'ab'.repeat(32)
const KEY = `0x${'11'.repeat(32)}`

describe('giveawaysFrom (LIV-194)', () => {
  it('is off with nothing set, with the defaults', () => {
    const g = giveawaysFrom({})
    expect(g.enabled).toBe(false)
    expect(g.walletSecret).toBeNull()
    expect(g.gasKey).toBeNull()
    expect(g.jobEveryMs).toBe(15_000)
    expect(g.tankMinWei).toBe(5n * 10n ** 18n)
    expect(g.tankMinWeiByChain['polygon-amoy']).toBe(5n * 10n ** 16n)
    expect(g.rpc.polygon).toMatch(/^https:/)
  })

  it('is on with a 64-hex secret, as 32 bytes', () => {
    const g = giveawaysFrom({ GIVEAWAY_WALLET_SECRET: SECRET })
    expect(g.enabled).toBe(true)
    expect(g.walletSecret).toBeInstanceOf(Buffer)
    expect(g.walletSecret!.length).toBe(32)
  })

  it('refuses a bad secret without echoing it', () => {
    expect(() => giveawaysFrom({ GIVEAWAY_WALLET_SECRET: 'abc' })).toThrow(/GIVEAWAY_WALLET_SECRET must be 64 hex/)
    try { giveawaysFrom({ GIVEAWAY_WALLET_SECRET: 'abc' }) } catch (e) { expect(String(e)).not.toContain('abc\'') }
  })

  it('checks the gas key, and reuses the BEAT RPC variables', () => {
    expect(giveawaysFrom({ GIVEAWAY_GAS_KEY: KEY }).gasKey).toBe(KEY)
    expect(() => giveawaysFrom({ GIVEAWAY_GAS_KEY: 'nope' })).toThrow(/GIVEAWAY_GAS_KEY/)
    expect(giveawaysFrom({ POLYGON_RPC_URL: 'https://rpc.example' }).rpc.polygon).toBe('https://rpc.example')
  })

  it('reads the tank floor and job interval', () => {
    const g = giveawaysFrom({ GIVEAWAY_TANK_MIN_POL: '2.5', GIVEAWAY_JOB_EVERY_MS: '5000' })
    expect(g.tankMinWei).toBe(25n * 10n ** 17n)
    expect(g.jobEveryMs).toBe(5000)
    expect(() => giveawaysFrom({ GIVEAWAY_TANK_MIN_POL: 'x' })).toThrow(/GIVEAWAY_TANK_MIN_POL/)
  })
})
