import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, sceneDeployments, sceneImports, userAuthMethods } from '../src/db/schema.js'
import bcrypt from 'bcryptjs'
import { localPrivateStore, memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { FILES_EXPIRED, startRetentionSweep, stopRetentionSweep, sweepRetention } from '../src/services/import/retention.js'
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

  describe('original uploads (Ruling R7)', () => {
    const under = (id: string) => store.keys().filter((k) => k.startsWith(`imports/${id}/`))
    /** An import with an original.zip, on the given scene. */
    async function withOriginal(sceneId: string, status: typeof sceneImports.$inferSelect['status'], finishedAt: Date, updatedAt: Date) {
      const [row] = await db.insert(sceneImports).values({ userId: user.id, sceneId, worldName: WORLD, kind: 'sdk7', sourceKey: 'x', status, finishedAt, createdAt: finishedAt, updatedAt }).returning()
      const p = `imports/${row.id}/`
      await db.update(sceneImports).set({ sourceKey: `${p}source.zip`, originalKey: `${p}original.zip`, logKey: `${p}build.log` }).where(eq(sceneImports.id, row.id))
      for (const k of ['source.zip', 'original.zip', 'build.log']) await store.put(p + k, Buffer.from(k), 'application/zip')
      return row.id
    }

    it('keeps the newest deployed import\'s original past 30 days, deletes its other files and every other original', async () => {
      const { scene } = await createScene(user, 'Cafe')
      const { scene: other } = await createScene(user, 'Other')
      const t = (days: number) => new Date(now.getTime() - days * DAY)
      const older = await withOriginal(scene.id, 'deployed', t(60), t(60))
      const newest = await withOriginal(scene.id, 'deployed', t(40), t(40))
      const failedAfter = await withOriginal(scene.id, 'failed', t(35), t(35))
      // Another scene, a parcels import: its own newest
      const [parcels] = await db.insert(sceneImports).values({
        userId: user.id, sceneId: other.id, locationKind: 'parcels', base: '0,0', parcels: ['0,0'], kind: 'sdk7', sourceKey: 'x', status: 'deployed', finishedAt: t(45), updatedAt: t(45),
      }).returning()
      await store.put(`imports/${parcels.id}/original.zip`, Buffer.from('o'), 'application/zip')
      await store.put(`imports/${parcels.id}/source.zip`, Buffer.from('s'), 'application/zip')
      await db.update(sceneImports).set({ originalKey: `imports/${parcels.id}/original.zip` }).where(eq(sceneImports.id, parcels.id))
      const recentOlder = await withOriginal(other.id, 'deployed', t(50), t(50)) // older than `parcels` by finished_at

      await sweepRetention(now)

      expect(under(older)).toEqual([])
      expect(under(newest)).toEqual([`imports/${newest}/original.zip`])
      expect(under(failedAfter)).toEqual([])
      expect(under(parcels.id)).toEqual([`imports/${parcels.id}/original.zip`])
      expect(under(recentOlder)).toEqual([])
      expect((await importRow(older)).originalKey).toBeNull()
      expect((await importRow(newest)).originalKey).toBe(`imports/${newest}/original.zip`)
      expect((await importRow(newest)).filesDeletedAt).toEqual(now)

      // A newer deployed import takes over: the old original goes on the next sweep
      const next = await withOriginal(scene.id, 'deployed', t(1), t(1))
      await sweepRetention(now)
      expect(under(newest)).toEqual([])
      expect((await importRow(newest)).originalKey).toBeNull()
      expect(under(next)).toHaveLength(3)
    })
  })

  describe('import files whose rows are gone (account or scene deleted)', () => {
    const put = async (key: string, at: Date) => { await store.put(key, Buffer.from(key), 'application/octet-stream'); store.setModifiedAt(key, at) }
    const under = (id: string) => store.keys().filter((k) => k.startsWith(`imports/${id}/`))

    it('deleting an account deletes the files of its imports and of imports on its scenes; others stay', async () => {
      const other = await createUser()
      const { scene: otherScene } = await createScene(other, 'Theirs')
      const mine = await anImport('deployed', now)
      // Someone else's import on one of this user's scenes goes with the scene
      const onMyScene = (await db.insert(sceneImports).values({
        userId: other.id, sceneId: (await importRow(mine)).sceneId, worldName: WORLD, kind: 'sdk7', sourceKey: 'x', status: 'failed',
      }).returning())[0].id
      await store.put(`imports/${onMyScene}/source.zip`, Buffer.from('x'), 'application/zip')
      const theirs = (await db.insert(sceneImports).values({
        userId: other.id, sceneId: otherScene.id, worldName: WORLD, kind: 'sdk7', sourceKey: 'x', status: 'failed',
      }).returning())[0].id
      await store.put(`imports/${theirs}/source.zip`, Buffer.from('x'), 'application/zip')

      const admin = await createUser({ role: 'admin' })
      const r = await app.inject({ method: 'DELETE', url: `/api/admin/users/${user.id}`, headers: { authorization: `Bearer ${tokenFor(admin)}` } })
      expect(r.statusCode).toBe(204)
      expect(under(mine)).toEqual([])
      expect(under(onMyScene)).toEqual([])
      expect(under(theirs)).toHaveLength(1)
    })

    it('deleting your own account deletes the files of your imports', async () => {
      await db.insert(userAuthMethods).values({ userId: user.id, type: 'email', identifier: user.email!, credentialHash: await bcrypt.hash('pw-1234', 4) })
      const id = await anImport('deployed', now)
      const r = await app.inject({
        method: 'DELETE', url: '/api/auth/account', payload: { password: 'pw-1234' }, headers: { authorization: `Bearer ${tokenFor(user)}` },
      })
      expect(r.statusCode).toBe(204)
      expect(under(id)).toEqual([])
    })

    it('deleting a scene deletes the files of its imports', async () => {
      const id = await anImport('failed', now)
      const sceneId = (await importRow(id)).sceneId
      const keep = await anImport('failed', now)
      const r = await app.inject({ method: 'DELETE', url: `/api/scenes/${sceneId}`, headers: { authorization: `Bearer ${tokenFor(user)}` } })
      expect(r.statusCode).toBe(204)
      expect(under(id)).toEqual([])
      expect(under(keep)).toHaveLength(4)
    })

    it('the sweep deletes an orphaned imports/<id>/ older than an hour, never a fresh one or one with a row', async () => {
      const orphan = '11111111-1111-4111-8111-111111111111'
      const fresh = '22222222-2222-4222-8222-222222222222'
      await put(`imports/${orphan}/source.zip`, new Date(now.getTime() - 2 * 60 * 60_000))
      await put(`imports/${orphan}/built/scene.json`, new Date(now.getTime() - 2 * 60 * 60_000))
      await put(`imports/${fresh}/source.zip`, new Date(now.getTime() - 10 * 60_000))
      const live = await anImport('building', now)
      for (const k of store.keys().filter((k) => k.startsWith(`imports/${live}/`))) store.setModifiedAt(k, new Date(now.getTime() - 5 * DAY))
      await sweepRetention(now)
      expect(under(orphan)).toEqual([])
      expect(under(fresh)).toHaveLength(1)
      expect(under(live)).toHaveLength(4)
    })
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

describe('the retention sweep schedule (N6)', () => {
  afterEach(() => { stopRetentionSweep(); vi.useRealTimers() })
  it('first runs 5 minutes after boot, then daily', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => ({ imports: 0, deployed: 0 }))
    startRetentionSweep(undefined, undefined, run)
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(run).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
