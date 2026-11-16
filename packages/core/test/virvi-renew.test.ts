import { describe, it, expect, vi, afterEach } from 'vitest'
import { Virvi } from '../src/Virvi.js'

const pass = (n: number, sceneId: string | null = 's1') =>
  ({ accessToken: `pass${n}`, refreshToken: null, user: { id: 'u', role: 'user' }, scene: { sceneId, locationId: 'l1' } })

function signedAdapter(answers: Array<object | Error>) {
  const signedRequest = vi.fn(async () => {
    const a = answers.length > 1 ? answers.shift()! : answers[0]
    if (a instanceof Error) throw a
    return { status: 200, body: JSON.stringify(a) }
  })
  const adapter = {
    capabilities: { platformName: 'decentraland' },
    getPlatformUser: async () => ({ id: 'u' }),
    getSceneInfo: async () => ({ sceneId: null }),
    getEnvironment: async () => ({}),
    getAuthProof: async () => ({}),
    signedRequest,
    systems: new Set<(dt: number) => void>(),
    registerSystem(fn: (dt: number) => void) { this.systems.add(fn) },
    unregisterSystem(fn: (dt: number) => void) { this.systems.delete(fn) },
  } as any
  return { adapter, signedRequest }
}

const cfg = { apiUrl: 'https://api.example' } as any

/** Move the clock and run one frame of every registered system. */
async function later(adapter: any, ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  for (const fn of [...adapter.systems]) fn(ms / 1000)
  await vi.advanceTimersByTimeAsync(0)
}

