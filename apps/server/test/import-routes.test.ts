import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, sceneDeployments, sceneImports, sceneRoles, scenePresets, scenes } from '../src/db/schema.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import * as runnerModule from '../src/services/import/build-runner.js'
import { setBuildRunner, type BuildRunner } from '../src/services/import/build-runner.js'
import { DEPLOY_WINDOW_MS } from '../src/services/dcl/world-deployer.js'
import { createImport, importView } from '../src/services/import/imports.js'
import { importWork, IMPORTS_BUSY } from '../src/services/import/import-work.js'
import { setWorldsClient } from '../src/services/dcl/worlds-client.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'

vi.mock('../src/services/import/build-runner.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/import/build-runner.js')>()
  return { ...actual, startBuild: vi.fn(actual.startBuild) }
})

const WORLD = 'moon.dcl.eth'
const MAIN = "import { engine } from '@dcl/sdk/ecs'\n\nexport function main() {\n  engine.addSystem(() => {})\n}\n"

function sceneZip(o: { world?: string | null; title?: string; files?: Record<string, string> } = {}): Buffer {
  const world = o.world === undefined ? WORLD : o.world
  const sceneJson = {
    main: 'bin/index.js', runtimeVersion: '7', scene: { parcels: ['0,0'], base: '0,0' },
    ...(o.title ? { display: { title: o.title } } : {}),
    ...(world ? { worldConfiguration: { name: world } } : {}),
  }
  const files = {
    'scene.json': JSON.stringify(sceneJson),
    'package.json': JSON.stringify({ name: 'moon', devDependencies: { '@dcl/sdk': 'latest' } }),
    'src/index.ts': MAIN,
    ...o.files,
  }
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))))
}

function fakeRunner() {
  const started: string[] = []
  const runner: BuildRunner = {
    async start(importId) { started.push(importId); return { machineId: `m-${started.length}` } },
    async stop() {},
  }
  return { runner, started }
}

