import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, mediaAssets, sceneCollaborators, sceneElementInstances, sceneImports } from '../src/db/schema.js'
import { BACKUP_DEADLINE_MS, BACKUP_MAX_CONCURRENT, runBackup, setBackupFetcher, setBackupLimits } from '../src/services/backup/download.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const CDN = 'https://cdn.virvi.test'
const enc = (s: string) => new TextEncoder().encode(s)

let app: Awaited<ReturnType<typeof testApp>>
let user: TestUser
let savedCdn: string | null
let store: ReturnType<typeof memoryPrivateStore>

beforeEach(async () => {
  await resetDb()
  store = memoryPrivateStore()
  setImportStore(store)
  savedCdn = config.cdnUrl
  ;(config as { cdnUrl: string | null }).cdnUrl = CDN
  user = await createUser({ wallet: randomWallet() })
  setBackupFetcher(async (url) => enc(`bytes of ${url}`))
  app = await testApp()
})
afterEach(async () => {
  setBackupFetcher(null)
  setBackupLimits(null)
  setImportStore(null)
  ;(config as { cdnUrl: string | null }).cdnUrl = savedCdn
  vi.restoreAllMocks()
  await app.close()
})

async function dclScene(name = 'My Cafe!', models = 1, world = 'moon.dcl.eth') {
  const { scene, preset } = await createScene(user, name)
  for (let i = 0; i < models; i++) {
    const url = `${CDN}/u/m${i}.glb`
    await db.insert(mediaAssets).values({ ownerId: user.id, filename: `m${i}.glb`, contentType: 'application/octet-stream', sizeBytes: 1, publicUrl: url })
    const el = await createElement(preset.id, { type: 'model', name: `M${i}`, properties: { modelSrc: url } })
    await db.insert(sceneElementInstances).values({ elementId: el.id, position: { x: 1, y: 2, z: 3 } })
  }
  await db.insert(dclWorldDestinations).values({
    sceneId: scene.id, ownerUserId: user.id, ownerWallet: user.wallet!, worldName: world, base: '0,0', parcels: ['0,0'], mode: 'virvi', grantedAt: new Date(),
  })
  return scene
}
const get = (sceneId: string, u: TestUser, query = '') => app.inject({ method: 'GET', url: `/api/scenes/${sceneId}/backup.zip${query}`, headers: { authorization: `Bearer ${tokenFor(u)}` } })
const unzip = (res: { rawPayload: Buffer }) => unzipSync(new Uint8Array(res.rawPayload))

