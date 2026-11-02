import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, sceneDeployments, sceneImports } from '../src/db/schema.js'
import { localPrivateStore, memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { FILES_EXPIRED, sweepRetention } from '../src/services/import/retention.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DAY = 24 * 60 * 60_000
const WORLD = 'cafe.dcl.eth'

describe('retention (Ruling R27)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryPrivateStore>
  let user: TestUser
  const now = new Date('2026-12-15T12:00:00Z')

  beforeEach(async () => {
    await resetDb()
    store = memoryPrivateStore()
    setImportStore(store)
    user = await createUser()
    app = await testApp()
  })
  afterEach(async () => {
    setImportStore(null)
    await app.close()
  })

  const auth = { authorization: '' }
  const importRow = async (id: string) => (await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, id) }))!

  /** An import with its source, built files and log stored, its status and updated_at as given. */
  async function anImport(status: typeof sceneImports.$inferSelect['status'], updatedAt: Date) {
    const { scene } = await createScene(user, 'Cafe')
    const [row] = await db.insert(sceneImports).values({
      userId: user.id, sceneId: scene.id, worldName: WORLD, kind: 'sdk7', sourceKey: 'pending', status, updatedAt,
    }).returning()
    const p = `imports/${row.id}/`
    await db.update(sceneImports).set({ sourceKey: `${p}source.zip`, builtKeyPrefix: `${p}built/`, logKey: `${p}build.log`, updatedAt })
      .where(eq(sceneImports.id, row.id))
    for (const k of ['source.zip', 'built/scene.json', 'built/bin/index.js', 'build.log']) await store.put(p + k, Buffer.from(k), 'application/octet-stream')
    return row.id
  }

  it('an ended import older than 30 days loses its files, and its log route answers 410; a recent one keeps them', async () => {
    const old = await anImport('deployed', new Date(now.getTime() - 31 * DAY))
    const superseded = await anImport('failed', new Date(now.getTime() - 40 * DAY))
    const recent = await anImport('failed', new Date(now.getTime() - 29 * DAY))
    // Not ended: never touched, however old
    const waiting = await anImport('built', new Date(now.getTime() - 90 * DAY))

    await sweepRetention(now)

    for (const id of [old, superseded]) {
      expect(store.keys().filter((k) => k.startsWith(`imports/${id}/`))).toEqual([])
      expect((await importRow(id)).filesDeletedAt).toEqual(now)
    }
    for (const id of [recent, waiting]) {
      expect(store.keys().filter((k) => k.startsWith(`imports/${id}/`))).toHaveLength(4)
      expect((await importRow(id)).filesDeletedAt).toBeNull()
    }

    auth.authorization = `Bearer ${tokenFor(user)}`
    const log = await app.inject({ method: 'GET', url: `/api/imports/${old}/log`, headers: auth })
    expect([log.statusCode, log.json()]).toEqual([410, { error: 'files_expired', message: FILES_EXPIRED }])
    expect(FILES_EXPIRED).toBe("This import's files were deleted after 30 days.")
    const view = (await app.inject({ method: 'GET', url: `/api/imports/${old}`, headers: auth })).json().import
    expect(view).toMatchObject({ filesExpired: true, logTail: null })
    expect((await app.inject({ method: 'GET', url: `/api/imports/${recent}`, headers: auth })).json().import.filesExpired).toBe(false)
    expect((await app.inject({ method: 'GET', url: `/api/imports/${recent}/log`, headers: auth })).statusCode).toBe(200)
  })

  describe('deployed/<hash> files', () => {
    const OLD = new Date(now.getTime() - 2 * 60 * 60_000)
    async function deployment(o: { createdAt: Date; hashes: string[]; entityId: string; destinationId?: string; status?: 'deployed' | 'failed' }) {
      const { scene } = await createScene(user, 'Cafe')
      const [d] = await db.insert(sceneDeployments).values({
        sceneId: scene.id, platform: 'decentraland', deploymentType: 'world', target: {}, status: o.status ?? 'deployed',
        createdAt: o.createdAt, catalystEntityId: o.entityId, destinationId: o.destinationId,
        assetBundle: { content: o.hashes.map((hash, i) => ({ file: `f${i}`, hash })) },
      }).returning()
      return { sceneId: scene.id, id: d.id }
    }
    const kept = async (hash: string, at = OLD) => { await store.put(`deployed/${hash}`, Buffer.from(hash), 'application/octet-stream'); store.setModifiedAt(`deployed/${hash}`, at) }
    const has = (hash: string) => store.keys().includes(`deployed/${hash}`)

    it('keeps hashes a live or recent deployment references, deletes unreferenced and old-only ones, never a fresh object', async () => {
      // The destination's live deployment is 90 days old: its files stay
      const live = await deployment({ createdAt: new Date(now.getTime() - 90 * DAY), hashes: ['bafylive', 'bafyshared'], entityId: 'bafyentitylive' })
      await db.insert(dclWorldDestinations).values({
        sceneId: live.sceneId, ownerUserId: user.id, ownerWallet: '0x' + '1'.repeat(40), worldName: WORLD, base: '0,0', parcels: ['0,0'],
        mode: 'sign', lastEntityId: 'bafyentitylive',
      }).returning().then(([d]) => db.update(sceneDeployments).set({ destinationId: d.id }).where(eq(sceneDeployments.id, live.id)))
      // A recent deployment (any status) keeps its files
      await deployment({ createdAt: new Date(now.getTime() - 3 * DAY), hashes: ['bafyrecent'], entityId: 'bafyentityrecent', status: 'failed' })
      // Older than 30 days and not live: its files go, even the one it shares with nothing
      await deployment({ createdAt: new Date(now.getTime() - 45 * DAY), hashes: ['bafyoldonly', 'bafyshared'], entityId: 'bafyentityold' })
      for (const h of ['bafylive', 'bafyshared', 'bafyrecent', 'bafyoldonly', 'bafyorphan']) await kept(h)
      // Written a minute ago with nothing referencing it yet (a deploy keeping files right now)
      await kept('bafyfresh', new Date(now.getTime() - 60_000))

      await sweepRetention(now)

      expect(has('bafylive')).toBe(true)
      expect(has('bafyshared')).toBe(true)
      expect(has('bafyrecent')).toBe(true)
      expect(has('bafyfresh')).toBe(true)
      expect(has('bafyoldonly')).toBe(false)
      expect(has('bafyorphan')).toBe(false)
    })

    it("works on a local store, which dates objects by their files' times", async () => {
      const local = localPrivateStore(mkdtempSync(join(tmpdir(), 'retention-')))
      setImportStore(local)
      await local.put('deployed/bafyorphan', Buffer.from('x'), 'application/octet-stream')
      // Just written: too fresh to delete at the real time
      await sweepRetention(new Date())
      expect((await local.list('deployed/')).map((o) => o.key)).toEqual(['deployed/bafyorphan'])
      expect((await local.list('deployed/'))[0].modifiedAt).toBeInstanceOf(Date)
      await sweepRetention(new Date(Date.now() + 2 * 60 * 60_000))
      expect(await local.list('deployed/')).toEqual([])
      await local.put('a/b', Buffer.from('x'), 'text/plain')
      expect(await local.delete('a/b')).toBe(1)
      expect(await local.get('a/b')).toBeNull()
    })
  })
})
