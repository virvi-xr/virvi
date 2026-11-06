import { describe, it, expect, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { SCENE_THUMBNAIL_MAX_BYTES } from '@virvixr/shared'
import { readSceneZip } from '../src/services/import/scene-zip.js'
import { fetch as undiciFetch } from 'undici'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { guardedAgent } from '../src/net/public-agent.js'
import { downloadThumbnail, readSceneThumbnail, ThumbnailUnusable } from '../src/services/import/scene-thumbnail.js'

/** LIV-89: where an imported scene's display.navmapThumbnail is read from. */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const base = { main: 'bin/index.js', runtimeVersion: '7', scene: { parcels: ['0,0'], base: '0,0' }, worldConfiguration: { name: 'moon.dcl.eth' } }

function folder(navmapThumbnail: unknown, files: Record<string, Uint8Array> = {}, wrap = '') {
  const sceneJson = { ...base, display: { title: 'Moon', ...(navmapThumbnail === undefined ? {} : { navmapThumbnail }) } }
  const all = { 'scene.json': strToU8(JSON.stringify(sceneJson)), 'src/index.ts': strToU8('x'), ...files }
  return readSceneZip(zipSync(Object.fromEntries(Object.entries(all).map(([k, v]) => [wrap + k, v]))))
}

/** A fetch that answers every URL with `body`; `lookup` resolves every host to a public address. */
const publicLookup = async () => ['93.184.216.34']
const answering = (body: BodyInit | null, init: ResponseInit = {}) => vi.fn(async () => new Response(body, { status: 200, ...init }))

describe('readSceneThumbnail', () => {
  it('takes a path inside the scene from the upload, normalised like the zip reader', async () => {
    for (const p of ['images/thumb.png', './images/thumb.png', 'images//thumb.png', 'images\\thumb.png', 'Images/Thumb.PNG']) {
      const r = await readSceneThumbnail(folder(p, { 'images/thumb.png': PNG }))
      expect(r, p).toEqual({ kind: 'bytes', data: PNG, from: 'file' })
    }
    // Under a wrapper folder the zip reader strips
    expect(await readSceneThumbnail(folder('images/thumb.png', { 'images/thumb.png': PNG }, 'my-scene/'))).toMatchObject({ kind: 'bytes', from: 'file' })
  })

  it('none named is no thumbnail and no note', async () => {
    expect(await readSceneThumbnail(folder(undefined))).toEqual({ kind: 'none' })
    expect(await readSceneThumbnail(folder(''))).toEqual({ kind: 'none' })
    expect(await readSceneThumbnail(folder('   '))).toEqual({ kind: 'none' })
  })

  it('a missing file, a path escaping the folder, another kind of link or not a string is unusable, with why', async () => {
    const reason = async (v: unknown) => {
      const r = await readSceneThumbnail(folder(v, { 'images/thumb.png': PNG }))
      expect(r.kind, String(v)).toBe('unusable')
      return (r as { reason: string }).reason
    }
    expect(await reason('images/missing.png')).toMatch(/images\/missing\.png isn't in the upload/)
    for (const p of ['../outside.png', 'images/../../outside.png', '/etc/passwd', 'C:/thumb.png', '..\\outside.png']) {
      expect(await reason(p), p).toMatch(/outside the scene folder/)
    }
    for (const p of ['http://example.com/t.png', 'ipfs://bafy/t.png', 'data:image/png;base64,AAAA', 'file:///etc/passwd']) {
      expect(await reason(p), p).toMatch(/only an https link or a file in the scene/)
    }
    expect(await reason(42)).toMatch(/isn't a path or a link/)
    // A folder, not a file
    expect(await reason('images')).toMatch(/isn't in the upload/)
  })

  it('downloads an https link', async () => {
    const fetchImpl = answering(PNG)
    const r = await readSceneThumbnail(folder('https://cdn.example.com/t.png'), { fetchImpl, lookup: publicLookup })
    expect(r).toEqual({ kind: 'bytes', data: PNG, from: 'url' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe('https://cdn.example.com/t.png')
  })

  it('a link that fails to download is unusable, never thrown', async () => {
    const r = await readSceneThumbnail(folder('https://cdn.example.com/t.png'), { fetchImpl: answering('nope', { status: 404 }), lookup: publicLookup })
    expect(r).toEqual({ kind: 'unusable', reason: expect.stringMatching(/couldn't be downloaded \(404\)/) })
  })
})

describe('downloadThumbnail', () => {
  const reason = async (p: Promise<unknown>) => {
    try { await p } catch (e) { if (e instanceof ThumbnailUnusable) return e.reason; throw e }
    return 'ok'
  }

  it('never goes to a private address: nothing is fetched', async () => {
    const fetchImpl = answering(PNG)
    for (const [url, lookup] of [
      ['https://127.0.0.1/t.png', publicLookup],
      ['https://[::1]/t.png', publicLookup],
      ['https://localhost/t.png', publicLookup],
      ['https://internal.example.com/t.png', async () => ['10.0.0.5']],
      ['https://metadata.example.com/t.png', async () => ['93.184.216.34', '169.254.169.254']],
    ] as const) {
      expect(await reason(downloadThumbnail(url, { fetchImpl, lookup })), url).toMatch(/not a public address/)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('only https', async () => {
    expect(await reason(downloadThumbnail('http://cdn.example.com/t.png', { fetchImpl: answering(PNG), lookup: publicLookup }))).toMatch(/https/)
  })

  it('caps the size by its content-length and while it streams', async () => {
    const big = SCENE_THUMBNAIL_MAX_BYTES + 1
    const declared = answering('x', { headers: { 'content-length': String(big) } })
    expect(await reason(downloadThumbnail('https://cdn.example.com/t.png', { fetchImpl: declared, lookup: publicLookup }))).toMatch(/over 2 MB/)
    const stream = new ReadableStream({
      start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close() },
    })
    expect(await reason(downloadThumbnail('https://cdn.example.com/t.png', { fetchImpl: answering(stream), lookup: publicLookup }))).toMatch(/over 2 MB/)
  })

  it('gives up after its timeout', async () => {
    const hang = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    }))
    expect(await reason(downloadThumbnail('https://cdn.example.com/t.png', { fetchImpl: hang, lookup: publicLookup, timeoutMs: 50 }))).toMatch(/took too long/)
  })

  it('follows a redirect only to another public https address', async () => {
    const hops = vi.fn(async (url: unknown) => String(url).includes('first')
      ? new Response(null, { status: 302, headers: { location: 'https://second.example.com/t.png' } })
      : new Response(PNG, { status: 200 }))
    expect(await downloadThumbnail('https://first.example.com/t.png', { fetchImpl: hops, lookup: publicLookup })).toEqual(PNG)
    const toPrivate = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/t.png' } }))
    expect(await reason(downloadThumbnail('https://first.example.com/t.png', { fetchImpl: toPrivate, lookup: publicLookup }))).toMatch(/not a public address/)
    const toHttp = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://cdn.example.com/t.png' } }))
    expect(await reason(downloadThumbnail('https://first.example.com/t.png', { fetchImpl: toHttp, lookup: publicLookup }))).toMatch(/https/)
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://first.example.com/t.png' } }))
    expect(await reason(downloadThumbnail('https://first.example.com/t.png', { fetchImpl: loop, lookup: publicLookup }))).toMatch(/too many redirects/)
  })
})

describe('guardedAgent', () => {
  it('refuses to connect to a private address even when the host passed an earlier check', async () => {
    const server = createServer((_req, res) => res.end('secret'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      // The same server, reached through a name that resolves to it
      const open = await undiciFetch(`http://rebind.example.com:${port}/`, { dispatcher: guardedAgent(async () => ['127.0.0.1'], { allowPrivate: () => true }) })
      expect(await open.text()).toBe('secret')
      await expect(undiciFetch(`http://rebind.example.com:${port}/`, { dispatcher: guardedAgent(async () => ['127.0.0.1']) })).rejects.toThrow()
    } finally {
      server.close()
    }
  })
})