describe('GET /api/scenes/:sceneId/backup.zip', () => {
  it('sends the project as a zip with download headers', async () => {
    const scene = await dclScene()
    const res = await get(scene.id, user)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="My-Cafe--backup-\d{8}-\d{4}\.zip"$/)
    const files = unzipSync(new Uint8Array(res.rawPayload))
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['README.md', 'scene.json', 'package.json', 'src/index.ts']))
    expect(Object.keys(files).some((p) => p.startsWith('models/'))).toBe(true)
  })

  it('404 for an unknown scene or a bad id, 403 for a viewer and a stranger', async () => {
    const scene = await dclScene()
    const stranger = await createUser()
    const viewer = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: viewer.id, role: 'viewer' })
    expect((await get('00000000-0000-4000-8000-000000000000', user)).statusCode).toBe(404)
    expect((await get('nope', user)).statusCode).toBe(404)
    expect((await get(scene.id, stranger)).statusCode).toBe(403)
    expect((await get(scene.id, viewer)).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/backup.zip` })).statusCode).toBe(401)
  })

  it('422 not_decentraland for a scene with no Decentraland destination or import', async () => {
    const { scene } = await createScene(user, 'Plain')
    const res = await get(scene.id, user)
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('not_decentraland')
  })

  it('413 backup_too_big over 500 MB', async () => {
    const scene = await dclScene('Big', 15)
    const big = new Uint8Array(50 * 1024 * 1024)
    setBackupFetcher(async () => big)
    const res = await get(scene.id, user)
    expect(res.statusCode).toBe(413)
    expect(res.json().error).toBe('backup_too_big')
  })

  it('a third build at once gets 429 backup_busy, and a slot frees when one finishes', async () => {
    expect(BACKUP_MAX_CONCURRENT).toBe(2)
    const scene = await dclScene()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let started = 0
    setBackupFetcher(async (url) => { started++; await gate; return enc(`bytes of ${url}`) })
    const first = get(scene.id, user)
    const second = get(scene.id, user)
    await vi.waitFor(() => expect(started).toBe(2))
    const third = await get(scene.id, user)
    expect(third.statusCode).toBe(429)
    expect(third.json()).toMatchObject({ error: 'backup_busy' })
    release()
    expect([(await first).statusCode, (await second).statusCode]).toEqual([200, 200])
    expect((await get(scene.id, user)).statusCode).toBe(200)
  })

  it('a build past its deadline is 504 backup_timeout, and stops fetching', async () => {
    expect(BACKUP_DEADLINE_MS).toBe(5 * 60_000)
    const scene = await dclScene('Slow', 3)
    setBackupLimits({ deadlineMs: 50 })
    const fetcher = vi.fn(async (url: string) => { await new Promise((r) => setTimeout(r, 120)); return enc(url) })
    setBackupFetcher(fetcher)
    const res = await get(scene.id, user)
    expect(res.statusCode).toBe(504)
    expect(res.json().error).toBe('backup_timeout')
    await new Promise((r) => setTimeout(r, 300))
    expect(fetcher.mock.calls.length).toBeLessThan(3)
  })

  it('a slot frees after a failed build, and after a timed-out one winds down', async () => {
    setBackupLimits({ maxConcurrent: 1 })
    const scene = await dclScene()
    const { scene: plain } = await createScene(user, 'Plain')
    expect((await get(plain.id, user)).statusCode).toBe(422)
    expect((await get(scene.id, user)).statusCode).toBe(200)

    setBackupLimits({ maxConcurrent: 1, deadlineMs: 50 })
    setBackupFetcher(async (url, _cap, _what, signal) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5_000)
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
      })
      return enc(url)
    })
    expect((await get(scene.id, user)).statusCode).toBe(504)
    setBackupLimits({ maxConcurrent: 1 })
    setBackupFetcher(async (url) => enc(`bytes of ${url}`))
    await vi.waitFor(async () => expect((await get(scene.id, user)).statusCode).toBe(200))
  })

  it('a finished build holds its slot until its response closes', async () => {
    setBackupLimits({ maxConcurrent: 1 })
    const scene = await dclScene()
    const held = await runBackup(scene.id, { caller: { userId: user.id, fullAccess: true } })
    expect(held.files.has('README.md')).toBe(true)
    await expect(runBackup(scene.id, { caller: { userId: user.id, fullAccess: true } })).rejects.toMatchObject({ status: 429, code: 'backup_busy' })
    held.release()
    held.release() // twice is harmless
    const next = await runBackup(scene.id, { caller: { userId: user.id, fullAccess: true } })
    next.release()
    // Through the route: each response gives its slot back once sent
    expect((await get(scene.id, user)).statusCode).toBe(200)
    expect((await get(scene.id, user)).statusCode).toBe(200)
  })

  it('a client that leaves during the build gives the slot back', async () => {
    setBackupLimits({ maxConcurrent: 1 })
    const scene = await dclScene()
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    let started = 0
    setBackupFetcher(async (url) => { started++; await gate; return enc(`bytes of ${url}`) })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as AddressInfo
    const req = httpRequest({ host: '127.0.0.1', port, path: `/api/scenes/${scene.id}/backup.zip`, headers: { authorization: `Bearer ${tokenFor(user)}` } })
    req.on('error', () => {})
    req.end()
    await vi.waitFor(() => expect(started).toBe(1))
    req.destroy() // the client gives up while the build is still running
    await new Promise((r) => setTimeout(r, 50))
    open()
    setBackupFetcher(async (url) => enc(`bytes of ${url}`))
    await vi.waitFor(async () => expect((await get(scene.id, user)).statusCode).toBe(200))
  })

  it('the deadline aborts a download in flight', async () => {
    const scene = await dclScene()
    setBackupLimits({ deadlineMs: 50 })
    let aborted = false
    setBackupFetcher(async (url, _cap, _what, signal) => {
      await new Promise((resolve) => signal?.addEventListener('abort', () => { aborted = true; resolve(null) }))
      return enc(url)
    })
    expect((await get(scene.id, user)).statusCode).toBe(504)
    expect(aborted).toBe(true)
  })

  it('the fetch hook gets each file\'s own cap and kind', async () => {
    const { scene, preset } = await createScene(user, 'Kinds')
    const img = `${CDN}/u/logo.png`
    await db.insert(mediaAssets).values({ ownerId: user.id, filename: 'logo.png', contentType: 'image/png', sizeBytes: 1, publicUrl: img })
    const el = await createElement(preset.id, { type: 'image', name: 'Logo', properties: { textureSrc: img } })
    await db.insert(sceneElementInstances).values({ elementId: el.id, position: { x: 1, y: 2, z: 3 } })
    await db.insert(dclWorldDestinations).values({ sceneId: scene.id, ownerUserId: user.id, ownerWallet: user.wallet!, worldName: 'sun.dcl.eth', base: '0,0', parcels: ['0,0'], mode: 'virvi', grantedAt: new Date() })
    const seen: Array<[string, number, string]> = []
    setBackupFetcher(async (url, cap, what) => { seen.push([url, cap, what]); return enc(url) })
    expect((await get(scene.id, user)).statusCode).toBe(200)
    expect(seen).toEqual([[img, 10 * 1024 * 1024, 'Image']])
  })

  describe('?destination=', () => {
    it('a Virvi-built backup uses the chosen destination; one of another scene is 404', async () => {
      const scene = await dclScene()
      const [parcels] = await db.insert(dclWorldDestinations).values({
        sceneId: scene.id, ownerUserId: user.id, ownerWallet: user.wallet!, kind: 'parcels', base: '10,20', parcels: ['10,20'], mode: 'virvi', grantedAt: new Date(),
      }).returning()
      const sj = (res: { rawPayload: Buffer }) => JSON.parse(strFromU8(unzip(res)['scene.json']))
      const chosen = await get(scene.id, user, `?destination=${parcels.id}`)
      expect(chosen.statusCode).toBe(200)
      expect(sj(chosen).scene).toEqual({ base: '10,20', parcels: ['10,20'] })
      expect(sj(chosen).worldConfiguration).toBeUndefined()

      const other = await dclScene('Other', 1, 'sun.dcl.eth')
      const [theirs] = await db.select().from(dclWorldDestinations).where(eq(dclWorldDestinations.sceneId, other.id))
      expect((await get(scene.id, user, `?destination=${theirs.id}`)).statusCode).toBe(404)
      expect((await get(scene.id, user, '?destination=nope')).statusCode).toBe(404)
    })
  })

  describe("the creator's own source (an imported scene)", () => {
    const CREATOR_MAIN = "export function main() {\n  // the creator's code\n}\n"
    async function importedBy(importer: TestUser) {
      const scene = await dclScene('Imported')
      const zip = Buffer.from(zipSync({ 'scene.json': strToU8('{"main":"bin/index.js","runtimeVersion":"7","scene":{"parcels":["0,0"],"base":"0,0"},"worldConfiguration":{"name":"moon.dcl.eth"}}'), 'src/index.ts': strToU8(CREATOR_MAIN) }))
      const [row] = await db.insert(sceneImports).values({ userId: importer.id, sceneId: scene.id, worldName: 'moon.dcl.eth', kind: 'sdk7', sourceKey: 'x', status: 'deployed', finishedAt: new Date() }).returning()
      await store.put(`imports/${row.id}/original.zip`, zip, 'application/zip')
      await store.put(`imports/${row.id}/source.zip`, zip, 'application/zip')
      await db.update(sceneImports).set({ originalKey: `imports/${row.id}/original.zip`, sourceKey: `imports/${row.id}/source.zip` }).where(eq(sceneImports.id, row.id))
      return scene
    }
    const hasCreatorCode = (res: { rawPayload: Buffer }) => strFromU8(unzip(res)['src/index.ts']).includes("the creator's code")
    const LINE = "This backup leaves out the scene's own code, which only the person who imported it (or a full-access member) can download."

    it('goes to its importer and to full-access members; another editor gets the baked content alone', async () => {
      const importer = await createUser({ wallet: randomWallet() })
      const editor = await createUser({ wallet: randomWallet() })
      const scene = await importedBy(importer)
      await db.insert(sceneCollaborators).values([{ sceneId: scene.id, userId: importer.id, role: 'editor' }, { sceneId: scene.id, userId: editor.id, role: 'editor' }])

      const mine = await get(scene.id, importer)
      expect(mine.statusCode).toBe(200)
      expect(hasCreatorCode(mine)).toBe(true)
      const owner = await get(scene.id, user)
      expect(hasCreatorCode(owner)).toBe(true)

      const theirs = await get(scene.id, editor)
      expect(theirs.statusCode).toBe(200)
      const files = unzip(theirs)
      expect(hasCreatorCode(theirs)).toBe(false)
      expect(strFromU8(files['src/index.ts'])).toContain('bakeVirviContent()')
      expect(strFromU8(files['README.md'])).toContain(LINE)
      expect(JSON.parse(strFromU8(files['scene.json'])).worldConfiguration).toMatchObject({ name: 'moon.dcl.eth' })
    })
  })
})
