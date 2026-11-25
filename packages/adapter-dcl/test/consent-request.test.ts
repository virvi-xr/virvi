import { describe, it, expect, vi } from 'vitest'
import { consentRequestFor } from '../src/consent/request.js'

const WALLET = '0x00000000000000000000000000000000000000aa'

describe('consentRequestFor', () => {
  it('a wallet decides over a signed request only', async () => {
    const signed = vi.fn(async () => ({ status: 200, body: '{"decision":"accept"}' }))
    const transport = vi.fn()
    const req = consentRequestFor(WALLET, signed, transport)
    expect(await req('http://x/api/analytics/consent?visitorId=v', { method: 'GET' })).toEqual({ status: 200, body: { decision: 'accept' } })
    await req('http://x/api/analytics/consent', { method: 'POST', body: '{}' })
    expect(signed.mock.calls).toEqual([
      ['http://x/api/analytics/consent?visitorId=v', { method: 'GET', body: '' }],
      ['http://x/api/analytics/consent', { method: 'POST', body: '{}' }],
    ])
    expect(transport).not.toHaveBeenCalled()
  })

  it("if signing fails, it's no decision yet (status 0), never an unsigned call as the wallet", async () => {
    const transport = vi.fn()
    const req = consentRequestFor(WALLET, async () => { throw new Error('no signedFetch') }, transport)
    expect(await req('http://x/a', { method: 'POST', body: '{}' })).toEqual({ status: 0 })
    expect(transport).not.toHaveBeenCalled()
  })

  it('a guest id goes through the analytics transport', async () => {
    const transport = vi.fn(async () => ({ status: 200 }))
    const signed = vi.fn()
    const req = consentRequestFor('guest-abc', signed, transport)
    await req('http://x/a', { method: 'GET' })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(signed).not.toHaveBeenCalled()
  })
})
