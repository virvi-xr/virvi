import { describe, it, expect, vi, beforeEach } from 'vitest'

// React's hooks, faked just enough to render a hook twice: memoized values are kept per call position and reused
// while their deps are unchanged, as React does between renders.
const slots: { deps: unknown[]; value: unknown }[] = []
let cursor = 0
const memo = (make: () => unknown, deps: unknown[]) => {
  const slot = slots[cursor]
  cursor++
  if (slot && slot.deps.length === deps.length && slot.deps.every((d, i) => Object.is(d, deps[i]))) return slot.value
  const value = make()
  slots[cursor - 1] = { deps, value }
  return value
}
// The demo context (`DemoApiContext`): null outside a demo, as on every real page
let demoCtx: unknown = null
vi.mock('react', () => ({
  useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
  useMemo: (make: () => unknown, deps: unknown[]) => memo(make, deps),
  createContext: (v: unknown) => ({ defaultValue: v }),
  useContext: () => demoCtx,
}))
let token = 't1'
const logout = vi.fn()
const renew = vi.fn(async (): Promise<string | null> => 'fresh')
vi.mock('./auth', () => ({ useAuth: () => ({ token, logout, renew }) }))

const { useApi } = await import('./api')
const { createDemoApi } = await import('./demo/store')
const render = () => { cursor = 0; return useApi() }

describe('useApi', () => {
  beforeEach(() => { slots.length = 0; token = 't1'; demoCtx = null })

  it('returns the same api between renders, so effects that depend on it run once', () => {
    const first = render()
    const second = render()
    expect(second).toBe(first)
    expect(second.getSceneCollaborators).toBe(first.getSceneCollaborators)
  })

  it('returns a new api when the session changes', () => {
    const first = render()
    token = 't2'
    expect(render()).not.toBe(first)
  })
})

describe('apiFetch', () => {
  beforeEach(() => { slots.length = 0; token = 't1'; renew.mockClear(); logout.mockClear() })
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const authOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get('Authorization')

  it('renews an expired session once and sends the request again with the new token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond(401, { error: 'Unauthorized', message: 'Authorization token expired' }))
      .mockResolvedValueOnce(respond(200, { scenes: [] }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await render().getScenes()).toEqual({ scenes: [] })
    expect(renew).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.map(authOf)).toEqual(['Bearer t1', 'Bearer fresh'])
  })

  it('gives up after one renewal, and does not renew when the refresh is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(401, { error: 'Unauthorized' })))
    await expect(render().getScenes()).rejects.toMatchObject({ status: 401 })
    expect(renew).toHaveBeenCalledTimes(1)
    renew.mockResolvedValueOnce(null)
    const fetchMock = vi.fn(async () => respond(401, { error: 'Unauthorized' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(render().getScenes()).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('useApi inside a demo', () => {
  beforeEach(() => { slots.length = 0; token = 't1' })

  it('answers from the demo, refuses the rest, and never fetches', async () => {
    const onRefused = vi.fn()
    demoCtx = { api: createDemoApi({ trialId: 't1', now: () => Date.parse('2026-11-07T12:00:00Z') }), onRefused }
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = render()
    expect((await api.getEvents()).events).toHaveLength(3)
    for (const call of [() => api.getScene('s'), () => api.deleteScene('s'), () => api.setAnalyticsWalletVisibility('l', true),
      () => api.createPresetSchedule('s', { presetId: 'p', eventId: 'e' }), () => api.getWallets(), () => api.downloadStudioPackages('d')]) {
      await expect(call()).rejects.toMatchObject({ status: 403, body: { error: 'account_required' } })
    }
    expect(onRefused).toHaveBeenCalledWith('demo:getScene')
    expect(fetchMock).not.toHaveBeenCalled()
    demoCtx = null
  })

  it('outside a demo the real api is untouched: it calls the server', async () => {
    demoCtx = null
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await render().getEvents()).toEqual({ events: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