describe('scene import routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let worlds: FakeWorldsClient
  let store: ReturnType<typeof memoryPrivateStore>
  let fake: ReturnType<typeof fakeRunner>
  let user: TestUser

  beforeEach(async () => {
    await resetDb()
    worlds = new FakeWorldsClient()
    setWorldsClient(worlds)
    store = memoryPrivateStore()
    setImportStore(store)
    fake = fakeRunner()
    setBuildRunner(fake.runner)
    user = await createUser({ wallet: randomWallet() })
    worlds.deployers.set(WORLD, { owner: user.wallet, deployers: [] })
    app = await testApp()
  })
  afterEach(async () => {
    setWorldsClient(null)
    setImportStore(null)
    setBuildRunner(null)
    vi.mocked(runnerModule.startBuild).mockClear()
    await app.close()
  })

  const auth = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const upload = (zip: Buffer, u: TestUser = user) =>
    app.inject({ method: 'POST', url: '/api/imports', payload: zip, headers: { ...auth(u), 'content-type': 'application/zip' } })
  const get = (url: string, u: TestUser = user) => app.inject({ method: 'GET', url, headers: auth(u) })
  const importRow = async (id: string) => (await db.select().from(sceneImports).where(eq(sceneImports.id, id)))[0]
  const setStatus = (id: string, status: typeof sceneImports.$inferSelect['status'], extra: Partial<typeof sceneImports.$inferInsert> = {}) =>
    db.update(sceneImports).set({ status, ...extra }).where(eq(sceneImports.id, id))

  it('imports a World scene: new Virvi scene, source stored with Virvi installed, build started', async () => {
    const res = await upload(sceneZip({ title: 'Moon Base' }))
    expect(res.statusCode).toBe(201)
    const view = res.json().import
    expect(view).toMatchObject({ worldName: WORLD, kind: 'sdk7', errorCode: null, deploymentId: null, destinationId: null, canDeploy: false, logTail: null })
    expect(['uploaded', 'building']).toContain(view.status)

    const [scene] = await db.select().from(scenes).where(eq(scenes.id, view.sceneId))
    expect(scene).toMatchObject({ ownerId: user.id, name: 'Moon Base' })
    const [preset] = await db.select().from(scenePresets).where(eq(scenePresets.sceneId, scene.id))
    expect(preset.name).toBe('Default')
    expect(scene.activePresetId).toBe(preset.id)

    const row = await importRow(view.id)
    expect(row).toMatchObject({ userId: user.id, status: 'building', sourceKey: `imports/${view.id}/source.zip` })
    expect(fake.started).toEqual([view.id])
    const stored = await store.get(row.sourceKey)
    const files = unzipSync(new Uint8Array(stored!.body))
    expect(strFromU8(files['src/index.ts'])).toContain('void createVirvi()')
    expect(JSON.parse(strFromU8(files['package.json'])).dependencies['@virvixr/dcl']).toBeTruthy()
    expect(files['images/virvi/hud-v.png']).toBeTruthy()
    expect(store.keys()).toEqual([`imports/${view.id}/source.zip`])
  })

  it('names a new scene after the World when scene.json has no title', async () => {
    const view = (await upload(sceneZip())).json().import
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, view.sceneId))
    expect(scene.name).toBe(WORLD)
  })

  it("a re-upload keeps the World's Virvi scene", async () => {
    const first = (await upload(sceneZip())).json().import
    await setStatus(first.id, 'deployed')
    const again = await upload(sceneZip())
    expect(again.statusCode).toBe(201)
    expect(again.json().import.sceneId).toBe(first.sceneId)
    expect(await db.select().from(scenes)).toHaveLength(1)
  })

  it("a re-upload by someone without full access on the last import's scene gets a new scene", async () => {
    const first = (await upload(sceneZip())).json().import
    await setStatus(first.id, 'deployed')
    // The NAME moved to another account
    const next = await createUser({ wallet: randomWallet() })
    worlds.deployers.set(WORLD, { owner: next.wallet, deployers: [] })
    const res = await upload(sceneZip(), next)
    expect(res.statusCode).toBe(201)
    const view = res.json().import
    expect(view.sceneId).not.toBe(first.sceneId)
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, view.sceneId))
    expect(scene.ownerId).toBe(next.id)
  })

  it("a re-upload goes to the scene the World's destination belongs to", async () => {
    const { scene } = await createScene(user)
    const [dest] = await db.insert(dclWorldDestinations).values({
      sceneId: scene.id, ownerUserId: user.id, ownerWallet: user.wallet!, worldName: WORLD, base: '0,0', parcels: ['0,0'], mode: 'sign',
    }).returning()
    const res = await upload(sceneZip())
    expect(res.statusCode).toBe(201)
    expect(res.json().import).toMatchObject({ sceneId: scene.id })
    expect(dest.sceneId).toBe(scene.id)
  })

  it("refuses a World whose destination is on a scene the importer can't manage", async () => {
    const other = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(other)
    await db.insert(dclWorldDestinations).values({
      sceneId: scene.id, ownerUserId: other.id, ownerWallet: other.wallet!, worldName: WORLD, base: '0,0', parcels: ['0,0'], mode: 'sign',
    })
    const res = await upload(sceneZip())
    expect([res.statusCode, res.json().error]).toEqual([409, 'world_in_use'])
    expect(await db.select().from(sceneImports)).toHaveLength(0)
  })

  it("refuses a World the importer doesn't own", async () => {
    worlds.deployers.set(WORLD, { owner: randomWallet(), deployers: [] })
    const res = await upload(sceneZip())
    expect([res.statusCode, res.json().error]).toEqual([403, 'not_world_owner'])
    expect(res.json().message).toBeTruthy()
    expect(await db.select().from(sceneImports)).toHaveLength(0)
    expect(store.keys()).toEqual([])
  })

  describe('a World set up under a Virvi scene', () => {
    let other: TestUser
    let theirs: string
    beforeEach(async () => {
      other = await createUser({ wallet: randomWallet() })
      theirs = (await createScene(other)).scene.id
      const loc = await createAnalyticsScene({ kind: 'world', locationKey: `world:${WORLD}`, worldName: WORLD, baseParcel: '0,0', parcels: ['0,0'] })
      await createSetup(loc.id, theirs)
    })

    it("refuses a World set up under someone else's Virvi scene", async () => {
      const res = await upload(sceneZip())
      expect([res.statusCode, res.json().error]).toEqual([409, 'world_set_up_elsewhere'])
      expect(await db.select().from(sceneImports)).toHaveLength(0)
    })

    it('allows it with full access', async () => {
      await db.insert(sceneRoles).values({ sceneId: theirs, walletAddress: user.wallet!, userId: user.id, role: 'cohost', grantedByUserId: other.id })
      const res = await upload(sceneZip())
      expect(res.statusCode).toBe(201)
      expect(res.json().import.sceneId).toBe(theirs)
    })
  })

  it('refuses a second import for a World mid-import', async () => {
    const first = (await upload(sceneZip())).json().import
    for (const status of ['uploaded', 'building', 'deploying'] as const) {
      await setStatus(first.id, status)
      const res = await upload(sceneZip())
      expect([status, res.statusCode, res.json().error]).toEqual([status, 409, 'import_in_progress'])
    }
    expect(await db.select().from(sceneImports)).toHaveLength(1)
  })

  it('a new upload supersedes one that is built or waiting for a signature', async () => {
    for (const status of ['built', 'awaiting_signature'] as const) {
      const old = (await upload(sceneZip())).json().import
      await setStatus(old.id, status)
      const res = await upload(sceneZip())
      expect(res.statusCode).toBe(201)
      expect(await importRow(old.id)).toMatchObject({ status: 'failed', errorCode: 'superseded', errorMessage: 'A newer upload replaced this one.' })
      await setStatus(res.json().import.id, 'deployed')
    }
  })

  it('two uploads at once for one World: one is taken, the other is import_in_progress', async () => {
    const [a, b] = await Promise.all([upload(sceneZip()), upload(sceneZip())])
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
    expect(await db.select().from(sceneImports)).toHaveLength(1)
    expect(await db.select().from(scenes)).toHaveLength(1)
  })

  it('createImport takes one of several racing uploads for a World', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => createImport({ userId: user.id, world: WORLD, kind: 'sdk7', scene: { newName: 'Race' } })))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 409, code: 'import_in_progress' })
    expect(await db.select().from(sceneImports)).toHaveLength(1)
    expect(await db.select().from(scenes)).toHaveLength(1)
  })

  it('a parcels scene is parcels_not_yet', async () => {
    const res = await upload(sceneZip({ world: null }))
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      error: 'parcels_not_yet',
      message: 'Genesis City imports are coming soon. For now, import a scene whose scene.json names a World.',
    })
  })

  it('bad zips map to their ImportError', async () => {
    const notZip = await upload(Buffer.from('hello'))
    expect([notZip.statusCode, notZip.json().error]).toEqual([400, 'not_a_zip'])
    expect(notZip.json().message).toBe('That file is not a readable zip.')
    const noScene = await upload(Buffer.from(zipSync({ 'readme.txt': strToU8('hi') })))
    expect([noScene.statusCode, noScene.json().error]).toEqual([422, 'no_scene_json'])
    const noMain = await upload(sceneZip({ files: { 'src/index.ts': 'export const x = 1\n' } }))
    expect([noMain.statusCode, noMain.json().error]).toEqual([422, 'no_main'])
    expect(await db.select().from(sceneImports)).toHaveLength(0)
    expect(store.keys()).toEqual([])
  })

  it('a zip over the size limit is too_big', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/imports', payload: Buffer.alloc(100 * 1024 * 1024 + 1),
      headers: { ...auth(user), 'content-type': 'application/zip' },
    })
    expect([res.statusCode, res.json().error]).toEqual([413, 'too_big'])
  })

  it('needs a signed-in user', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/imports', payload: sceneZip(), headers: { 'content-type': 'application/zip' } })
    expect(res.statusCode).toBe(401)
  })

  it('answers 503 builds_unavailable when builds are off, storing nothing', async () => {
    setBuildRunner(null)
    const prev = config.sceneBuildRunner
    ;(config as any).sceneBuildRunner = 'off'
    try {
      const res = await upload(sceneZip())
      expect([res.statusCode, res.json().error]).toEqual([503, 'builds_unavailable'])
    } finally {
      ;(config as any).sceneBuildRunner = prev
    }
    expect(await db.select().from(sceneImports)).toHaveLength(0)
    expect(await db.select().from(scenes)).toHaveLength(0)
    expect(store.keys()).toEqual([])
  })

  it('an import whose build could not start ends failed with a message', async () => {
    vi.mocked(runnerModule.startBuild).mockRejectedValueOnce(new Error('database went away'))
    const res = await upload(sceneZip())
    expect(res.statusCode).toBe(502)
    const [row] = await db.select().from(sceneImports)
    expect(res.json()).toEqual({ error: 'build_start_failed', message: row.errorMessage, importId: row.id })
    expect(row.status).toBe('failed')
    expect(row.errorCode).toBe('build_start_failed')
    expect(row.errorMessage).toBeTruthy()
    expect(row.finishedAt).toBeTruthy()
    // It doesn't block the next upload
    expect((await upload(sceneZip())).statusCode).toBe(201)
  })

  it("a build machine that won't start answers 502 with the import's message", async () => {
    fake.runner.start = async () => { throw new Error('fly said no') }
    const res = await upload(sceneZip())
    expect(res.statusCode).toBe(502)
    const [row] = await db.select().from(sceneImports)
    expect(row.status).toBe('failed')
    expect(res.json()).toEqual({ error: 'build_start_failed', message: row.errorMessage, importId: row.id })
    expect(res.json().message).toBeTruthy()
  })

  it("GET is the importer's only (or full access on the scene)", async () => {
    const view = (await upload(sceneZip())).json().import
    const mine = await get(`/api/imports/${view.id}`)
    expect(mine.statusCode).toBe(200)
    expect(mine.json().import).toMatchObject({ id: view.id, status: 'building' })

    const stranger = await createUser({ wallet: randomWallet() })
    expect((await get(`/api/imports/${view.id}`, stranger)).statusCode).toBe(404)
    expect((await get(`/api/imports/${view.id}/log`, stranger)).statusCode).toBe(404)
    expect((await get(`/api/imports?sceneId=${view.sceneId}`, stranger)).json().imports).toEqual([])
    expect((await get('/api/imports/not-a-uuid')).statusCode).toBe(404)

    await db.insert(sceneRoles).values({ sceneId: view.sceneId, walletAddress: stranger.wallet!, userId: stranger.id, role: 'cohost', grantedByUserId: user.id })
    expect((await get(`/api/imports/${view.id}`, stranger)).statusCode).toBe(200)
    expect((await get(`/api/imports?sceneId=${view.sceneId}`, stranger)).json().imports.map((i: { id: string }) => i.id)).toEqual([view.id])
  })

  it('lists the last 10 imports for a scene, newest first', async () => {
    const ids: string[] = []
    for (let i = 0; i < 11; i++) {
      const v = (await upload(sceneZip())).json().import
      ids.push(v.id)
      await setStatus(v.id, 'deployed', { createdAt: new Date(Date.now() + i * 1000) })
    }
    const sceneId = (await importRow(ids[0])).sceneId
    const res = await get(`/api/imports?sceneId=${sceneId}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().imports.map((i: { id: string }) => i.id)).toEqual(ids.slice(1).reverse())
    expect((await get('/api/imports?sceneId=nope')).statusCode).toBe(400)
  })

  it('the log route returns the stored log, and the view carries its tail', async () => {
    const view = (await upload(sceneZip())).json().import
    expect((await get(`/api/imports/${view.id}/log`)).statusCode).toBe(404)
    const log = `${'x'.repeat(10_000)}\nstep 1\nnpm ERR! boom\n`
    await store.put(`imports/${view.id}/build.log`, Buffer.from(log), 'text/plain; charset=utf-8')
    await setStatus(view.id, 'failed', { logKey: `imports/${view.id}/build.log`, errorCode: 'build_failed', errorMessage: 'x' })
    const res = await get(`/api/imports/${view.id}/log`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.body).toBe(log)
    const tail = (await get(`/api/imports/${view.id}`)).json().import.logTail as string
    expect(tail.endsWith('npm ERR! boom\n')).toBe(true)
    expect(tail.length).toBeLessThan(5000)
  })

  it('canDeploy: built, or waiting for a signature whose window has passed', async () => {
    const view = (await upload(sceneZip())).json().import
    const row = await importRow(view.id)
    expect(importView({ ...row, status: 'built' }, null).canDeploy).toBe(true)
    expect(importView({ ...row, status: 'deployed' }, null).canDeploy).toBe(false)

    const now = Date.now()
    const [dep] = await db.insert(sceneDeployments).values({
      sceneId: row.sceneId, platform: 'decentraland', deploymentType: 'world', target: { world: WORLD, parcels: ['0,0'] },
      status: 'awaiting_signature', deployedBy: user.id, assetBundle: { timestamp: now - 1000 },
    }).returning()
    const waiting = { ...row, status: 'awaiting_signature' as const, deploymentId: dep.id }
    expect(importView(waiting, null, dep, now).canDeploy).toBe(false)
    expect(importView(waiting, null, dep, now + DEPLOY_WINDOW_MS).canDeploy).toBe(true)
    expect(importView(waiting, null, { ...dep, status: 'failed' }, now).canDeploy).toBe(true)
    expect(importView(waiting, null, { ...dep, status: 'deploying' }, now + DEPLOY_WINDOW_MS).canDeploy).toBe(false)

    await setStatus(view.id, 'awaiting_signature', { deploymentId: dep.id })
    expect((await get(`/api/imports/${view.id}`)).json().import.canDeploy).toBe(false)
    await db.update(sceneDeployments).set({ assetBundle: { timestamp: now - DEPLOY_WINDOW_MS - 1000 } }).where(eq(sceneDeployments.id, dep.id))
    expect((await get(`/api/imports/${view.id}`)).json().import.canDeploy).toBe(true)
  })
  describe('large uploads never stall the API (I5)', () => {
    it('the source is re-zipped stored (level 0): the box unzips it anyway', async () => {
      const res = await upload(sceneZip({ files: { 'assets/big.txt': 'a'.repeat(50_000) } }))
      expect(res.statusCode).toBe(201)
      const stored = (await store.get(`imports/${res.json().import.id}/source.zip`))!
      const methods: number[] = []
      unzipSync(new Uint8Array(stored.body), { filter: (f) => { methods.push(f.compression); return false } })
      expect(methods.length).toBeGreaterThan(3)
      expect(new Set(methods)).toEqual(new Set([0]))
    })

    it('a third upload while two are processed answers 503 imports_busy, and nothing is stored', async () => {
      const held = [importWork.tryTake(), importWork.tryTake()]
      expect(held.every(Boolean)).toBe(true)
      expect(importWork.tryTake()).toBeNull()
      const res = await upload(sceneZip())
      expect([res.statusCode, res.json()]).toEqual([503, { error: 'imports_busy', message: IMPORTS_BUSY }])
      expect(IMPORTS_BUSY).toBe('Virvi is busy with other imports. Try again in a minute.')
      expect(await db.select().from(sceneImports)).toHaveLength(0)
      held.forEach((release) => release!())
      expect((await upload(sceneZip())).statusCode).toBe(201)
      // Every slot came back, whatever the answer was
      expect(importWork.inUse()).toBe(0)
    })

    it('a slot is given back once, even when release is called twice', () => {
      const a = importWork.tryTake()!
      a()
      a()
      expect(importWork.inUse()).toBe(0)
      const b = importWork.tryTake()!, c = importWork.tryTake()!
      expect(importWork.tryTake()).toBeNull()
      b(); c()
    })
  })
})
