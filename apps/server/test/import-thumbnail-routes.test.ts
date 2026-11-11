import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { zipSync, strToU8 } from 'fflate'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, sceneImports, scenes } from '../src/db/schema.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { setBuildRunner, type BuildRunner } from '../src/services/import/build-runner.js'
import { setThumbnailDownloadOptions } from '../src/services/import/scene-thumbnail.js'
import { setWorldsClient } from '../src/services/dcl/worlds-client.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { resetDb } from './helpers/db.js'
import { createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

/** LIV-89: an imported scene's own navmapThumbnail becomes the Virvi scene's thumbnail. */

const WORLD = 'moon.dcl.eth'
const MAIN = "import { engine } from '@dcl/sdk/ecs'\n\nexport function main() {\n  engine.addSystem(() => {})\n}\n"
const stored = (key: string) => existsSync(join(process.env.LOCAL_STORAGE_PATH || './uploads', key))
const image = (w: number, h: number, color = '#3366ff', format: 'png' | 'jpeg' = 'png') =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } }).toFormat(format).toBuffer()

function sceneZip(o: { thumb?: unknown; files?: Record<string, Uint8Array>; world?: string | null; parcels?: string[] } = {}): Buffer {
  const world = o.world === undefined ? WORLD : o.world
  const sceneJson = {
    main: 'bin/index.js', runtimeVersion: '7', scene: { parcels: o.parcels ?? ['0,0'], base: o.parcels?.[0] ?? '0,0' },
    display: { title: 'Moon Base', ...(o.thumb === undefined ? {} : { navmapThumbnail: o.thumb }) },
    ...(world ? { worldConfiguration: { name: world } } : {}),
  }
  const files: Record<string, Uint8Array> = {
    'scene.json': strToU8(JSON.stringify(sceneJson)),
    'package.json': strToU8(JSON.stringify({ name: 'moon', devDependencies: { '@dcl/sdk': 'latest' } })),
    'src/index.ts': strToU8(MAIN),
    ...o.files,
  }
  return Buffer.from(zipSync(files))
}

