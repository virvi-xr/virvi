import { describe, it, expect, vi } from 'vitest'
import { createTransport } from '../src/analytics/transport.js'

describe('createTransport', () => {
  it('signs ingest and the notice calls alike when the adapter can sign', async () => {
    const signedRequest = vi.fn(async () => ({ status: 200, body: '{"decision":null}' }))
    const t = createTransport({ signedRequest })
    expect(await t.request!('http://x/api/analytics/consent?visitorId=v', { method: 'GET' })).toEqual({ status: 200, body: { decision: null } })
    await t.request!('http://x/api/analytics/consent', { method: 'POST', body: '{"decision":"accept"}' })
    expect(signedRequest.mock.calls).toEqual([
      ['http://x/api/analytics/consent?visitorId=v', { method: 'GET', body: '' }],
      ['http://x/api/analytics/consent', { method: 'POST', body: '{"decision":"accept"}' }],
    ])
  })

  it('without signing, a GET goes with no body and a POST as JSON; a network failure is status 0', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => '' }))
    const t = createTransport({}, fetchImpl)
    await t.request!('http://x/a', { method: 'GET' })
    await t.request!('http://x/a', { method: 'POST', body: '{}' })
    expect(fetchImpl.mock.calls).toEqual([
      ['http://x/a', { method: 'GET', headers: {} }],
      ['http://x/a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
    ])
    const down = createTransport({}, async () => { throw new Error('offline') })
    expect(await down.request!('http://x/a', { method: 'GET' })).toEqual({ status: 0 })
  })
})
