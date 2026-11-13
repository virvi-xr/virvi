import { describe, it, expect, vi, afterEach } from 'vitest'
import { RAFFLE_CONSENT_VERSION } from '@virvixr/shared'
import { Virvi } from '../src/Virvi.js'

function setup() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
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

describe('raffle client calls (LIV-55)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('enterRaffle posts the consent version to the entry route', async () => {
    const { virvi, last } = setup()
    await virvi.enterRaffle('r1')
    expect(last()).toEqual({ url: 'https://api.example/api/raffles/r1/entry', method: 'POST', body: { consentVersion: RAFFLE_CONSENT_VERSION } })
    expect(RAFFLE_CONSENT_VERSION).toBe(1)
  })

  it('reads the current raffle of the connected scene', async () => {
    const { virvi, last } = setup()
    await virvi.getCurrentRaffle()
    expect(last()).toMatchObject({ url: 'https://api.example/api/scenes/scene%201/raffle/current', method: 'GET' })
  })

  it('withdraw, check-in and the host calls hit their routes', async () => {
    const { virvi, last } = setup()
    await virvi.withdrawRaffle('r1')
    expect(last()).toMatchObject({ url: 'https://api.example/api/raffles/r1/entry', method: 'DELETE' })
    await virvi.raffleCheckIn('r1')
    expect(last()).toMatchObject({ url: 'https://api.example/api/raffles/r1/presence', method: 'POST' })
    for (const [fn, path] of [['raffleOpen', 'open'], ['raffleSnapshot', 'snapshot'], ['raffleDraw', 'draw'], ['raffleClose', 'close']] as const) {
      await virvi[fn]('r1')
      expect(last()).toMatchObject({ url: `https://api.example/api/raffles/r1/${path}`, method: 'POST' })
    }
  })

  it('room messages reach the callbacks, and unsubscribing stops them', () => {
    const { virvi } = setup()
    const handlers = new Map<string, (m: unknown) => void>()
    vi.spyOn((virvi as any).colyseus, 'onMessage').mockImplementation(((type: string, cb: (m: unknown) => void) => { handlers.set(type, cb) }) as any)
    ;(virvi as any).registerMessageHandlers()
    const changed = vi.fn(), draw = vi.fn()
    const off = virvi.onRaffleChanged(changed)
    virvi.onRaffleDraw(draw)
    const raffle = { id: 'r1' }
    handlers.get('raffle_changed')!({ raffle })
    handlers.get('raffle_changed')!({ raffle: null })
    handlers.get('raffle_draw')!({ drawId: 'd1', winners: [] })
    expect(changed.mock.calls).toEqual([[raffle], [null]])
    expect(draw).toHaveBeenCalledWith({ drawId: 'd1', winners: [] })
    off()
    handlers.get('raffle_changed')!({ raffle })
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
