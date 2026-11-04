import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalystError, HttpCatalystClient, contentServerFor, getCatalystClient, setCatalystClient } from '../src/services/dcl/catalyst-client.js'
import { setWorldsClient } from '../src/services/dcl/worlds-client.js'
import { FakeCatalystClient } from './helpers/fake-catalyst.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'

const BASE = 'https://catalyst.test'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  setCatalystClient(null)
  setWorldsClient(null)
})

const chain = [
  { type: 'SIGNER', payload: '0xabc', signature: '' },
  { type: 'ECDSA_EPHEMERAL', payload: 'Decentraland Login', signature: '0xsig' },
] as never

describe('HttpCatalystClient', () => {
  const client = new HttpCatalystClient(BASE)

  it('deploy posts multipart to /content/entities with every file', async () => {
    const fetchFn = stubFetch(() => json({ creationTimestamp: 1 }))
    await client.deploy({ entityId: 'eid', authChain: chain, files: new Map([['eid', new Uint8Array([1])], ['h1', new Uint8Array([2, 3])]]) })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/content/entities`)
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form.get('entityId')).toBe('eid')
    expect(form.get('authChain[1][signature]')).toBe('0xsig')
    expect((form.get('eid') as File).size).toBe(1)
    expect((form.get('h1') as File).size).toBe(2)
  })

  it('deploy throws CatalystError with the 400 body', async () => {
    stubFetch(() => new Response('{"errors":["bad scene"]}', { status: 400 }))
    const err = await client.deploy({ entityId: 'e', authChain: chain, files: new Map() }).catch((e) => e)
    expect(err).toBeInstanceOf(CatalystError)
    expect(err.status).toBe(400)
    expect(err.body).toBe('{"errors":["bad scene"]}')
  })

  it('liveEntities posts the parcels and de-duplicates an entity covering several', async () => {
    const e = { id: 'bafy1', pointers: ['0,0', '0,1'], content: [{ file: 'a', hash: 'h' }], metadata: { scene: { base: '0,0', parcels: ['0,0', '0,1'] } } }
    const fetchFn = stubFetch(() => json([e, e]))
    const out = await client.liveEntities({ kind: 'parcels', worldName: null, parcels: ['0,0', '0,1'] })
    expect(out).toEqual([e])
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/content/entities/active`)
    expect(JSON.parse(init.body as string)).toEqual({ pointers: ['0,0', '0,1'] })
  })

  it('reads contents from /content/contents/{hash}', async () => {
    const fetchFn = stubFetch((url, init) =>
      url === `${BASE}/content/contents/bafyok`
        ? new Response(init?.method === 'HEAD' ? null : 'abc', { status: 200, headers: { 'content-length': '3' } })
        : new Response('', { status: 404 }),
    )
    expect(await client.hasContent('bafyok')).toBe(true)
    expect(await client.hasContent('nope')).toBe(false)
    expect(await client.contentSize('bafyok')).toBe(3)
    expect(Buffer.from((await client.getContent('bafyok'))!).toString()).toBe('abc')
    expect(await client.getContent('nope')).toBeNull()
    expect(fetchFn).toHaveBeenCalled()
  })
})

describe('contentServerFor', () => {
  const dest = (kind: 'world' | 'parcels') => ({ kind, worldName: kind === 'world' ? 'foo.dcl.eth' : null, parcels: ['0,0'] })

  it('picks the Worlds server for a world and the catalyst for parcels', async () => {
    const worlds = new FakeWorldsClient()
    const catalyst = new FakeCatalystClient()
    const entity = { id: 'e1', pointers: ['0,0'], content: [], metadata: {} } as never
    worlds.entities.set('foo.dcl.eth', [entity])
    catalyst.entities.set('0,0', [{ ...(entity as object), id: 'e2' } as never])
    setWorldsClient(worlds)
    setCatalystClient(catalyst)
    expect((await contentServerFor(dest('world')).liveEntities(dest('world'))).map((e) => e.id)).toEqual(['e1'])
    expect((await contentServerFor(dest('parcels')).liveEntities(dest('parcels'))).map((e) => e.id)).toEqual(['e2'])
    await contentServerFor(dest('parcels')).deploy({ entityId: 'x', authChain: chain, files: new Map() })
    expect(catalyst.deployed).toHaveLength(1)
    expect(worlds.deployed).toHaveLength(0)
    expect(getCatalystClient()).toBe(catalyst)
  })
})
