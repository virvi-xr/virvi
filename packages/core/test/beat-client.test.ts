import { describe, it, expect, vi, afterEach } from 'vitest'
import { BEAT_CONSENT_VERSION, type VisitorBeat } from '@virvixr/shared'
import { Virvi } from '../src/Virvi.js'

const BEAT: VisitorBeat = {
  id: 'b1', name: 'Launch', imageUrl: 'https://img.example/b1.png', startsAt: '2026-11-14T10:00:00.000Z', endsAt: '2026-11-14T12:00:00.000Z',
  minPresentSeconds: 600, status: 'live', soldOut: false, claimUntil: '2026-11-15T12:00:00.000Z', test: false, autoClaim: false, myClaim: null,
}

function setup(respond: () => Response = () => new Response(JSON.stringify({ beat: BEAT }), { status: 200 })) {
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

describe('BEAT client calls (LIV-11)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('currentBeat reads the connected scene and returns the body', async () => {
    const { virvi, last } = setup()
    expect(await virvi.currentBeat()).toEqual({ beat: BEAT })
    expect(last()).toMatchObject({ url: 'https://api.example/api/scenes/scene%201/beat/current', method: 'GET' })
  })

  it('currentBeat returns null when the scene has no BEAT', async () => {
    const { virvi } = setup(() => new Response(JSON.stringify({ beat: null }), { status: 200 }))
    expect(await virvi.currentBeat()).toEqual({ beat: null })
  })

  it('trackBeat posts the consent version', async () => {
    const { virvi, last } = setup()
    expect(await virvi.trackBeat('b1')).toEqual({ beat: BEAT })
    expect(last()).toEqual({ url: 'https://api.example/api/scenes/scene%201/beat/b1/track', method: 'POST', body: { consentVersion: BEAT_CONSENT_VERSION } })
    // LIV-180: v3, the consent that can say agreeing also claims
    expect(BEAT_CONSENT_VERSION).toBe(3)
  })

  it('beatCheckIn and claimBeat post to their routes and return the beat', async () => {
    const { virvi, last } = setup()
    expect(await virvi.beatCheckIn('b1')).toEqual({ beat: BEAT })
    expect(last()).toMatchObject({ url: 'https://api.example/api/scenes/scene%201/beat/b1/checkin', method: 'POST' })
    expect(await virvi.claimBeat('b1')).toEqual({ beat: BEAT })
    expect(last()).toMatchObject({ url: 'https://api.example/api/scenes/scene%201/beat/b1/claim', method: 'POST' })
  })

  it('stopTrackingBeat deletes the track route', async () => {
    const { virvi, last } = setup(() => new Response(null, { status: 204 }))
    expect(await virvi.stopTrackingBeat('b1')).toBeUndefined()
    expect(last()).toMatchObject({ url: 'https://api.example/api/scenes/scene%201/beat/b1/track', method: 'DELETE' })
  })

  it('ids are encoded in the path', async () => {
    const { virvi, last } = setup()
    await virvi.claimBeat('a/b')
    expect(last().url).toBe('https://api.example/api/scenes/scene%201/beat/a%2Fb/claim')
  })

  it("surfaces the server's error code", async () => {
    for (const code of ['too_early', 'not_tracking', 'not_available', 'scene_pass_required', 'bad_consent', 'no_wallet', 'too_late', 'not_yet', 'all_claimed', 'already_claimed']) {
      const { virvi } = setup(() => new Response(JSON.stringify({ error: code, message: 'nope' }), { status: 409 }))
      await expect(virvi.claimBeat('b1')).rejects.toThrow(new RegExp(`HTTP 409.*${code}`))
    }
  })

  it('beat_available reaches onBeatAvailable, and unsubscribing stops it', () => {
    const { virvi } = setup()
    const handlers = new Map<string, (m: unknown) => void>()
    vi.spyOn((virvi as any).colyseus, 'onMessage').mockImplementation(((type: string, cb: (m: unknown) => void) => { handlers.set(type, cb) }) as any)
    ;(virvi as any).registerMessageHandlers()
    const seen = vi.fn()
    const off = virvi.onBeatAvailable(seen)
    handlers.get('beat_available')!({ beat: { name: 'Launch', test: true } })
    handlers.get('beat_available')!({ beat: null })
    handlers.get('beat_available')!(null)
    expect(seen.mock.calls).toEqual([[{ name: 'Launch', test: true }], [null], [null]])
    off()
    handlers.get('beat_available')!({ beat: { name: 'Launch', test: true } })
    expect(seen).toHaveBeenCalledTimes(3)
  })
})
