import { describe, it, expect } from 'vitest'
import { CONFIRMING, MANA_IDLE, confirmOutcome, manaReducer, manaView, onSent, type ManaEvent, type ManaState } from './mana-flow'
import type { ManaQuote } from './studio'

const NOW = new Date('2026-11-04T12:00:00Z')
const quote = (paymentId: string, expiresInMs = 10 * 60_000): ManaQuote => ({
  paymentId, amountWei: '116000000000000000007', recipient: '0x01d871870CbBddE934526E17637c0cfEf0b3b38B',
  token: '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4', chainId: 137, usdCents: 2900, usdPerMana: 0.25,
  expiresAt: new Date(NOW.getTime() + expiresInMs).toISOString(),
})
const run = (events: ManaEvent[], from: ManaState = MANA_IDLE) => events.reduce(manaReducer, from)
const sending = (q = quote('p1')) => run([{ type: 'pay' }, { type: 'quote', attempt: 1, quote: q }])

describe('Pay with MANA', () => {
  it('goes from a price to the wallet to Polygon', () => {
    const s = run([{ type: 'sent', attempt: 1, hash: '0xh' }], sending())
    expect(s).toMatchObject({ step: 'confirming', hash: '0xh', quote: { paymentId: 'p1' } })
    expect(manaView(s, NOW)).toMatchObject({ message: CONFIRMING, action: null, cardOpen: false })
  })

  it('never offers a new price while the wallet is open, even once the price expires', () => {
    const s = sending(quote('p1', 1000))
    expect(manaReducer(s, { type: 'pay' })).toBe(s)
    const later = new Date(NOW.getTime() + 5000)
    expect(manaView(s, later)).toMatchObject({ expired: true, action: null, cardOpen: false })
    expect(manaView(s, later).message).toMatch(/Reject the payment in your wallet/)
    expect(manaView(s, NOW)).toMatchObject({ expired: false, action: null, message: 'Confirm the payment in your wallet.' })
  })

  it('goes back to idle when the person says no in the wallet, and a new price can be asked for', () => {
    const s = run([{ type: 'rejected', attempt: 1 }], sending())
    expect(s).toEqual({ step: 'idle', attempt: 1 })
    expect(manaView(s, NOW)).toMatchObject({ action: 'pay', cardOpen: true })
    expect(manaReducer(s, { type: 'pay' })).toEqual({ step: 'quoting', attempt: 2 })
  })

  it('after any other wallet error, which may come after a broadcast, asks for a new price, never the same quote again', () => {
    const s = run([{ type: 'walletError', attempt: 1, text: 'RPC error' }], sending())
    expect(s).toMatchObject({ step: 'quoted', error: 'RPC error' })
    expect(manaView(s, NOW)).toMatchObject({ action: 'requote', cardOpen: true, message: 'RPC error' })
    expect(manaReducer(s, { type: 'pay' })).toEqual({ step: 'quoting', attempt: 2 })
  })

  it('offers "Get a new price" for a quote that expired while quoted', () => {
    const s = run([{ type: 'walletError', attempt: 1, text: 'x' }], sending(quote('p1', 1000)))
    expect(manaView(s, new Date(NOW.getTime() + 5000))).toMatchObject({ expired: true, action: 'requote' })
  })

  it("ignores an earlier attempt's answers, but reports a hash it returns against its own quote", () => {
    const old = quote('p-old')
    const first = run([{ type: 'walletError', attempt: 1, text: 'x' }], sending(old))
    const second = run([{ type: 'pay' }, { type: 'quote', attempt: 2, quote: quote('p-new') }], first)
    expect(manaReducer(second, { type: 'sent', attempt: 1, hash: '0xold' })).toBe(second)
    expect(manaReducer(second, { type: 'rejected', attempt: 1 })).toBe(second)
    expect(onSent(second, 1, old, '0xold')).toEqual({ follow: false, reportStale: { paymentId: 'p-old', hash: '0xold' } })
    expect(onSent(second, 2, quote('p-new'), '0xnew')).toEqual({ follow: true, reportStale: null })
  })

  it('a reverted transaction needs a new price; a mismatch goes to support with card open', () => {
    const confirming = run([{ type: 'sent', attempt: 1, hash: '0xh' }], sending())
    expect(manaView(manaReducer(confirming, { type: 'txFailed', attempt: 1, text: 'failed' }), NOW)).toMatchObject({ action: 'requote' })
    const m = manaReducer(confirming, { type: 'support', attempt: 1, hash: '0xh', text: 'contact support' })
    expect(m).toMatchObject({ step: 'mismatch', hash: '0xh' })
    expect(manaView(m, NOW)).toMatchObject({ action: null, cardOpen: true, message: 'contact support' })
  })

  it('keeps card closed only while a price, a wallet prompt or a confirmation is in flight', () => {
    expect(manaView({ step: 'quoting', attempt: 1 }, NOW).cardOpen).toBe(false)
  })
})

describe('confirmOutcome', () => {
  const err = (status: number, code?: string) => ({ err: { status, body: code ? { code } : {} } })
  it('finishes when granted or paid, and follows the payment once claimed', () => {
    expect(confirmOutcome({ reported: 'granted' })).toBe('paid')
    expect(confirmOutcome({ paymentStatus: 'paid' })).toBe('paid')
    expect(confirmOutcome({ reported: 'confirming' })).toBe('claimed')
    expect(confirmOutcome({ paymentStatus: 'pending' })).toBe('retry')
  })
  it('stops with support text when the payment closed unpaid', () => {
    expect(confirmOutcome({ paymentStatus: 'expired' })).toEqual({ support: 'closed' })
  })
  it('asks again while the transaction is not mined, or on network and server errors', () => {
    expect(confirmOutcome(err(404, 'tx_not_found'))).toBe('retry')
    expect(confirmOutcome(err(503))).toBe('retry')
    expect(confirmOutcome({ err: {} })).toBe('retry')
  })
  it('names a failed, used or mismatched transaction', () => {
    expect(confirmOutcome(err(409, 'tx_failed'))).toEqual({ txFailed: true })
    expect(confirmOutcome(err(409, 'tx_used'))).toEqual({ support: 'tx_used' })
    expect(confirmOutcome(err(409, 'tx_mismatch'))).toEqual({ support: 'mismatch' })
    expect(confirmOutcome(err(409, 'tx_late'))).toEqual({ support: 'mismatch' })
    expect(confirmOutcome(err(404, 'not_found'))).toEqual({ support: 'mismatch' })
  })
})
