import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, mediaAssets, sceneCollaborators, sceneElementInstances } from '../src/db/schema.js'
import { BACKUP_DEADLINE_MS, BACKUP_MAX_CONCURRENT, setBackupFetcher, setBackupLimits } from '../src/services/backup/download.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const CDN = 'https://cdn.virvi.test'
const enc = (s: string) => new TextEncoder().encode(s)

let app: Awaited<ReturnType<typeof testApp>>
let user: TestUser
let savedCdn: string | null

beforeEach(async () => {
  await resetDb()
  setImportStore(memoryPrivateStore())
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

async function dclScene(name = 'My Cafe!', models = 1) {
  const { scene, preset } = await createScene(user, name)
  for (let i = 0; i < models; i++) {
    const url = `${CDN}/u/m${i}.glb`
    await db.insert(mediaAssets).values({ ownerId: user.id, filename: `m${i}.glb`, contentType: 'application/octet-stream', sizeBytes: 1, publicUrl: url })
    const el = await createElement(preset.id, { type: 'model', name: `M${i}`, properties: { modelSrc: url } })
    await db.insert(sceneElementInstances).values({ elementId: el.id, position: { x: 1, y: 2, z: 3 } })
  }
  await db.insert(dclWorldDestinations).values({
    sceneId: scene.id, ownerUserId: user.id, ownerWallet: user.wallet!, worldName: 'moon.dcl.eth', base: '0,0', parcels: ['0,0'], mode: 'virvi', grantedAt: new Date(),
  })
  return scene
}
const get = (sceneId: string, u: TestUser) => app.inject({ method: 'GET', url: `/api/scenes/${sceneId}/backup.zip`, headers: { authorization: `Bearer ${tokenFor(u)}` } })

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
})
