import { describe, it, expect, vi } from 'vitest'
import { ANALYTICS_CONSENT_VERSION } from '@virvixr/shared'
import { AnalyticsConsent } from '../src/analytics/consent.js'
import type { TransportResult } from '../src/analytics/transport.js'

const SCENE = { realm: 'main', isWorld: false, isPreview: false, baseParcel: '0,0', parcels: ['0,0'] }
const flush = () => new Promise((r) => setTimeout(r, 0))

function rig(answers: Array<TransportResult | Error> = []) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  const request = vi.fn(async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    const a = answers.shift() ?? { status: 200, body: { version: ANALYTICS_CONSENT_VERSION, decision: null } }
    if (a instanceof Error) throw a
    return a
  })
  const waits: number[] = []
  const consent = new AnalyticsConsent({
    apiUrl: 'http://x/',
    request,
    visitorId: '0xabc',
    scene: SCENE,
    platform: 'decentraland',
    sleep: async (ms) => { waits.push(ms) },
  })
  return { consent, calls, request, waits }
}

describe('AnalyticsConsent', () => {
  it('starts loading: nothing may be sent and no notice is up yet', () => {
    const { consent } = rig()
    expect(consent.state).toBe('loading')
    expect(consent.sending).toBe(false)
    expect(consent.declined).toBe(false)
    expect(consent.open).toBe(false)
  })

  it('asks the server for the decision, and shows the notice when there is none', async () => {
    const { consent, calls } = rig()
    await consent.load()
    expect(calls[0]).toMatchObject({ url: 'http://x/api/analytics/consent?visitorId=0xabc', method: 'GET' })
    expect(consent.state).toBe('undecided')
    expect(consent.open).toBe(true)
    expect(consent.sending).toBe(false)
  })

  it('a remembered accept sends at once with no notice; a remembered decline sends nothing', async () => {
    const a = rig([{ status: 200, body: { version: ANALYTICS_CONSENT_VERSION, decision: 'accept' } }])
    await a.consent.load()
    expect(a.consent).toMatchObject({ state: 'accepted', open: false, sending: true, declined: false })
    const d = rig([{ status: 200, body: { version: ANALYTICS_CONSENT_VERSION, decision: 'decline' } }])
    await d.consent.load()
    expect(d.consent).toMatchObject({ state: 'declined', open: false, sending: false, declined: true })
  })

  it('a failed lookup (network, server error, odd answer) counts as no decision: keep buffering and ask', async () => {
    for (const answer of [new Error('offline'), { status: 0 }, { status: 503 }, { status: 200, body: 'nope' },
      { status: 200, body: { version: ANALYTICS_CONSENT_VERSION + 1, decision: 'accept' } }]) {
      const { consent } = rig([answer as TransportResult | Error])
      await consent.load()
      expect(consent).toMatchObject({ state: 'undecided', open: true, sending: false, declined: false })
    }
  })

  it('accepting closes the notice, records it, and sends only once the record is in', async () => {
    let release!: () => void
    const { consent, calls, request } = rig()
    await consent.load()
    request.mockImplementationOnce(async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body!) })
      await new Promise<void>((r) => { release = r })
      return { status: 200, body: { version: ANALYTICS_CONSENT_VERSION, decision: 'accept' } }
    })
    const done = consent.decide('accept')
    expect(consent.open).toBe(false)
    expect(consent.state).toBe('accepted')
    expect(consent.sending).toBe(false) // a decline recorded earlier would still drop what's sent now
    await flush()
    expect(consent.sending).toBe(false)
    release()
    await done
    expect(consent.sending).toBe(true)
    expect(calls[1]).toEqual({
      url: 'http://x/api/analytics/consent', method: 'POST',
      body: { decision: 'accept', version: ANALYTICS_CONSENT_VERSION, visitorId: '0xabc', scene: SCENE, platform: 'decentraland' },
    })
  })

  it('declining stops everything at once, before the record is in', async () => {
    const { consent } = rig()
    await consent.load()
    const done = consent.decide('decline')
    expect(consent).toMatchObject({ state: 'declined', declined: true, sending: false, open: false })
    await done
    expect(consent.declined).toBe(true)
  })

  it('retries a record the server could not take, then keeps the decision for the visit anyway', async () => {
    const { consent, calls, waits } = rig([{ status: 200, body: { version: ANALYTICS_CONSENT_VERSION, decision: null } }, { status: 0 }, { status: 503 }, { status: 0 }])
    await consent.load()
    await consent.decide('accept')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(3)
    expect(waits.length).toBe(2)
    expect(consent.sending).toBe(true)
  })

  it('does not retry a refused record (a stale version)', async () => {
    const { consent, calls } = rig([{ status: 200, body: { version: ANALYTICS_CONSENT_VERSION, decision: null } }, { status: 400, body: { error: 'stale_version' } }])
    await consent.load()
    await consent.decide('decline')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(consent.declined).toBe(true)
  })

  it('Privacy reopens the notice; a new decision replaces the old one, and closing keeps it', async () => {
    const { consent, calls } = rig([{ status: 200, body: { version: ANALYTICS_CONSENT_VERSION, decision: 'decline' } }])
    await consent.load()
    consent.reopen()
    expect(consent.open).toBe(true)
    expect(consent.canClose).toBe(true)
    consent.close()
    expect(consent).toMatchObject({ open: false, state: 'declined' })
    consent.reopen()
    await consent.decide('accept')
    expect(consent).toMatchObject({ state: 'accepted', sending: true, open: false })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { decision: 'accept' } })
  })

  it("can't be closed without a decision, nor reopened while loading", async () => {
    const { consent } = rig()
    consent.reopen()
    expect(consent.open).toBe(false)
    await consent.load()
    expect(consent.canClose).toBe(false)
    consent.close()
    expect(consent.open).toBe(true)
  })

  it('records decisions in order, so the last one made is the last one stored', async () => {
    const { consent, calls } = rig()
    await consent.load()
    const a = consent.decide('accept')
    consent.reopen()
    const b = consent.decide('decline')
    await Promise.all([a, b])
    await flush()
    expect(calls.filter((c) => c.method === 'POST').map((c) => (c.body as { decision: string }).decision)).toEqual(['accept', 'decline'])
    expect(consent).toMatchObject({ state: 'declined', sending: false })
  })

  it('a decision made while the lookup is still out wins over its answer', async () => {
    const { consent, request } = rig()
    let answer!: (r: TransportResult) => void
    request.mockImplementationOnce(() => new Promise((r) => { answer = r }))
    const loading = consent.load()
    await consent.decide('decline')
    answer({ status: 200, body: { version: ANALYTICS_CONSENT_VERSION, decision: 'accept' } })
    await loading
    expect(consent.state).toBe('declined')
  })

  it('tells listeners when anything changes', async () => {
    const { consent } = rig()
    const seen: string[] = []
    consent.onChange(() => seen.push(`${consent.state}:${consent.open}`))
    await consent.load()
    await consent.decide('decline')
    expect(seen).toEqual(['undecided:true', 'declined:false'])
  })
})
