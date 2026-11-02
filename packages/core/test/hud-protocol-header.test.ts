import { describe, it, expect, vi, afterEach } from 'vitest'
import { VirviHttpClient } from '@virvixr/client'
import { HUD_PROTOCOL_HEADER } from '@virvixr/shared'

describe('HUD protocol header', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('defaultHeaders go with every request, and the bearer still wins', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new VirviHttpClient('https://api.example')
    client.auth.setTokens('tok', null as any)
    client.defaultHeaders[HUD_PROTOCOL_HEADER] = '1'
    client.defaultHeaders.Authorization = 'Bearer spoof'
    await client.getMedia()
    const headers = (fetchMock.mock.calls[0] as any)[1].headers as Record<string, string>
    expect(headers[HUD_PROTOCOL_HEADER]).toBe('1')
    expect(headers.Authorization).toBe('Bearer tok')
  })

  it('no header without defaultHeaders (the dashboard and other clients)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await new VirviHttpClient('https://api.example').getMedia()
    expect((fetchMock.mock.calls[0] as any)[1].headers[HUD_PROTOCOL_HEADER]).toBeUndefined()
  })
})
