import { describe, it, expect, afterEach, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function fakeDocument(gl: unknown) {
  const createElement = vi.fn(() => ({ getContext: vi.fn(() => gl) }))
  vi.stubGlobal('document', { createElement })
  return createElement
}

describe('hasWebGL', () => {
  it('asks once, then answers from memory, and releases the context it opened', async () => {
    const loseContext = vi.fn()
    const createElement = fakeDocument({ getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null) })
    const { hasWebGL } = await import('./webgl')
    expect(hasWebGL()).toBe(true)
    expect(hasWebGL()).toBe(true)
    expect(createElement).toHaveBeenCalledTimes(1)
    expect(loseContext).toHaveBeenCalledTimes(1)
  })

  it('no context means no WebGL', async () => {
    fakeDocument(null)
    const { hasWebGL } = await import('./webgl')
    expect(hasWebGL()).toBe(false)
  })

  it('false during server rendering, without remembering it', async () => {
    const { hasWebGL } = await import('./webgl')
    expect(hasWebGL()).toBe(false)
    fakeDocument({ getExtension: () => null })
    expect(hasWebGL()).toBe(true)
  })
})
