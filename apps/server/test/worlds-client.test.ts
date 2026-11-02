import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpDclDirectory } from '../src/analytics/dcl-directory.js'
import { DCL_MAX_FILE_BYTES } from '@virvixr/shared'
import { HttpWorldsClient, WorldsError } from '../src/services/dcl/worlds-client.js'

const BASE = 'https://worlds.test'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

const chain = [
  { type: 'SIGNER', payload: '0xabc', signature: '' },
  { type: 'ECDSA_EPHEMERAL', payload: 'Decentraland Login', signature: '0xsig' },
] as never

describe('HttpWorldsClient', () => {
  const client = new HttpWorldsClient(BASE)

  it('getWorldEntities maps /about and /contents/{id} into LiveEntity', async () => {
    const entity = { pointers: ['0,0'], content: [{ file: 'a.glb', hash: 'h1' }], metadata: { scene: { base: '0,0', parcels: ['0,0'] } } }
    const fetchFn = stubFetch((url) => {
      if (url === `${BASE}/world/foo.dcl.eth/about`) return json({ configurations: { scenesUrn: ['urn:decentraland:entity:bafyid?=&baseUrl=https://x/contents/'] } })
      if (url === `${BASE}/contents/bafyid`) return json(entity)
      return new Response('', { status: 500 })
    })
    const out = await client.getWorldEntities('Foo.dcl.eth')
    expect(out).toEqual([{ id: 'bafyid', pointers: ['0,0'], content: entity.content, metadata: entity.metadata }])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('getWorldEntities gives [] when /about is 404', async () => {
    stubFetch(() => json({ error: 'Not Found' }, 404))
    expect(await client.getWorldEntities('none.dcl.eth')).toEqual([])
  })

  it('getWorldEntities throws when a listed entity cannot be resolved', async () => {
    for (const contents of [() => json({}, 404), () => json({ pointers: ['0,0'] })]) {
      stubFetch((url) =>
        url.endsWith('/about') ? json({ configurations: { scenesUrn: ['urn:decentraland:entity:bafyid?=&baseUrl=x'] } }) : contents(),
      )
      await expect(client.getWorldEntities('foo.dcl.eth')).rejects.toBeInstanceOf(WorldsError)
    }
  })

  it('deploy posts multipart with entityId, auth chain and every file', async () => {
    const fetchFn = stubFetch(() => json({ creationTimestamp: 1 }))
    await client.deploy({ entityId: 'eid', authChain: chain, files: new Map([['eid', new Uint8Array([1])], ['h1', new Uint8Array([2, 3])]]) })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/entities`)
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form.get('entityId')).toBe('eid')
    expect(form.get('authChain[0][type]')).toBe('SIGNER')
    expect(form.get('authChain[1][signature]')).toBe('0xsig')
    expect(Object.keys(Object.fromEntries(form.entries()))).toEqual(expect.arrayContaining(['eid', 'h1']))
    expect(((form.get('h1') as File)).size).toBe(2)
  })

  it('deploy throws WorldsError with status and body on 400', async () => {
    stubFetch(() => new Response('{"error":"bad scene"}', { status: 400 }))
    const err = await client.deploy({ entityId: 'e', authChain: chain, files: new Map() }).catch((e) => e)
    expect(err).toBeInstanceOf(WorldsError)
    expect(err.status).toBe(400)
    expect(err.body).toBe('{"error":"bad scene"}')
  })

  it('deploy does not treat a 202 (files missing) as success', async () => {
    stubFetch(() => json({ missing: ['h'] }, 202))
    await expect(client.deploy({ entityId: 'e', authChain: chain, files: new Map() })).rejects.toBeInstanceOf(WorldsError)
  })

  it('sendSigned sends exactly the identity headers, method and path', async () => {
    const fetchFn = stubFetch(() => json({}))
    await client.sendSigned({ method: 'PUT', path: '/world/foo.dcl.eth/permissions/deployment/0xabc', metadata: '{}', timestamp: 123 }, chain)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/world/foo.dcl.eth/permissions/deployment/0xabc`)
    expect(init.method).toBe('PUT')
    expect(Object.keys(init.headers as object).sort()).toEqual(
      ['x-identity-auth-chain-0', 'x-identity-auth-chain-1', 'x-identity-metadata', 'x-identity-timestamp'],
    )
    const h = init.headers as Record<string, string>
    expect(JSON.parse(h['x-identity-auth-chain-1'])).toEqual((chain as unknown[])[1])
    expect(h['x-identity-timestamp']).toBe('123')
    expect(h['x-identity-metadata']).toBe('{}')
  })

  it('sendSigned throws WorldsError on non-2xx', async () => {
    stubFetch(() => new Response('nope', { status: 401 }))
    await expect(client.sendSigned({ method: 'POST', path: '/x', metadata: '{}', timestamp: 1 }, chain)).rejects.toMatchObject({ status: 401, body: 'nope' })
  })

  it('getDeployers reads owner and allow-list live, lowercased', async () => {
    const fetchFn = stubFetch(() => json({ owner: '0xAB', permissions: { deployment: { type: 'allow-list', wallets: ['0xCD'] } } }))
    expect(await client.getDeployers('a.dcl.eth')).toEqual({ owner: '0xab', deployers: ['0xcd'] })
    await client.getDeployers('a.dcl.eth')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('hasContent is a HEAD of /contents/{hash}; getContent reads it, 404 gives null', async () => {
    const fetchFn = stubFetch((url, init) => {
      if (url !== `${BASE}/contents/bafyok`) return new Response('', { status: 404 })
      return new Response(init?.method === 'HEAD' ? null : 'file bytes', { status: 200 })
    })
    expect(await client.hasContent('bafyok')).toBe(true)
    expect(fetchFn.mock.calls[0][1]?.method).toBe('HEAD')
    expect(await client.hasContent('bafygone')).toBe(false)
    expect(new TextDecoder().decode((await client.getContent('bafyok'))!)).toBe('file bytes')
    expect(await client.getContent('bafygone')).toBeNull()
  })

  it("getContent refuses a file over Decentraland's 50 MB limit, by header or by what arrives", async () => {
    const big = DCL_MAX_FILE_BYTES + 1
    stubFetch(() => new Response('x', { status: 200, headers: { 'content-length': String(big) } }))
    await expect(client.getContent('bafybig')).rejects.toThrow(WorldsError)
    // No length header: the read stops once it passes the limit
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (sent > big) return c.close(); const chunk = new Uint8Array(4 * 1024 * 1024); sent += chunk.length; c.enqueue(chunk) },
    })
    stubFetch(() => new Response(body, { status: 200 }))
    await expect(client.getContent('bafybig')).rejects.toThrow(WorldsError)
    expect(sent).toBeLessThan(big + 8 * 1024 * 1024)
  })

  it('getWalletStats parses string byte counts; 404 gives null', async () => {
    stubFetch(() => json({ wallet: '0xab', usedSpace: '10', maxAllowedSpace: '104857600' }))
    expect(await client.getWalletStats('0xAB')).toEqual({ maxAllowedBytes: 104857600, usedBytes: 10 })
    stubFetch(() => json({}, 404))
    expect(await client.getWalletStats('0xAB')).toBeNull()
  })
})

describe('HttpDclDirectory.getOwnedNames', () => {
  it('lowercases and suffixes names, caches per address', async () => {
    const fetchFn = stubFetch((url) => {
      expect(url).toContain('/lambdas/users/0xabc/names')
      return json({ elements: [{ name: 'Cafe' }], totalAmount: 1, pageNum: 1, pageSize: 100 })
    })
    const dir = new HttpDclDirectory('https://catalyst.test', BASE)
    expect(await dir.getOwnedNames('0xAbc')).toEqual(['cafe.dcl.eth'])
    await dir.getOwnedNames('0xabc')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('follows pages until totalAmount is covered', async () => {
    stubFetch((url) =>
      url.includes('pageNum=2')
        ? json({ elements: [{ name: 'b' }], totalAmount: 2 })
        : json({ elements: [{ name: 'a' }], totalAmount: 2 }),
    )
    expect(await new HttpDclDirectory('https://c.test', BASE).getOwnedNames('0x1')).toEqual(['a.dcl.eth', 'b.dcl.eth'])
  })
})
