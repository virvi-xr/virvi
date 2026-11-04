import { describe, it, expect } from 'vitest'
import { encodeTransfer, ensurePolygon, formatMana, sendMana } from './mana'
import type { ManaQuote } from './studio'

const RECIPIENT = '0x01d871870CbBddE934526E17637c0cfEf0b3b38B'
const TOKEN = '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4'
const E18 = BigInt(10) ** BigInt(18) // BigInt() rather than literals: the web build targets ES2017

/** A wallet that answers each method from `answers` (a function may throw), recording every call. */
function fakeWallet(answers: Record<string, (params?: unknown[]) => unknown>) {
  const calls: { method: string; params?: unknown[] }[] = []
  return {
    calls,
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params })
      const a = answers[method]
      if (!a) throw new Error(`unexpected ${method}`)
      return a(params)
    },
  }
}

describe('encodeTransfer', () => {
  it('is transfer(address,uint256): the selector, the padded address and the padded amount', () => {
    expect(encodeTransfer(RECIPIENT, BigInt(1))).toBe(
      '0xa9059cbb00000000000000000000000001d871870cbbdde934526e17637c0cfef0b3b38b0000000000000000000000000000000000000000000000000000000000000001',
    )
  })
  it('encodes a whole MANA amount in hex', () => {
    expect(encodeTransfer(RECIPIENT, E18).slice(-64)).toBe(E18.toString(16).padStart(64, '0'))
  })
  it('refuses a malformed address or a negative amount', () => {
    expect(() => encodeTransfer('0x1234', BigInt(1))).toThrow()
    expect(() => encodeTransfer(RECIPIENT, BigInt(-1))).toThrow()
  })
})

describe('formatMana', () => {
  it('shows two decimals, rounded up', () => {
    expect(formatMana('116000000000000000007')).toBe('116.01 MANA')
    expect(formatMana('116000000000000000000')).toBe('116.00 MANA')
    expect(formatMana('58500000000000000000')).toBe('58.50 MANA')
    expect(formatMana('1')).toBe('0.01 MANA')
  })
})

describe('ensurePolygon', () => {
  it('switches to Polygon', async () => {
    const w = fakeWallet({ wallet_switchEthereumChain: () => null })
    await ensurePolygon(w)
    expect(w.calls).toEqual([{ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] }])
  })
  it('adds Polygon when the wallet does not know it (4902), then switches', async () => {
    let switches = 0
    const w = fakeWallet({
      wallet_switchEthereumChain: () => { if (switches++ === 0) throw { code: 4902 } ; return null },
      wallet_addEthereumChain: () => null,
    })
    await ensurePolygon(w)
    expect(w.calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain'])
    expect(w.calls[1].params?.[0]).toMatchObject({ chainId: '0x89', nativeCurrency: { decimals: 18 } })
  })
  it('passes on any other refusal, such as the person saying no (4001)', async () => {
    const w = fakeWallet({ wallet_switchEthereumChain: () => { throw { code: 4001 } } })
    await expect(ensurePolygon(w)).rejects.toMatchObject({ code: 4001 })
    expect(w.calls).toHaveLength(1)
  })
})

describe('sendMana', () => {
  const q: ManaQuote = {
    paymentId: 'p1', amountWei: '116000000000000000007', recipient: RECIPIENT, token: TOKEN, chainId: 137,
    usdCents: 2900, usdPerMana: 0.25, expiresAt: '2026-11-04T12:10:00Z',
  }
  it('sends the quoted amount to the recipient through the MANA token from the first account, on Polygon, and returns the hash', async () => {
    const w = fakeWallet({
      eth_requestAccounts: () => ['0xabc0000000000000000000000000000000000001'],
      wallet_switchEthereumChain: () => null,
      eth_sendTransaction: () => '0xhash',
    })
    expect(await sendMana(w, q)).toBe('0xhash')
    expect(w.calls.map((c) => c.method)).toEqual(['eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_sendTransaction'])
    expect(w.calls[2].params).toEqual([{
      from: '0xabc0000000000000000000000000000000000001', to: TOKEN, data: encodeTransfer(RECIPIENT, BigInt('116000000000000000007')),
    }])
  })
  it('refuses with no account', async () => {
    const w = fakeWallet({ eth_requestAccounts: () => [] })
    await expect(sendMana(w, q)).rejects.toThrow()
  })
})
