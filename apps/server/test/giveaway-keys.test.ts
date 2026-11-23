import { describe, it, expect, afterEach } from 'vitest'
import { getAddress } from 'ethers'
import { config } from '../src/config.js'
import { GiveawayError } from '../src/giveaways/errors.js'
import { giveawaySigner, newGiveawayWallet } from '../src/giveaways/keys.js'

const original = config.giveaways.walletSecret

describe('giveaway wallet keys', () => {
  afterEach(() => {
    config.giveaways.walletSecret = original
  })
  const withSecret = () => {
    config.giveaways.walletSecret = Buffer.alloc(32, 7)
  }

  it('round-trips the key through the sealed form', () => {
    withSecret()
    const w = newGiveawayWallet()
    expect(giveawaySigner(w.keyEnc).address).toBe(w.address)
    expect(w.address).toBe(getAddress(w.address))
  })

  it('makes a different wallet each time', () => {
    withSecret()
    expect(newGiveawayWallet().address).not.toBe(newGiveawayWallet().address)
  })

  it('seals as v1 and never holds the hex key', () => {
    withSecret()
    const w = newGiveawayWallet()
    const hex = giveawaySigner(w.keyEnc).privateKey
    expect(w.keyEnc.startsWith('v1:')).toBe(true)
    expect(w.keyEnc).not.toContain(hex.slice(2))
  })

  it('refuses tampered ciphertext without leaking key material', () => {
    withSecret()
    const w = newGiveawayWallet()
    const parts = w.keyEnc.split(':')
    const ct = Buffer.from(parts[3], 'base64')
    ct[0] ^= 1
    parts[3] = ct.toString('base64')
    try {
      giveawaySigner(parts.join(':'))
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(GiveawayError)
      expect((e as GiveawayError).code).toBe('key_unreadable')
      expect((e as GiveawayError).status).toBe(500)
    }
  })

  it('cannot be opened with a different secret', () => {
    withSecret()
    const w = newGiveawayWallet()
    config.giveaways.walletSecret = Buffer.alloc(32, 9)
    expect(() => giveawaySigner(w.keyEnc)).toThrowError(expect.objectContaining({ code: 'key_unreadable' }))
  })
})
