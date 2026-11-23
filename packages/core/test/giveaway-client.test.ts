import { describe, it, expect, vi, afterEach } from 'vitest'
import { GIVEAWAY_CONSENT_VERSION, type VisitorGiveaway } from '@virvixr/shared'
import { Virvi } from '../src/Virvi.js'

const GIVEAWAY: VisitorGiveaway = {
  id: 'g1', name: 'Winter drop', items: [{ name: 'Scarf', thumbnail: null, rarity: null }], endsAt: null, minPresentSeconds: 300, test: false, claim: null,
}

function setup(respond: () => Response = () => new Response(JSON.stringify({ giveaway: GIVEAWAY }), { status: 200 })) {
  const fetchMock = vi.fn(async () => respond())
  vi.stubGlobal('fetch', fetchMock)
  const virvi = new Virvi({ capabilities: { platformName: 'test' } } as any)
  ;(virvi as any)._sceneId = 'scene 1'
  ;(virvi as any).http.baseUrl = 'https://api.example'
  const last = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    return { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined }
  }
  return { virvi, last }
}

describe('giveaway client calls (LIV-194)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('currentGiveaway reads the connected scene', async () => {
    const { virvi, last } = setup()
    expect(await virvi.currentGiveaway()).toEqual({ giveaway: GIVEAWAY })
    expect(last()).toMatchObject({ url: 'https://api.example/api/scenes/scene%201/giveaway/current', method: 'GET' })
  })

  it('trackGiveaway posts the consent version', async () => {
    const { virvi, last } = setup()
    expect(await virvi.trackGiveaway('g1')).toEqual({ giveaway: GIVEAWAY })
    expect(last()).toEqual({ url: 'https://api.example/api/scenes/scene%201/giveaway/g1/track', method: 'POST', body: { consentVersion: GIVEAWAY_CONSENT_VERSION } })
  })

  it('giveawayCheckIn and claimGiveaway post to their routes', async () => {
    const { virvi, last } = setup()
    expect(await virvi.giveawayCheckIn('g1')).toEqual({ giveaway: GIVEAWAY })
    expect(last()).toMatchObject({ url: 'https://api.example/api/scenes/scene%201/giveaway/g1/checkin', method: 'POST' })
    expect(await virvi.claimGiveaway('a/b')).toEqual({ giveaway: GIVEAWAY })
    expect(last()).toMatchObject({ url: 'https://api.example/api/scenes/scene%201/giveaway/a%2Fb/claim', method: 'POST' })
  })

  it('stopGiveaway deletes the track route', async () => {
    const { virvi, last } = setup(() => new Response(null, { status: 204 }))
    expect(await virvi.stopGiveaway('g1')).toBeUndefined()
    expect(last()).toMatchObject({ url: 'https://api.example/api/scenes/scene%201/giveaway/g1/track', method: 'DELETE', body: undefined })
  })

  it("surfaces the server's error code", async () => {
    const { virvi } = setup(() => new Response(JSON.stringify({ error: 'too_soon', secondsLeft: 20 }), { status: 409 }))
    await expect(virvi.claimGiveaway('g1')).rejects.toThrow(/HTTP 409.*too_soon/)
  })

  it('giveaway_available reaches onGiveawayAvailable, and unsubscribing stops it', () => {
    const { virvi } = setup()
    const handlers = new Map<string, (m: unknown) => void>()
    vi.spyOn((virvi as any).colyseus, 'onMessage').mockImplementation(((type: string, cb: (m: unknown) => void) => { handlers.set(type, cb) }) as any)
    ;(virvi as any).registerMessageHandlers()
    const seen = vi.fn()
    const off = virvi.onGiveawayAvailable(seen)
    handlers.get('giveaway_available')!({ giveaway: { name: 'Winter drop', test: true } })
    handlers.get('giveaway_available')!({ giveaway: null })
    handlers.get('giveaway_available')!(null)
    expect(seen.mock.calls).toEqual([[{ name: 'Winter drop', test: true }], [null], [null]])
    off()
    handlers.get('giveaway_available')!({ giveaway: { name: 'Winter drop', test: true } })
    expect(seen).toHaveBeenCalledTimes(3)
  })
})
