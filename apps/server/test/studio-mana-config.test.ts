import { describe, it, expect } from 'vitest'
import { manaSettingsFrom } from '../src/config.js'

describe('manaSettingsFrom', () => {
  it('is off without a recipient', () => {
    expect(manaSettingsFrom({}).recipient).toBeNull()
  })

  it('checksums an all-lowercase recipient', () => {
    const m = manaSettingsFrom({ STUDIO_MANA_RECIPIENT: '0x01d871870cbbdde934526e17637c0cfef0b3b38b' })
    expect(m.recipient).toBe('0x01d871870CbBddE934526E17637c0cfEf0b3b38B')
  })

  it('refuses a mixed-case recipient with a bad checksum', () => {
    expect(() => manaSettingsFrom({ STUDIO_MANA_RECIPIENT: '0x01d871870CbBddE934526E17637c0cfEf0b3b38b' })).toThrow(/STUDIO_MANA_RECIPIENT/)
  })

  it('refuses a value that is not an address', () => {
    expect(() => manaSettingsFrom({ STUDIO_MANA_RECIPIENT: 'nope' })).toThrow(/STUDIO_MANA_RECIPIENT/)
  })

  it('has the Polygon defaults', () => {
    expect(manaSettingsFrom({})).toMatchObject({
      rpcUrl: 'https://polygon-rpc.com',
      token: '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4',
      chainId: 137,
      confirmations: 30,
      quoteTtlMs: 600000,
      graceMs: 900000,
    })
  })

  it('reads the rpc url and token settings', () => {
    const m = manaSettingsFrom({ POLYGON_RPC_URL: 'https://rpc.example', STUDIO_MANA_TOKEN: '0x0000000000000000000000000000000000000001' })
    expect(m.rpcUrl).toBe('https://rpc.example')
    expect(m.token).toBe('0x0000000000000000000000000000000000000001')
  })
})
