import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same faked hooks as use-api-stable.test.ts: just enough React to call useApi outside a component.
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
vi.mock('react', () => ({
  useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
  useMemo: (make: () => unknown, deps: unknown[]) => memo(make, deps),
  createContext: (v: unknown) => ({ defaultValue: v }),
  useContext: () => null,
}))
vi.mock('./auth', () => ({ useAuth: () => ({ token: 't1', logout: vi.fn(), renew: vi.fn(async () => 'fresh') }) }))

const { useApi } = await import('./api')
const render = () => { cursor = 0; return useApi() }

describe('ring marker print file api', () => {
  beforeEach(() => { slots.length = 0; vi.restoreAllMocks() })

  it('the file url carries mounting and style, normal by default', () => {
    const api = render()
    expect(api.arMarkerFileUrl('m1', 'pdf')).toMatch(/\/api\/ar\/markers\/m1\/files\?format=pdf&mounting=none&style=normal$/)
    expect(api.arMarkerFileUrl('m1', '3mf', 'tape', 'inverted')).toMatch(/format=3mf&mounting=tape&style=inverted$/)
  })

  it('a download asks for the chosen style and returns the server filename', async () => {
    const fetchMock = vi.fn(async () => new Response('x', { headers: { 'content-disposition': 'attachment; filename="virvi-ring-ABC-140mm-inverted.pdf"' } }))
    vi.stubGlobal('fetch', fetchMock)
    const api = render()
    const out = await api.downloadArMarkerFile('m1', 'pdf', 'none', 'inverted')
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/format=pdf&mounting=none&style=inverted$/)
    expect(out.filename).toBe('virvi-ring-ABC-140mm-inverted.pdf')
    await api.downloadArMarkerFile('m1', 'pdf')
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toMatch(/style=normal$/)
  })
})