describe('scene import: the scene\'s own thumbnail', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let worlds: FakeWorldsClient
  let user: TestUser
  const prevUnlocked = config.allFeaturesUnlocked
  /** What the mocked https links answer. */
  let links: Map<string, Buffer>
  const fetchImpl = vi.fn(async (url: string) => {
    const body = links.get(url)
    return body ? new Response(body, { status: 200 }) : new Response('missing', { status: 404 })
  })

  beforeEach(async () => {
    await resetDb()
    worlds = new FakeWorldsClient()
    setWorldsClient(worlds)
    setImportStore(memoryPrivateStore())
    const runner: BuildRunner = { async start() { return { machineId: 'm-1' } }, async stop() {} }
    setBuildRunner(runner)
    links = new Map()
    fetchImpl.mockClear()
    setThumbnailDownloadOptions({ fetchImpl, lookup: async () => ['93.184.216.34'] })
    user = await createUser({ wallet: randomWallet() })
    worlds.deployers.set(WORLD, { owner: user.wallet, deployers: [] })
    app = await testApp()
  })
  afterEach(async () => {
    config.allFeaturesUnlocked = prevUnlocked
    setWorldsClient(null)
    setImportStore(null)
    setBuildRunner(null)
    setThumbnailDownloadOptions(null)
    await app.close()
  })

  const auth = (u: TestUser = user) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const upload = (zip: Buffer) => app.inject({ method: 'POST', url: '/api/imports', payload: zip, headers: { ...auth(), 'content-type': 'application/zip' } })
  const scene = async (id: string) => (await db.query.scenes.findFirst({ where: eq(scenes.id, id) }))!
  const done = (id: string) => db.update(sceneImports).set({ status: 'deployed' }).where(eq(sceneImports.id, id))
  const uploadThumbnail = (sceneId: string, data: Buffer) =>
    app.inject({ method: 'PUT', url: `/api/scenes/${sceneId}/thumbnail`, headers: auth(), payload: { fileData: data.toString('base64') } })

  it('a path in the scene becomes the new scene\'s thumbnail, kept in its own shape, on the Scenes list at once', async () => {
    const res = await upload(sceneZip({ thumb: 'images/thumb.png', files: { 'images/thumb.png': await image(800, 800) } }))
    expect(res.statusCode).toBe(201)
    const view = res.json().import
    const s = await scene(view.sceneId)
    expect(s).toMatchObject({ thumbnailSource: 'import', thumbnailBytes: expect.any(Number) })
    expect(s.thumbnailKey).toMatch(new RegExp(`^scenes/${s.id}/thumbnail-[0-9a-f]{16}\\.jpg$`))
    expect(s.thumbnailUrl).toMatch(new RegExp(`/${s.thumbnailKey}$`))
    expect(stored(s.thumbnailKey!)).toBe(true)
    const meta = await sharp(join(process.env.LOCAL_STORAGE_PATH!, s.thumbnailKey!)).metadata()
    expect([meta.width, meta.height]).toEqual([800, 800]) // not cropped to 16:9
    expect(view.thumbnail).toEqual({ outcome: 'imported', note: null, url: s.thumbnailUrl, source: 'import' })

    const list = await app.inject({ method: 'GET', url: '/api/scenes', headers: auth() })
    const listed = (list.json().scenes ?? list.json()).find((x: { id: string }) => x.id === s.id)
    expect(listed.thumbnailUrl).toBe(s.thumbnailUrl)
    // The import's view says so later too
    expect((await app.inject({ method: 'GET', url: `/api/imports/${view.id}`, headers: auth() })).json().import.thumbnail.outcome).toBe('imported')
  })

  it('an https thumbnail is downloaded (mocked) and kept', async () => {
    links.set('https://cdn.example.com/moon.png', await image(1280, 720))
    const view = (await upload(sceneZip({ thumb: 'https://cdn.example.com/moon.png' }))).json().import
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(view.thumbnail.outcome).toBe('imported')
    expect((await scene(view.sceneId)).thumbnailSource).toBe('import')
  })

  const skipped = async (zip: Buffer) => {
    const res = await upload(zip)
    expect(res.statusCode).toBe(201) // the import carries on
    const view = res.json().import
    expect(['uploaded', 'building']).toContain(view.status)
    const s = await scene(view.sceneId)
    expect([s.thumbnailUrl, s.thumbnailKey, s.thumbnailSource]).toEqual([null, null, null])
    expect(view.thumbnail).toMatchObject({ outcome: 'skipped', url: null })
    expect(view.thumbnail.note).toMatch(/^The scene's thumbnail couldn't be used: /)
    return view.thumbnail.note as string
  }

  it('a missing file, a non-image, a path escaping the folder or a broken link is skipped with a note', async () => {
    expect(await skipped(sceneZip({ thumb: 'images/missing.png' }))).toMatch(/images\/missing\.png isn't in the upload/)
    await resetWorldImports()
    expect(await skipped(sceneZip({ thumb: 'images/thumb.png', files: { 'images/thumb.png': strToU8('<svg/>') } }))).toMatch(/isn't a PNG, JPEG or WebP image/)
    await resetWorldImports()
    expect(await skipped(sceneZip({ thumb: '../../etc/passwd' }))).toMatch(/outside the scene folder/)
    await resetWorldImports()
    expect(await skipped(sceneZip({ thumb: 'https://cdn.example.com/gone.png' }))).toMatch(/couldn't be downloaded \(404\)/)
    await resetWorldImports()
    expect(await skipped(sceneZip({ thumb: 'images/tiny.png', files: { 'images/tiny.png': await image(32, 32) } }))).toMatch(/smaller than 64 × 64/)
  })

  /** Lets the next upload make a new scene (and not wait on the last import). */
  async function resetWorldImports() {
    await db.delete(sceneImports)
    await db.delete(scenes)
  }

  it('none named: no thumbnail and no note', async () => {
    const view = (await upload(sceneZip())).json().import
    expect(view.thumbnail).toEqual({ outcome: null, note: null, url: null, source: null })
  })

  it('over the owner\'s storage quota: skipped with a note, the import goes on', async () => {
    config.allFeaturesUnlocked = false
    await db.insert(assetLibraryItems).values({ name: 'Big', storageKey: 'big', fileSizeBytes: 500 * 1024 * 1024 - 10, uploadedBy: user.id, isPublic: false })
    expect(await skipped(sceneZip({ thumb: 'images/thumb.png', files: { 'images/thumb.png': await image(800, 800) } }))).toMatch(/storage limit/)
  })

  it('a re-import replaces a thumbnail from an earlier import, and deletes its file', async () => {
    const first = (await upload(sceneZip({ thumb: 'images/thumb.png', files: { 'images/thumb.png': await image(800, 800, '#ff0000') } }))).json().import
    const old = (await scene(first.sceneId)).thumbnailKey!
    await done(first.id)
    const again = (await upload(sceneZip({ thumb: 'images/thumb.png', files: { 'images/thumb.png': await image(800, 800, '#00ff00') } }))).json().import
    expect(again.sceneId).toBe(first.sceneId)
    const s = await scene(first.sceneId)
    expect(s.thumbnailKey).not.toBe(old)
    expect(s.thumbnailSource).toBe('import')
    expect(stored(s.thumbnailKey!)).toBe(true)
    expect(stored(old)).toBe(false)
    expect(again.thumbnail.outcome).toBe('imported')
  })

  it('a re-import whose scene.json names none removes the earlier import\'s thumbnail and its file', async () => {
    const first = (await upload(sceneZip({ thumb: 'images/thumb.png', files: { 'images/thumb.png': await image(800, 800) } }))).json().import
    const old = (await scene(first.sceneId)).thumbnailKey!
    await done(first.id)
    const again = (await upload(sceneZip())).json().import
    const s = await scene(first.sceneId)
    expect([s.thumbnailUrl, s.thumbnailKey, s.thumbnailBytes, s.thumbnailSource]).toEqual([null, null, null, null])
    expect(stored(old)).toBe(false)
    expect(again.thumbnail).toEqual({ outcome: 'removed', note: null, url: null, source: null })
  })

  it('a re-import whose thumbnail is broken keeps the earlier import\'s, and says so', async () => {
    const first = (await upload(sceneZip({ thumb: 'images/thumb.png', files: { 'images/thumb.png': await image(800, 800) } }))).json().import
    const old = (await scene(first.sceneId)).thumbnailKey!
    await done(first.id)
    const again = (await upload(sceneZip({ thumb: '../escape.png' }))).json().import
    expect((await scene(first.sceneId)).thumbnailKey).toBe(old)
    expect(stored(old)).toBe(true)
    expect(again.thumbnail.outcome).toBe('skipped')
    expect(again.thumbnail.note).toMatch(/outside the scene folder\. The one from your earlier import stays\.$/)
  })

  it('a re-import naming none never touches a thumbnail the owner uploaded', async () => {
    const first = (await upload(sceneZip())).json().import
    await done(first.id)
    await uploadThumbnail(first.sceneId, await image(1280, 720))
    const mine = (await scene(first.sceneId)).thumbnailKey!
    const again = (await upload(sceneZip())).json().import
    const s = await scene(first.sceneId)
    expect([s.thumbnailKey, s.thumbnailSource]).toEqual([mine, 'upload'])
    expect(stored(mine)).toBe(true)
    expect(again.thumbnail.outcome).toBeNull()
  })

  it('recording the outcome failing never fails the import', async () => {
    const orig = db.update.bind(db)
    const spy = vi.spyOn(db, 'update').mockImplementation(((table: Parameters<typeof db.update>[0]) => {
      const q = orig(table)
      const set = q.set.bind(q)
      q.set = ((v: Record<string, unknown>) => {
        if ('thumbnailOutcome' in v) throw new Error('db down')
        return set(v as never)
      }) as typeof q.set
      return q
    }) as typeof db.update)
    try {
      const res = await upload(sceneZip({ thumb: 'images/thumb.png', files: { 'images/thumb.png': await image(800, 800) } }))
      expect(res.statusCode).toBe(201)
    } finally {
      spy.mockRestore()
    }
  })

  it('a re-import never replaces a thumbnail the owner uploaded in Virvi (nothing is read or downloaded)', async () => {
    const first = (await upload(sceneZip())).json().import
    await done(first.id)
    const put = await uploadThumbnail(first.sceneId, await image(1280, 720, '#123456'))
    expect(put.statusCode).toBe(200)
    const mine = (await scene(first.sceneId)).thumbnailKey!
    links.set('https://cdn.example.com/moon.png', await image(1280, 720))
    const again = (await upload(sceneZip({ thumb: 'https://cdn.example.com/moon.png' }))).json().import
    const s = await scene(first.sceneId)
    expect([s.thumbnailKey, s.thumbnailSource]).toEqual([mine, 'upload'])
    expect(stored(mine)).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(again.thumbnail).toEqual({ outcome: 'kept', note: null, url: s.thumbnailUrl, source: 'upload' })
  })

  it('a LIV-88 thumbnail from before the source was recorded counts as uploaded: kept', async () => {
    const first = (await upload(sceneZip())).json().import
    await done(first.id)
    await uploadThumbnail(first.sceneId, await image(1280, 720))
    await db.update(scenes).set({ thumbnailSource: null }).where(eq(scenes.id, first.sceneId))
    const mine = (await scene(first.sceneId)).thumbnailKey
    const again = (await upload(sceneZip({ thumb: 'images/thumb.png', files: { 'images/thumb.png': await image(800, 800) } }))).json().import
    expect(again.thumbnail.outcome).toBe('kept')
    expect((await scene(first.sceneId)).thumbnailKey).toBe(mine)
  })

  it('replacing it in Virvi makes it an upload; the import\'s view then shows the upload', async () => {
    const first = (await upload(sceneZip({ thumb: 'images/thumb.png', files: { 'images/thumb.png': await image(800, 800) } }))).json().import
    const imported = (await scene(first.sceneId)).thumbnailKey!
    expect((await uploadThumbnail(first.sceneId, await image(1280, 720, '#abcdef'))).statusCode).toBe(200)
    const s = await scene(first.sceneId)
    expect(s.thumbnailSource).toBe('upload')
    expect(stored(imported)).toBe(false)
    const view = (await app.inject({ method: 'GET', url: `/api/imports/${first.id}`, headers: auth() })).json().import
    expect(view.thumbnail).toEqual({ outcome: 'imported', note: null, url: s.thumbnailUrl, source: 'upload' })
  })

  it('a Genesis City parcels import leaves the thumbnail alone (out of scope)', async () => {
    const dir = new FakeDclDirectory()
    setDclDirectory(dir)
    try {
      dir.rights.set('10,10', { owner: user.wallet!, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [] })
      const res = await upload(sceneZip({ world: null, parcels: ['10,10'], thumb: 'images/thumb.png', files: { 'images/thumb.png': await image(800, 800) } }))
      expect(res.statusCode).toBe(201)
      const view = res.json().import
      expect((await scene(view.sceneId)).thumbnailKey).toBeNull()
      expect(view.thumbnail.outcome).toBeNull()
    } finally {
      setDclDirectory(null)
    }
  })
})