describe('scene pass renewal', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('renews every 10 min with a signed request and hands the new pass to the room', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const { adapter, signedRequest } = signedAdapter([pass(1), pass(2)])
    const virvi = new Virvi(adapter)
    await virvi.authenticate(cfg)
    const colyseus = (virvi as any).colyseus
    vi.spyOn(colyseus, 'getRoom').mockReturnValue({})
    const send = vi.spyOn(colyseus, 'send').mockImplementation(() => {})
    await later(adapter, 10 * 60_000)
    expect(signedRequest).toHaveBeenCalledTimes(2)
    expect(virvi.httpClient.auth.token).toBe('pass2')
    expect(send).toHaveBeenCalledWith('auth_renew', { sessionToken: 'pass2' })
    expect(fetchMock).not.toHaveBeenCalled()
    await virvi.destroy()
    expect(adapter.systems.size).toBe(0)
  })

  it('a failed or guest re-sign keeps the current pass and never falls back to an unverified sign-in', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const { adapter } = signedAdapter([pass(1), new Error('explorer busy'), { accessToken: 'guest', refreshToken: null, user: { id: 'g', role: 'viewer' }, guest: true }])
    const virvi = new Virvi(adapter)
    await virvi.authenticate(cfg)
    await later(adapter, 10 * 60_000)
    await later(adapter, 10 * 60_000)
    expect(virvi.httpClient.auth.token).toBe('pass1')
    expect(virvi.binding).toEqual({ sceneId: 's1', locationId: 'l1' })
    expect(fetchMock).not.toHaveBeenCalled()
    await virvi.destroy()
  })

  it('guests and visitor passes are not renewed', async () => {
    vi.useFakeTimers()
    const { adapter, signedRequest } = signedAdapter([pass(1, null)])
    const virvi = new Virvi(adapter)
    await virvi.authenticate(cfg)
    await later(adapter, 30 * 60_000)
    expect(signedRequest).toHaveBeenCalledTimes(1)
    expect(adapter.systems.size).toBe(0)
  })

  it('a re-sign on a replaced client never overwrites the newer sign-in', async () => {
    const { adapter } = signedAdapter([pass(1, 's1'), pass(2, 's2'), pass(3, 's2')])
    const virvi = new Virvi(adapter)
    await virvi.authenticate(cfg)
    const old = virvi.httpClient
    await virvi.authenticate(cfg)
    await old.reauthenticate!()
    expect(old.auth.token).toBe('pass3')
    expect(virvi.binding?.sceneId).toBe('s2')
    expect(virvi.httpClient.auth.token).toBe('pass2')
    await virvi.destroy()
  })

  it('a renewal that comes back unbound (or for another scene) keeps the pass and keeps renewing', async () => {
    vi.useFakeTimers()
    const { adapter, signedRequest } = signedAdapter([pass(1), pass(2, null), pass(3, 's9'), pass(4)])
    const virvi = new Virvi(adapter)
    await virvi.authenticate(cfg)
    const colyseus = (virvi as any).colyseus
    vi.spyOn(colyseus, 'getRoom').mockReturnValue({})
    const send = vi.spyOn(colyseus, 'send').mockImplementation(() => {})
    await later(adapter, 10 * 60_000)
    expect(virvi.httpClient.auth.token).toBe('pass1')
    expect(virvi.binding?.sceneId).toBe('s1')
    await later(adapter, 30_000)
    expect(virvi.httpClient.auth.token).toBe('pass1')
    await later(adapter, 30_000)
    expect(signedRequest).toHaveBeenCalledTimes(4)
    expect(virvi.httpClient.auth.token).toBe('pass4')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('auth_renew', { sessionToken: 'pass4' })
    await virvi.destroy()
  })

  it('after a failed renewal the next try is 30 s later, not 10 min', async () => {
    vi.useFakeTimers()
    const { adapter, signedRequest } = signedAdapter([pass(1), new Error('blip'), pass(2)])
    const virvi = new Virvi(adapter)
    await virvi.authenticate(cfg)
    await later(adapter, 10 * 60_000)
    await later(adapter, 29_000)
    expect(signedRequest).toHaveBeenCalledTimes(2)
    await later(adapter, 1_000)
    expect(signedRequest).toHaveBeenCalledTimes(3)
    expect(virvi.httpClient.auth.token).toBe('pass2')
    await virvi.destroy()
  })

  it('M-9: a renewal the room could not check (auth_unavailable) is sent again with a backoff until the room acks one', async () => {
    vi.useFakeTimers()
    const { adapter } = signedAdapter([pass(1)])
    const virvi = new Virvi(adapter)
    await virvi.authenticate(cfg)
    const colyseus = (virvi as any).colyseus
    const handlers = new Map<string, (m: unknown) => void>()
    vi.spyOn(colyseus, 'onMessage').mockImplementation(((type: string, fn: (m: unknown) => void) => { handlers.set(type, fn) }) as any)
    vi.spyOn(colyseus, 'onLeave').mockImplementation(() => {})
    vi.spyOn(colyseus, 'getRoom').mockReturnValue({})
    const send = vi.spyOn(colyseus, 'send').mockImplementation(() => {})
    ;(virvi as any).registerMessageHandlers()
    const unavailable = () => handlers.get('virvi_error')!({ code: 'auth_unavailable', messageType: 'auth_renew' })
    const sent = () => send.mock.calls.filter((c) => c[0] === 'auth_renew').length

    unavailable()
    await later(adapter, 1_999)
    expect(sent()).toBe(0)
    await later(adapter, 1)
    expect(send).toHaveBeenLastCalledWith('auth_renew', { sessionToken: 'pass1' })
    expect(sent()).toBe(1)
    // Still failing: each wait is longer (2 s, 5 s, 15 s, 30 s, then 60 s for good)
    unavailable()
    await later(adapter, 4_999)
    expect(sent()).toBe(1)
    await later(adapter, 1)
    expect(sent()).toBe(2)
    unavailable()
    await later(adapter, 15_000)
    expect(sent()).toBe(3)
    // Acked: nothing more is sent, and the next failure starts over at 2 s
    handlers.get('auth_renew_ack')!({})
    await later(adapter, 60_000)
    expect(sent()).toBe(3)
    unavailable()
    await later(adapter, 2_000)
    expect(sent()).toBe(4)
    // Another error (a refused pass) is not retried
    handlers.get('virvi_error')!({ code: 'auth_renew_refused', messageType: 'auth_renew' })
    await later(adapter, 60_000)
    expect(sent()).toBe(4)
    // A retry still waiting stops with the client
    unavailable()
    await virvi.destroy()
    expect(adapter.systems.size).toBe(0)
  })

  it('a renewal that lands mid-join is handed to the room once the join finishes', async () => {
    const { adapter } = signedAdapter([pass(1)])
    adapter.getPlatformUser = async () => ({ id: 'u', displayName: 'U', walletAddress: '0xa' })
    const virvi = new Virvi(adapter)
    await virvi.authenticate(cfg)
    const colyseus = (virvi as any).colyseus
    vi.spyOn(colyseus, 'connect').mockImplementation(() => {})
    const send = vi.spyOn(colyseus, 'send').mockImplementation(() => {})
    vi.spyOn(colyseus, 'joinSceneRoom').mockImplementation(async () => { virvi.httpClient.auth.setTokens('pass2', null); return {} as any })
    void virvi.connectToScene('s1')
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('auth_renew', { sessionToken: 'pass2' }))
    await virvi.destroy()
  })
})
