import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { zipSync } from 'fflate'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { PLACEMENTS_FILE, decodePlacements, encodePlacements } from '@virvixr/shared'
import { analyticsScenes, assetLibraryItems, dclWorldDestinations, sceneDeployments, sceneElementInstances, sceneImports, scenes } from '../src/db/schema.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { chainSigner, dclHash, virviSigner } from '../src/services/dcl/entity.js'
import { setWorldsClient, WorldsError, type LiveEntity } from '../src/services/dcl/worlds-client.js'
import { assembleImported, ModelRefused, pendingModels, placementsFile, placementsInScene } from '../src/services/dcl/assemble.js'
import { BATCH_WINDOW_MS, sweepRedeploys } from '../src/services/dcl/redeploy-sweep.js'
import {
  DEPLOY_WINDOW_MS, DeployerError, markFailed, prepareSignedDeploy, reconcileStaleDeployments, startVirviDeploy, submitSignedDeploy, whenSettled,
  type SignedBundle,
} from '../src/services/dcl/world-deployer.js'
import { sweepBuilds } from '../src/services/import/build-sweep.js'
import { setBuildRunner, setOnBuildDone, startBuild, type BuildRunner } from '../src/services/import/build-runner.js'
import { createImport, SUPERSEDED_MESSAGE } from '../src/services/import/imports.js'
import { deployImport, startImportDeploy } from '../src/services/import/import-deploy.js'
import { resetDb } from './helpers/db.js'
import { createElement, createInstance, createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'

const WORLD = 'cafe.dcl.eth'
const CDN = 'https://cdn.virvi.test'
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
type Identity = ReturnType<typeof createUnsafeIdentity>

async function chainFor(wallet: Identity, payload: string) {
  const identity = await Authenticator.initializeAuthChain(
    wallet.address, createUnsafeIdentity(), 10, async (m) => Authenticator.createSignature(wallet, m),
  )
  return Authenticator.signPayload(identity, payload)
}

function sceneJson(parcels = ['0,0', '1,0'], title = 'Owner Title', world = WORLD) {
  return JSON.stringify({
    display: { title }, owner: '', main: 'bin/index.js', ecs7: true, runtimeVersion: '7',
    scene: { parcels, base: parcels[0] }, worldConfiguration: { name: world }, spawnPoints: [],
  })
}

/** What a build of the owner's scene leaves behind. */
function builtFiles(extra: Record<string, Uint8Array> = {}, parcels?: string[], world = WORLD): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['scene.json', enc(sceneJson(parcels, undefined, world))],
    ['bin/index.js', enc('owner code')],
    ['models/Tree.glb', enc('tree bytes')],
    ['images/virvi/hud-v.png', enc('hud icon')],
    ...Object.entries(extra),
  ])
}

describe('deploying an imported build', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let worlds: FakeWorldsClient
  let store: ReturnType<typeof memoryPrivateStore>
  let owner: Identity
  let user: TestUser
  const cfg = config as { virviDclDeployKey: string | null; cdnUrl: string | null }
  const saved = { key: cfg.virviDclDeployKey, cdn: cfg.cdnUrl }
  const fetcher = vi.fn(async (url: string) => enc(`bytes of ${url}`))

  beforeEach(async () => {
    await resetDb()
    cfg.virviDclDeployKey = Wallet.createRandom().privateKey
    cfg.cdnUrl = CDN
    worlds = new FakeWorldsClient()
    setWorldsClient(worlds)
    store = memoryPrivateStore()
    setImportStore(store)
    owner = createUnsafeIdentity()
    user = await createUser({ wallet: owner.address })
    worlds.deployers.set(WORLD, { owner: user.wallet, deployers: [] })
    fetcher.mockClear()
    app = await testApp()
  })
  afterEach(async () => {
    cfg.virviDclDeployKey = saved.key
    cfg.cdnUrl = saved.cdn
    setWorldsClient(null)
    setImportStore(null)
    setBuildRunner(null)
    setOnBuildDone(null)
    await app.close()
  })

  const auth = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const post = (url: string, payload?: object, u: TestUser = user) => app.inject({ method: 'POST', url, headers: auth(u), ...(payload ? { payload } : {}) })
  const importRow = async (id: string) => (await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, id) }))!
  const destByWorld = async () => db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.worldName, WORLD) })
  const depRow = async (id: string) => (await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, id) }))!

  /** A built import of the World for `sceneId` (a new scene by default), its files in the store. */
  async function built(o: { sceneId?: string; files?: Map<string, Uint8Array>; world?: string } = {}) {
    const sceneId = o.sceneId ?? (await createScene(user, 'Cafe')).scene.id
    const [row] = await db.insert(sceneImports).values({
      userId: user.id, sceneId, worldName: o.world ?? WORLD, kind: 'sdk7', sourceKey: 'pending', status: 'built', builtAt: new Date(),
    }).returning()
    const prefix = `imports/${row.id}/built/`
    await db.update(sceneImports).set({ sourceKey: `imports/${row.id}/source.zip`, builtKeyPrefix: prefix }).where(eq(sceneImports.id, row.id))
    for (const [path, bytes] of o.files ?? builtFiles()) await store.put(prefix + path, Buffer.from(bytes), 'application/octet-stream')
    return { id: row.id, sceneId }
  }

  async function grantedDest(sceneId: string, o: Partial<typeof dclWorldDestinations.$inferInsert> = {}) {
    const [d] = await db.insert(dclWorldDestinations).values({
      sceneId, ownerUserId: user.id, ownerWallet: user.wallet!, worldName: WORLD, base: '0,0', parcels: ['0,0', '1,0'],
      mode: 'virvi', grantedAt: new Date(), ...o,
    }).returning()
    return d
  }

  const view = async (id: string) => (await app.inject({ method: 'GET', url: `/api/imports/${id}`, headers: auth(user) })).json().import

  /** An import of the World in `building`, its uploaded source stored, and the token its box holds. */
  async function building(sceneId: string, parcels?: string[], world = WORLD) {
    const started: Record<string, string>[] = []
    const runner: BuildRunner = { async start(_id, env) { started.push(env); return { machineId: 'm1' } }, async stop() {} }
    setBuildRunner(runner)
    const [row] = await db.insert(sceneImports).values({
      userId: user.id, sceneId, worldName: world, kind: 'sdk7', sourceKey: 'pending',
    }).returning()
    const sourceKey = `imports/${row.id}/source.zip`
    await db.update(sceneImports).set({ sourceKey }).where(eq(sceneImports.id, row.id))
    await store.put(sourceKey, Buffer.from(zipSync({ 'scene.json': enc(sceneJson(parcels, undefined, world)), 'src/index.ts': enc('main') })), 'application/zip')
    await startBuild(row.id)
    return { id: row.id, token: started[0].BUILD_TOKEN }
  }
  const postResult = (id: string, token: string, files: Map<string, Uint8Array>) => app.inject({
    method: 'POST', url: `/api/imports/build/${id}/result`, payload: Buffer.from(zipSync(Object.fromEntries(files))),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
  })

  /** The World's last deployment, as its live entity. */
  function goLive(i = worlds.deployed.length - 1) {
    const d = worlds.deployed[i]
    const e = JSON.parse(dec(d.files.get(d.entityId)!))
    const live: LiveEntity = { id: d.entityId, pointers: e.pointers, content: e.content, metadata: e.metadata }
    worlds.entities.set(WORLD, [live])
    return live
  }
  const entityOf = (i = worlds.deployed.length - 1) => {
    const d = worlds.deployed[i]
    return JSON.parse(dec(d.files.get(d.entityId)!)) as { pointers: string[]; content: Array<{ file: string; hash: string }>; metadata: any }
  }

  it('assembleImported builds an entity over exactly the built files', async () => {
    const files = builtFiles()
    const metadata = JSON.parse(sceneJson())
    const a = await assembleImported({ files, metadata, timestamp: 1_700_000_000_000 })
    const entity = JSON.parse(dec(a.files.get(a.entityId)!))
    expect(entity.pointers).toEqual(['0,0', '1,0'])
    expect(entity.timestamp).toBe(1_700_000_000_000)
    expect(entity.metadata).toEqual(metadata)
    const want = await Promise.all([...files].map(async ([file, bytes]) => ({ file, hash: await dclHash(bytes) })))
    expect([...entity.content].sort((x: any, y: any) => x.file.localeCompare(y.file))).toEqual(want.sort((x, y) => x.file.localeCompare(y.file)))
    for (const { hash } of want) expect(a.files.has(hash)).toBe(true)
    expect(a.files.size).toBe(files.size + 1)
    expect(a).toMatchObject({ pointers: ['0,0', '1,0'], existing: [], changed: true, refused: [], added: [] })
    expect(a.deployedFiles).toEqual(['bin/index.js', 'images/virvi/hud-v.png', 'models/tree.glb', 'scene.json'])
  })

  it('a granted World deploys the import Virvi-signed and links the World to the Virvi scene', async () => {
    const { scene } = await createScene(user, 'Cafe')
    const dest = await grantedDest(scene.id, { adopted: false })
    const imp = await built({ sceneId: scene.id })
    await deployImport(imp.id)

    let row = await importRow(imp.id)
    // The upload runs in the background, so it may already have finished
    expect(['deploying', 'deployed']).toContain(row.status)
    expect(row.destinationId).toBe(dest.id)
    expect((await depRow(row.deploymentId!)).destinationId).toBe(dest.id)
    await whenSettled(row.deploymentId!)

    row = await importRow(imp.id)
    expect(row.status).toBe('deployed')
    expect(row.finishedAt).not.toBeNull()
    expect(worlds.deployed).toHaveLength(1)
    expect(chainSigner(worlds.deployed[0].authChain)).toBe(virviSigner()!.address)
    const entity = entityOf()
    expect(entity.content.map((c) => c.file).sort()).toEqual(['bin/index.js', 'images/virvi/hud-v.png', 'models/Tree.glb', 'scene.json'])
    expect(entity.metadata.display.title).toBe('Owner Title')
    expect(dec(worlds.deployed[0].files.get(entity.content.find((c) => c.file === 'bin/index.js')!.hash)!)).toBe('owner code')

    const d = (await destByWorld())!
    expect(d).toMatchObject({ pendingImportId: null, adopted: true, lastEntityId: worlds.deployed[0].entityId, status: 'ok', mode: 'virvi' })
    expect((await depRow(row.deploymentId!)).status).toBe('deployed')
    const as = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, `world:${WORLD}`) })
    expect(as).toMatchObject({ virviSceneId: scene.id, activeEntityId: worlds.deployed[0].entityId })
  })

  it('a finished build of a World without a grant stays built, and nothing is set up before a deploy starts', async () => {
    const imp = await built()
    await deployImport(imp.id)
    expect((await importRow(imp.id)).status).toBe('built')
    expect(await destByWorld()).toBeUndefined()

    await db.delete(sceneImports).where(eq(sceneImports.id, imp.id))
    const signed = await built()
    await grantedDest(signed.sceneId, { mode: 'sign', grantedAt: null })
    await deployImport(signed.id)
    expect((await importRow(signed.id)).status).toBe('built')
    expect((await destByWorld())!.pendingImportId).toBeNull()

    // Virvi mode without the grant is the same
    await db.update(dclWorldDestinations).set({ mode: 'virvi' }).where(eq(dclWorldDestinations.worldName, WORLD))
    await deployImport(signed.id)
    expect((await importRow(signed.id)).status).toBe('built')
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
  })

  it("an ungranted World waits for the owner's signature, then deploys", async () => {
    const imp = await built()
    const r = await post(`/api/imports/${imp.id}/deploy`)
    expect(r.statusCode).toBe(200)
    const { deployment, payload, expiresAt } = r.json()
    expect(deployment.status).toBe('awaiting_signature')
    expect(payload).toBe((deployment.assetBundle as SignedBundle).entityId)
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now())

    let row = await importRow(imp.id)
    expect(row).toMatchObject({ status: 'awaiting_signature', deploymentId: deployment.id })
    const dest = (await destByWorld())!
    expect(dest).toMatchObject({
      id: row.destinationId, sceneId: imp.sceneId, mode: 'sign', adopted: true, pendingImportId: imp.id,
      base: '0,0', parcels: ['0,0', '1,0'], ownerWallet: user.wallet, ownerUserId: user.id,
    })
    expect(worlds.deployed).toHaveLength(0)

    const ok = await post(`/api/deploy/${deployment.id}/signature`, { chain: await chainFor(owner, payload) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().deployment.status).toBe('deployed')
    expect(worlds.deployed).toHaveLength(1)
    expect(chainSigner(worlds.deployed[0].authChain)).toBe(user.wallet)
    expect(worlds.deployed[0].entityId).toBe(payload)
    expect(entityOf().content.map((c) => c.file).sort()).toEqual(['bin/index.js', 'images/virvi/hud-v.png', 'models/Tree.glb', 'scene.json'])
    row = await importRow(imp.id)
    expect(row.status).toBe('deployed')
    expect((await destByWorld())).toMatchObject({ pendingImportId: null, lastEntityId: payload })
  })

  it('the deploy route: importer or full access only, a deployable import only, and a granted World deploys at once', async () => {
    const imp = await built()
    const stranger = await createUser()
    expect((await post(`/api/imports/${imp.id}/deploy`, undefined, stranger)).statusCode).toBe(404)
    expect((await post('/api/imports/not-a-uuid/deploy')).statusCode).toBe(404)

    await db.update(sceneImports).set({ status: 'building' }).where(eq(sceneImports.id, imp.id))
    const busy = await post(`/api/imports/${imp.id}/deploy`)
    expect([busy.statusCode, busy.json().error]).toEqual([409, 'not_deployable'])
    await db.update(sceneImports).set({ status: 'built' }).where(eq(sceneImports.id, imp.id))

    await grantedDest(imp.sceneId)
    const r = await post(`/api/imports/${imp.id}/deploy`)
    expect(r.statusCode).toBe(202)
    expect(r.json().deployment.status).toBe('building')
    expect(['deploying', 'deployed']).toContain((await importRow(imp.id)).status)
    await whenSettled(r.json().deployment.id)
    expect((await importRow(imp.id)).status).toBe('deployed')
  })

  it("a World owned by none of the caller's wallets is refused without starting anything", async () => {
    const imp = await built()
    worlds.deployers.set(WORLD, { owner: '0x' + '1'.repeat(40), deployers: [] })
    const r = await post(`/api/imports/${imp.id}/deploy`)
    expect([r.statusCode, r.json().error]).toEqual([403, 'not_world_owner'])
    expect((await importRow(imp.id)).status).toBe('built')
    expect(await destByWorld()).toBeUndefined()
  })

  it('a signature that expired can be started again; the old deployment can no longer be signed', async () => {
    const imp = await built()
    const first = (await post(`/api/imports/${imp.id}/deploy`)).json()
    // Wind the first deployment's clock back past its signing window
    const old = await depRow(first.deployment.id)
    const bundle = old.assetBundle as SignedBundle
    await db.update(sceneDeployments).set({ assetBundle: { ...bundle, timestamp: bundle.timestamp - DEPLOY_WINDOW_MS - 1000 } })
      .where(eq(sceneDeployments.id, old.id))
    const again = await post(`/api/imports/${imp.id}/deploy`)
    expect(again.statusCode).toBe(200)
    const second = again.json()
    expect(second.deployment.id).not.toBe(first.deployment.id)
    expect((await depRow(first.deployment.id)).status).toBe('failed')
    expect(await importRow(imp.id)).toMatchObject({ status: 'awaiting_signature', deploymentId: second.deployment.id })
    expect((await destByWorld())!.pendingImportId).toBe(imp.id)
    const late = await post(`/api/deploy/${first.deployment.id}/signature`, { chain: await chainFor(owner, first.payload) })
    expect(late.statusCode).toBe(409)
    expect(worlds.deployed).toHaveLength(0)
  })

  it('an import replaces a scene deployed outside Virvi', async () => {
    const { scene } = await createScene(user, 'Cafe')
    const dest = await grantedDest(scene.id, { lastEntityId: 'bafyvirvi', adopted: false })
    const outside: LiveEntity = {
      id: 'bafyoutside', pointers: ['0,0'], content: [{ file: 'bin/index.js', hash: 'bafyx' }],
      metadata: { display: { title: 'Elsewhere' }, scene: { parcels: ['0,0'], base: '0,0' }, main: 'bin/index.js' } as any,
    }
    worlds.entities.set(WORLD, [outside])
    const imp = await built({ sceneId: scene.id })
    await deployImport(imp.id)
    const row = await importRow(imp.id)
    await whenSettled(row.deploymentId!)

    expect((await importRow(imp.id)).status).toBe('deployed')
    expect(worlds.deployed).toHaveLength(1)
    expect((await depRow(row.deploymentId!)).assetBundle).toMatchObject({ baseEntityId: 'bafyoutside' })
    const d = (await destByWorld())!
    expect(d.id).toBe(dest.id)
    expect(d).toMatchObject({ lastEntityId: worlds.deployed[0].entityId, adopted: true, status: 'ok', pendingImportId: null })
  })

  it("a scene over the World's file budget fails the import with scene_too_big (a limit error is permanent)", async () => {
    const { scene } = await createScene(user, 'Cafe')
    await grantedDest(scene.id, { parcels: ['0,0'] })
    const extra: Record<string, Uint8Array> = {}
    for (let i = 0; i < 200; i++) extra[`assets/f${i}.txt`] = enc(`f${i}`)
    const imp = await built({ sceneId: scene.id, files: builtFiles(extra, ['0,0']) })
    await expect(deployImport(imp.id)).rejects.toMatchObject({ code: 'scene_too_big' })
    const row = await importRow(imp.id)
    expect(row.status).toBe('failed')
    expect(row.errorCode).toBe('scene_too_big')
    expect(row.errorMessage).toMatch(/204 files.*200.*1 parcel/)
    expect((await view(imp.id)).canDeploy).toBe(false)
    expect((await destByWorld())!.pendingImportId).toBeNull()
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
    expect(worlds.deployed).toHaveLength(0)
  })

  it("a file over Decentraland's file limit fails with file_too_big, and a full World with world_storage_full", async () => {
    const big = await built({ files: builtFiles({ 'models/huge.glb': new Uint8Array(50 * 1024 * 1024 + 1) }) })
    const r = await post(`/api/imports/${big.id}/deploy`)
    expect([r.statusCode, r.json().error]).toEqual([413, 'file_too_big'])
    expect(await importRow(big.id)).toMatchObject({ status: 'failed', errorCode: 'file_too_big' })
    expect((await importRow(big.id)).errorMessage).toBe("models/huge.glb is 50.0 MB, over Decentraland's 50 MB limit for one file.")

    const imp = await built({ sceneId: big.sceneId })
    worlds.stats.set(user.wallet!, { maxAllowedBytes: 100, usedBytes: 90 })
    const full = await post(`/api/imports/${imp.id}/deploy`)
    expect([full.statusCode, full.json().error]).toEqual([413, 'world_storage_full'])
    expect(await importRow(imp.id)).toMatchObject({ status: 'failed', errorCode: 'world_storage_full' })
    expect((await importRow(imp.id)).errorMessage).toMatch(/MB of World storage/)
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
  })

  it('after an import, a HUD-placed model redeploys only models/virvi files', async () => {
    const { scene, preset } = await createScene(user, 'Virvi Name')
    const dest = await grantedDest(scene.id)
    const imp = await built({ sceneId: scene.id })
    await deployImport(imp.id)
    await whenSettled((await importRow(imp.id)).deploymentId!)
    const first = goLive()

    await createElement(preset.id, { type: 'model', name: 'a', properties: { modelSrc: `${CDN}/m/a.glb` } })
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    expect((await depRow(dep.id)).status).toBe('deployed')
    expect(worlds.deployed).toHaveLength(2)

    const next = entityOf(1)
    const sent = worlds.deployed[1]
    // Only the model is uploaded; every built file stays by hash
    const uploaded = next.content.filter((c) => sent.files.has(c.hash)).map((c) => c.file)
    expect(uploaded).toEqual(['models/virvi/a.glb'])
    for (const c of first.content) expect(next.content).toContainEqual(c)
    expect(next.metadata.display.title).toBe('Owner Title')
    expect(next.metadata).toEqual(first.metadata)
    expect((await destByWorld())!.adopted).toBe(true)
  })

  describe('a deploy that fails before the World accepts it puts the import back to built (Ruling R19)', () => {
    /** A granted World's automatic deploy, run to its end. */
    async function autoDeploy() {
      const { scene } = await createScene(user, 'Cafe')
      await grantedDest(scene.id)
      const imp = await built({ sceneId: scene.id })
      await deployImport(imp.id)
      const depId = (await importRow(imp.id)).deploymentId!
      await whenSettled(depId)
      return { imp, depId }
    }

    it('Virvi-signed: Decentraland refusing the upload', async () => {
      worlds.failNext = new WorldsError(400, JSON.stringify({ message: 'scene.json is wrong' }))
      const { imp, depId } = await autoDeploy()
      const dep = await depRow(depId)
      expect(dep.status).toBe('failed')
      const row = await importRow(imp.id)
      expect(row).toMatchObject({ status: 'built', errorMessage: dep.errorMessage, deploymentId: depId, finishedAt: null })
      expect(row.errorMessage).toMatch(/Decentraland rejected the deploy: scene\.json is wrong/)
      expect((await view(imp.id)).canDeploy).toBe(true)
      expect((await destByWorld())!.pendingImportId).toBeNull()

      // And Deploy works again
      const again = await post(`/api/imports/${imp.id}/deploy`)
      expect(again.statusCode).toBe(202)
      await whenSettled(again.json().deployment.id)
      expect((await importRow(imp.id)).status).toBe('deployed')
    })

    it("Virvi-signed: the Worlds server unreachable or timing out", async () => {
      worlds.failNext = new WorldsError(0, '', 'timed out')
      const { imp } = await autoDeploy()
      expect(await importRow(imp.id)).toMatchObject({ status: 'built', errorMessage: "Couldn't reach Decentraland's Worlds server. Try again in a minute." })
      expect((await view(imp.id)).canDeploy).toBe(true)
    })

    it('Virvi-signed: built files gone by the time it packs is permanent', async () => {
      const real = store.get.bind(store)
      store.get = async (key: string) => (key.endsWith('/built/bin/index.js') ? null : real(key))
      const { imp } = await autoDeploy()
      expect(await importRow(imp.id)).toMatchObject({ status: 'failed', errorCode: 'import_files_missing' })
      expect((await view(imp.id)).canDeploy).toBe(false)
      expect(worlds.deployed).toHaveLength(0)
    })

    it('owner-signed: the Worlds server unreachable at submit, then signed again', async () => {
      const imp = await built()
      const { deployment, payload } = (await post(`/api/imports/${imp.id}/deploy`)).json()
      worlds.failNext = new WorldsError(0, '', 'timed out')
      const r = await post(`/api/deploy/${deployment.id}/signature`, { chain: await chainFor(owner, payload) })
      expect(r.statusCode).toBe(502)
      expect(await importRow(imp.id)).toMatchObject({ status: 'built', deploymentId: deployment.id })
      expect((await view(imp.id)).canDeploy).toBe(true)
      expect((await destByWorld())!.pendingImportId).toBeNull()

      const again = (await post(`/api/imports/${imp.id}/deploy`)).json()
      const ok = await post(`/api/deploy/${again.deployment.id}/signature`, { chain: await chainFor(owner, again.payload) })
      expect(ok.statusCode).toBe(200)
      expect((await importRow(imp.id)).status).toBe('deployed')
    })

    it('owner-signed: the World changed before the signature came (stale) says to press Deploy', async () => {
      const imp = await built()
      const { deployment, payload } = (await post(`/api/imports/${imp.id}/deploy`)).json()
      worlds.entities.set(WORLD, [{ id: 'bafyelse', pointers: ['0,0'], content: [], metadata: {} as any }])
      const r = await post(`/api/deploy/${deployment.id}/signature`, { chain: await chainFor(owner, payload) })
      expect([r.statusCode, r.json().error]).toEqual([409, 'stale'])
      const row = await importRow(imp.id)
      expect(row).toMatchObject({ status: 'built', errorCode: 'stale' })
      expect(row.errorMessage).toMatch(/Press Deploy to sign again/)
      expect((await view(imp.id)).canDeploy).toBe(true)
    })

    it('owner-signed: a signature that came too late says to press Deploy', async () => {
      const imp = await built()
      const { deployment, payload } = (await post(`/api/imports/${imp.id}/deploy`)).json()
      const bundle = (await depRow(deployment.id)).assetBundle as SignedBundle
      await db.update(sceneDeployments).set({ assetBundle: { ...bundle, timestamp: bundle.timestamp - DEPLOY_WINDOW_MS - 1000 } })
        .where(eq(sceneDeployments.id, deployment.id))
      const r = await post(`/api/deploy/${deployment.id}/signature`, { chain: await chainFor(owner, payload) })
      expect([r.statusCode, r.json().error]).toEqual([409, 'expired'])
      expect(r.json().message).toMatch(/Press Deploy to sign again/)
      expect((await view(imp.id)).canDeploy).toBe(true)
    })

    it('owner-signed: built files gone at submit is permanent', async () => {
      const imp = await built()
      const { deployment, payload } = (await post(`/api/imports/${imp.id}/deploy`)).json()
      await store.deletePrefix(`imports/${imp.id}/built/`)
      const r = await post(`/api/deploy/${deployment.id}/signature`, { chain: await chainFor(owner, payload) })
      expect([r.statusCode, r.json().error]).toEqual([409, 'import_files_missing'])
      expect(await importRow(imp.id)).toMatchObject({ status: 'failed', errorCode: 'import_files_missing' })
      expect((await view(imp.id)).canDeploy).toBe(false)
    })

    it('an interrupted deploy (reconcile) puts the import back to built with a sentence for the Import page', async () => {
      const { scene } = await createScene(user, 'Cafe')
      const dest = await grantedDest(scene.id)
      const imp = await built({ sceneId: scene.id })
      const old = new Date(Date.now() - DEPLOY_WINDOW_MS - 60_000)
      const [dep] = await db.insert(sceneDeployments).values({
        sceneId: scene.id, platform: 'decentraland', deploymentType: 'world', destinationId: dest.id, target: {}, status: 'deploying',
        createdAt: old, assetBundle: { entityId: 'bafynever' },
      }).returning()
      await db.update(sceneImports).set({ status: 'deploying', deploymentId: dep.id }).where(eq(sceneImports.id, imp.id))
      await db.update(dclWorldDestinations).set({ pendingImportId: imp.id }).where(eq(dclWorldDestinations.id, dest.id))
      await reconcileStaleDeployments()
      const row = await importRow(imp.id)
      expect(row).toMatchObject({ status: 'built', deploymentId: dep.id })
      expect(row.errorMessage).toMatch(/Press Deploy to try again/)
      expect(row.errorMessage).not.toMatch(/Upload/)
      expect((await destByWorld())!.pendingImportId).toBeNull()
    })

    it('a cancelled deployment and a deployment with nothing to deploy never leave the import deploying', async () => {
      const { scene } = await createScene(user, 'Cafe')
      const dest = await grantedDest(scene.id)
      for (const end of ['cancel', 'noop'] as const) {
        const imp = await built({ sceneId: scene.id })
        const [dep] = await db.insert(sceneDeployments).values({
          sceneId: scene.id, platform: 'decentraland', deploymentType: 'world', destinationId: dest.id, target: {}, status: 'building',
        }).returning()
        await db.update(sceneImports).set({ status: 'deploying', deploymentId: dep.id }).where(eq(sceneImports.id, imp.id))
        await db.update(dclWorldDestinations).set({ pendingImportId: imp.id }).where(eq(dclWorldDestinations.id, dest.id))
        if (end === 'cancel') {
          expect((await post(`/api/deploy/${dep.id}/cancel`)).statusCode).toBe(200)
        } else {
          await markFailed(dep.id, new DeployerError(409, 'nothing_to_deploy', 'Your World already has everything in this scene, so there was nothing to deploy.'))
        }
        expect((await depRow(dep.id)).status).toBe('failed')
        expect(await importRow(imp.id)).toMatchObject({ status: 'built', deploymentId: dep.id })
        expect((await view(imp.id)).canDeploy).toBe(true)
        expect((await destByWorld())!.pendingImportId).toBeNull()
        await db.update(sceneImports).set({ status: 'failed' }).where(eq(sceneImports.id, imp.id))
      }
    })
  })

  it('an import claimed by the automatic deploy that never got a deployment is swept back to built after 5 minutes', async () => {
    const imp = await built()
    await grantedDest(imp.sceneId, { pendingImportId: imp.id })
    const fresh = await built()
    const linked = await built()
    const now = new Date()
    const old = new Date(now.getTime() - 6 * 60_000)
    await db.update(sceneImports).set({ status: 'deploying', updatedAt: old }).where(eq(sceneImports.id, imp.id))
    await db.update(sceneImports).set({ status: 'deploying', updatedAt: new Date(now.getTime() - 60_000) }).where(eq(sceneImports.id, fresh.id))
    const [dep] = await db.insert(sceneDeployments).values({
      sceneId: linked.sceneId, platform: 'decentraland', deploymentType: 'world', target: {}, status: 'deploying',
    }).returning()
    await db.update(sceneImports).set({ status: 'deploying', deploymentId: dep.id, updatedAt: old }).where(eq(sceneImports.id, linked.id))

    await sweepBuilds(now)
    const row = await importRow(imp.id)
    expect(row).toMatchObject({ status: 'built', deploymentId: null })
    expect(row.errorMessage).toMatch(/interrupted before the deploy started\. Press Deploy to try again/)
    expect((await view(imp.id)).canDeploy).toBe(true)
    expect((await destByWorld())!.pendingImportId).toBeNull()
    expect((await importRow(fresh.id)).status).toBe('deploying')
    expect((await importRow(linked.id)).status).toBe('deploying')
  })

  it('a superseded sign-pending import never deploys, even with its signature inside the window', async () => {
    const imp = await built()
    const { deployment, payload } = (await post(`/api/imports/${imp.id}/deploy`)).json()
    await createImport({ userId: user.id, world: WORLD, kind: 'sdk7', scene: { id: imp.sceneId } })

    expect(await importRow(imp.id)).toMatchObject({ status: 'failed', errorCode: 'superseded' })
    expect(await depRow(deployment.id)).toMatchObject({ status: 'failed', errorMessage: SUPERSEDED_MESSAGE })
    expect((await destByWorld())!.pendingImportId).toBeNull()

    const r = await post(`/api/deploy/${deployment.id}/signature`, { chain: await chainFor(owner, payload) })
    expect(r.statusCode).toBe(409)
    expect(worlds.deployed).toHaveLength(0)
  })

  it('the signed submit refuses a deployment whose import no longer waits for it', async () => {
    const imp = await built()
    const { deployment, payload } = (await post(`/api/imports/${imp.id}/deploy`)).json()
    // As if the supersede landed but the deployment row has not been failed yet
    await db.update(sceneImports).set({ status: 'failed', errorCode: 'superseded' }).where(eq(sceneImports.id, imp.id))
    const r = await post(`/api/deploy/${deployment.id}/signature`, { chain: await chainFor(owner, payload) })
    expect([r.statusCode, r.json().error]).toEqual([409, 'import_superseded'])
    expect(worlds.deployed).toHaveLength(0)
    expect((await depRow(deployment.id)).status).toBe('failed')
    expect((await destByWorld())!.pendingImportId).toBeNull()
  })

  it('a superseded import is not deployed when its build finishes', async () => {
    const imp = await built()
    await grantedDest(imp.sceneId)
    await db.update(sceneImports).set({ status: 'failed', errorCode: 'superseded' }).where(eq(sceneImports.id, imp.id))
    await deployImport(imp.id)
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
    expect((await destByWorld())!.pendingImportId).toBeNull()
  })

  it("a deploy that won't start after a build puts the import back to built, and the build result is still accepted", async () => {
    setOnBuildDone(deployImport)
    const { scene } = await createScene(user, 'Cafe')
    await grantedDest(scene.id, { parcels: ['0,0'] })
    const { id, token } = await building(scene.id, ['0,0'])
    worlds.down = true
    const r = await postResult(id, token, builtFiles({}, ['0,0']))
    expect(r.statusCode).toBe(204)
    await vi.waitFor(async () => expect((await importRow(id)).errorCode).toBe('world_unreachable'))
    expect(await importRow(id)).toMatchObject({ status: 'built', builtKeyPrefix: `imports/${id}/built/` })
    expect((await view(id)).canDeploy).toBe(true)
  })

  it('a build that renames the World is refused at the result, and nothing is signed', async () => {
    setOnBuildDone(deployImport)
    const { scene } = await createScene(user, 'Cafe')
    await grantedDest(scene.id)
    const { id, token } = await building(scene.id)
    const files = builtFiles()
    files.set('scene.json', enc(sceneJson(undefined, undefined, 'victim.dcl.eth')))
    const r = await postResult(id, token, files)
    expect(r.statusCode).toBe(422)
    const row = await importRow(id)
    expect(row).toMatchObject({ status: 'failed', errorCode: 'build_failed' })
    expect((await store.get(`imports/${id}/build.log`))!.body.toString()).toMatch(/changed the World in scene\.json from cafe\.dcl\.eth to victim\.dcl\.eth/)
    expect(store.keys().filter((k) => k.includes('/built/'))).toEqual([])
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
    expect(worlds.deployed).toHaveLength(0)
  })

  it("a build that moves the scene's parcels or base is refused at the result", async () => {
    for (const parcels of [['0,0', '0,1'], ['1,0', '0,0']]) {
      const { scene } = await createScene(user, 'Cafe')
      const { id, token } = await building(scene.id)
      const r = await postResult(id, token, builtFiles({}, parcels))
      expect(r.statusCode).toBe(422)
      expect(await importRow(id)).toMatchObject({ status: 'failed', errorCode: 'build_failed' })
      expect((await store.get(`imports/${id}/build.log`))!.body.toString()).toMatch(/changed scene\.parcels or scene\.base/)
    }
  })

  it('a stored build naming another World never reaches the signer', async () => {
    const files = builtFiles()
    files.set('scene.json', enc(sceneJson(undefined, undefined, 'victim.dcl.eth')))
    const { scene } = await createScene(user, 'Cafe')
    await grantedDest(scene.id)
    const imp = await built({ sceneId: scene.id, files })
    await expect(deployImport(imp.id)).rejects.toMatchObject({ code: 'world_changed' })
    expect(await importRow(imp.id)).toMatchObject({ status: 'failed', errorCode: 'world_changed' })

    await db.delete(dclWorldDestinations)
    const signed = await built({ files })
    const r = await post(`/api/imports/${signed.id}/deploy`)
    expect([r.statusCode, r.json().error]).toEqual([422, 'world_changed'])
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
    expect(worlds.deployed).toHaveLength(0)
  })

  it("a re-imported wizard download keeps the creator's code and title across a HUD redeploy and a rebase", async () => {
    const { scene, preset } = await createScene(user, 'Virvi Name')
    const dest = await grantedDest(scene.id)
    const wizard = JSON.parse(sceneJson())
    wizard.virvi = { runtime: 1, apiUrl: 'https://api.virvi.test', wssUrl: 'wss://api.virvi.test' }
    const files = builtFiles()
    files.set('scene.json', enc(JSON.stringify(wizard)))
    files.set('bin/index.js', enc('creator code'))
    const imp = await built({ sceneId: scene.id, files })
    await deployImport(imp.id)
    await whenSettled((await importRow(imp.id)).deploymentId!)
    expect((await importRow(imp.id)).status).toBe('deployed')
    const first = goLive()
    expect(first.metadata.virvi).toBeUndefined()

    await createElement(preset.id, { type: 'model', name: 'a', properties: { modelSrc: `${CDN}/m/a.glb` } })
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    expect((await depRow(dep.id)).status).toBe('deployed')
    const next = entityOf(1)
    const code = (e: { content: Array<{ file: string; hash: string }> }) => e.content.find((c) => c.file === 'bin/index.js')!.hash
    expect(code(next)).toBe(code(first))
    expect(code(next)).toBe(await dclHash(enc('creator code')))
    expect(next.metadata.display.title).toBe('Owner Title')
    expect(next.metadata.virvi).toBeUndefined()
    expect((await destByWorld())!.adopted).toBe(true)

    goLive(1)
    const rebase = await post(`/api/dcl/destinations/${dest.id}/rebase`)
    expect(rebase.statusCode).toBe(200)
    expect((await destByWorld())!.adopted).toBe(true)
  })

  it('a deploy that finds another deploy running puts the import back to built (automatic path)', async () => {
    const { scene } = await createScene(user, 'Cafe')
    const dest = await grantedDest(scene.id)
    await db.insert(sceneDeployments).values({
      sceneId: scene.id, platform: 'decentraland', deploymentType: 'world', destinationId: dest.id, target: {}, status: 'building',
    })
    const imp = await built({ sceneId: scene.id })
    await expect(deployImport(imp.id)).rejects.toMatchObject({ code: 'deploy_in_progress' })
    expect(await importRow(imp.id)).toMatchObject({ status: 'built', errorCode: 'deploy_in_progress', errorMessage: 'A deploy is already running for this World' })
    expect((await view(imp.id)).canDeploy).toBe(true)
    expect((await destByWorld())!.pendingImportId).toBeNull()
  })

  it('an automatic deploy claims the import first: deploying, not deployable, and an upload refused, before the World is asked (Ruling R24)', async () => {
    const { scene } = await createScene(user, 'Cafe')
    await grantedDest(scene.id)
    const imp = await built({ sceneId: scene.id })
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let asked!: () => void
    const reached = new Promise<void>((r) => { asked = r })
    const real = worlds.getDeployers.bind(worlds)
    worlds.getDeployers = async (world: string) => { asked(); await held; return real(world) }

    const running = deployImport(imp.id)
    await reached
    const v = await view(imp.id)
    expect(v).toMatchObject({ status: 'deploying', canDeploy: false, deploymentId: null })
    const click = await post(`/api/imports/${imp.id}/deploy`)
    expect([click.statusCode, click.json().error]).toEqual([409, 'not_deployable'])
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
    await expect(createImport({ userId: user.id, world: WORLD, kind: 'sdk7', scene: { id: scene.id } })).rejects.toMatchObject({ code: 'import_in_progress' })

    release()
    await running
    const row = await importRow(imp.id)
    await whenSettled(row.deploymentId!)
    expect((await importRow(imp.id)).status).toBe('deployed')
    expect(worlds.deployed).toHaveLength(1)
  })

  it('an automatic deploy that fails before the World accepts goes from deploying back to built', async () => {
    const { scene } = await createScene(user, 'Cafe')
    await grantedDest(scene.id)
    const imp = await built({ sceneId: scene.id })
    let seen: string | undefined
    const real = worlds.getDeployers.bind(worlds)
    worlds.getDeployers = async (world: string) => {
      seen = (await importRow(imp.id)).status
      worlds.down = true
      try { return await real(world) } finally { worlds.down = false }
    }
    await expect(deployImport(imp.id)).rejects.toMatchObject({ code: 'world_unreachable' })
    expect(seen).toBe('deploying')
    expect(await importRow(imp.id)).toMatchObject({ status: 'built', errorCode: 'world_unreachable', deploymentId: null })
    expect((await view(imp.id)).canDeploy).toBe(true)
    expect((await destByWorld())!.pendingImportId).toBeNull()

    // A build that can't work still fails the import
    await store.deletePrefix(`imports/${imp.id}/built/`)
    worlds.getDeployers = real
    await expect(deployImport(imp.id)).rejects.toMatchObject({ code: 'import_files_missing' })
    expect(await importRow(imp.id)).toMatchObject({ status: 'failed', errorCode: 'import_files_missing' })
  })

  it("a World that doesn't answer puts the import back to built (route), and missing built files fail it", async () => {
    const imp = await built()
    worlds.down = true
    const r = await post(`/api/imports/${imp.id}/deploy`)
    expect([r.statusCode, r.json().error]).toEqual([502, 'world_unreachable'])
    expect(await importRow(imp.id)).toMatchObject({ status: 'built', errorCode: 'world_unreachable' })
    expect((await view(imp.id)).canDeploy).toBe(true)
    worlds.down = false

    await store.deletePrefix(`imports/${imp.id}/built/`)
    const gone = await post(`/api/imports/${imp.id}/deploy`)
    expect([gone.statusCode, gone.json().error]).toEqual([409, 'import_files_missing'])
    expect(await importRow(imp.id)).toMatchObject({ status: 'failed', errorCode: 'import_files_missing' })
    expect((await importRow(imp.id)).errorMessage).toMatch(/Upload it again/)
    expect((await view(imp.id)).canDeploy).toBe(false)
  })
  describe('a World name that only matches once lower-cased (the Kelvin sign folds to k)', () => {
    const KIOSK = 'kiosk.dcl.eth'
    const KELVIN = '\u212Aiosk.dcl.eth'
    beforeEach(() => { worlds.deployers.set(KIOSK, { owner: user.wallet, deployers: [] }) })
    const kelvinFiles = () => builtFiles({}, undefined, KELVIN)

    it('is refused at the build result', async () => {
      const { scene } = await createScene(user, 'Kiosk')
      const { id, token } = await building(scene.id, undefined, KIOSK)
      const r = await postResult(id, token, kelvinFiles())
      expect(r.statusCode).toBe(422)
      expect(await importRow(id)).toMatchObject({ status: 'failed', errorCode: 'build_failed' })
    })

    it('is refused when the deploy starts (builtPlot)', async () => {
      const imp = await built({ world: KIOSK, files: kelvinFiles() })
      const r = await post(`/api/imports/${imp.id}/deploy`)
      expect([r.statusCode, r.json().error]).toEqual([422, 'world_changed'])
      expect(await db.select().from(sceneDeployments)).toHaveLength(0)
    })

    it('is refused when the deployment is assembled', async () => {
      const imp = await built({ world: KIOSK, files: kelvinFiles() })
      const [dest] = await db.insert(dclWorldDestinations).values({
        sceneId: imp.sceneId, ownerUserId: user.id, ownerWallet: user.wallet!, worldName: KIOSK, base: '0,0', parcels: ['0,0', '1,0'],
        mode: 'sign', adopted: true, pendingImportId: imp.id,
      }).returning()
      await expect(prepareSignedDeploy(dest.id, user.id)).rejects.toMatchObject({ code: 'world_changed' })
      expect(worlds.deployed).toHaveLength(0)
    })

    it('is refused at the signed submit', async () => {
      const imp = await built({ world: KIOSK, files: builtFiles({}, undefined, KIOSK) })
      const { deployment, payload } = (await post(`/api/imports/${imp.id}/deploy`)).json()
      const dep = await depRow(deployment.id)
      const bundle = dep.assetBundle as SignedBundle
      const metadata = JSON.parse(bundle.metadataJson)
      metadata.worldConfiguration.name = KELVIN
      await db.update(sceneDeployments).set({ assetBundle: { ...bundle, metadataJson: JSON.stringify(metadata) } }).where(eq(sceneDeployments.id, dep.id))
      const r = await post(`/api/deploy/${deployment.id}/signature`, { chain: await chainFor(owner, payload) })
      expect([r.statusCode, r.json().error]).toEqual([422, 'world_changed'])
      expect(worlds.deployed).toHaveLength(0)
    })
  })
  describe('models placed in-world ride along with the import', () => {
    const fileOf = (e: ReturnType<typeof entityOf>, file: string) => e.content.find((c) => c.file === file)

    it('a first import into a World whose scene has a placed model keeps the model, then a re-upload keeps it too', async () => {
      const { scene, preset } = await createScene(user, 'Cafe')
      await grantedDest(scene.id)
      await createElement(preset.id, { type: 'model', name: 'a', properties: { modelSrc: `${CDN}/m/a.glb` } })
      const first = await built({ sceneId: scene.id })
      await deployImport(first.id, { fetch: fetcher })
      await whenSettled((await importRow(first.id)).deploymentId!)
      expect((await importRow(first.id)).status).toBe('deployed')
      const one = entityOf()
      expect(fileOf(one, 'models/virvi/a.glb')?.hash).toBe(await dclHash(enc(`bytes of ${CDN}/m/a.glb`)))
      expect(fileOf(one, 'bin/index.js')).toBeDefined()
      expect((await destByWorld())!.deployedFiles).toContain('models/virvi/a.glb')
      goLive()

      const again = await built({ sceneId: scene.id, files: builtFiles({ 'bin/index.js': enc('owner code v2') }) })
      await deployImport(again.id, { fetch: fetcher })
      await whenSettled((await importRow(again.id)).deploymentId!)
      expect((await importRow(again.id)).status).toBe('deployed')
      const two = entityOf()
      expect(worlds.deployed).toHaveLength(2)
      expect(fileOf(two, 'models/virvi/a.glb')?.hash).toBe(await dclHash(enc(`bytes of ${CDN}/m/a.glb`)))
      expect(fileOf(two, 'bin/index.js')?.hash).toBe(await dclHash(enc('owner code v2')))
    })

    it('the owner-signed path carries the model through the signature', async () => {
      const { scene, preset } = await createScene(user, 'Cafe')
      await createElement(preset.id, { type: 'model', name: 'a', properties: { modelSrc: `${CDN}/m/a.glb` } })
      const imp = await built({ sceneId: scene.id })
      const started = await startImportDeploy(await importRow(imp.id), user.id, { fetch: fetcher })
      expect(started?.mode).toBe('sign')
      const { deployment, payload } = started as Extract<typeof started, { mode: 'sign' }>
      await submitSignedDeploy(deployment.id, await chainFor(owner, payload), { fetch: fetcher })
      expect((await importRow(imp.id)).status).toBe('deployed')
      expect(fileOf(entityOf(), 'models/virvi/a.glb')?.hash).toBe(await dclHash(enc(`bytes of ${CDN}/m/a.glb`)))
    })

    it('a built file at the same path wins, and a refused model is left out as in a redeploy', async () => {
      const { scene, preset } = await createScene(user, 'Cafe')
      await grantedDest(scene.id)
      await createElement(preset.id, { type: 'model', name: 'a', properties: { modelSrc: `${CDN}/m/a.glb` } })
      await createElement(preset.id, { type: 'model', name: 'b', properties: { modelSrc: `${CDN}/m/b.glb` } })
      const failing = vi.fn(async (url: string) => {
        if (url.endsWith('/b.glb')) throw new ModelRefused('Model download failed (404)')
        return enc(`bytes of ${url}`)
      })
      const imp = await built({ sceneId: scene.id, files: builtFiles({ 'models/virvi/a.glb': enc('built a') }) })
      await deployImport(imp.id, { fetch: failing })
      const depId = (await importRow(imp.id)).deploymentId!
      await whenSettled(depId)
      expect((await importRow(imp.id)).status).toBe('deployed')
      const e = entityOf()
      expect(fileOf(e, 'models/virvi/a.glb')?.hash).toBe(await dclHash(enc('built a')))
      expect(fileOf(e, 'models/virvi/b.glb')).toBeUndefined()
      expect(failing).not.toHaveBeenCalledWith(`${CDN}/m/a.glb`)
      expect((await depRow(depId)).assetBundle).toMatchObject({ refused: [{ name: 'b', file: 'models/virvi/b.glb' }] })
    })

    it("the file budget and the storage check count the scene's models too", async () => {
      const { scene, preset } = await createScene(user, 'Cafe')
      await createElement(preset.id, { type: 'model', name: 'a', properties: { modelSrc: `${CDN}/m/a.glb` } })
      const extra: Record<string, Uint8Array> = {}
      for (let i = 0; i < 196; i++) extra[`assets/f${i}.txt`] = enc(`f${i}`)
      const crowded = await built({ sceneId: scene.id, files: builtFiles(extra, ['0,0']) })
      await grantedDest(scene.id, { parcels: ['0,0'] })
      await expect(deployImport(crowded.id, { fetch: fetcher })).rejects.toMatchObject({ code: 'scene_too_big' })
      expect((await importRow(crowded.id)).errorMessage).toMatch(/201 files/)

      await db.delete(dclWorldDestinations)
      await db.insert(assetLibraryItems).values({ name: 'a', storageKey: 'm/a.glb', cdnUrl: `${CDN}/m/a.glb`, fileSizeBytes: 1_000_000 })
      const small = await built({ sceneId: scene.id })
      const builtBytes = [...builtFiles().values()].reduce((n, b) => n + b.byteLength, 0)
      // Room for the built files, not for the model as well
      worlds.stats.set(user.wallet!, { maxAllowedBytes: builtBytes + 500_000, usedBytes: 0 })
      const r = await post(`/api/imports/${small.id}/deploy`)
      expect([r.statusCode, r.json().error]).toEqual([413, 'world_storage_full'])
    })
  })
  describe('the placements snapshot (LIV-135 part 3)', () => {
    const fileOf = (e: ReturnType<typeof entityOf>, file: string) => e.content.find((c) => c.file === file)
    /** The deployment's placements file, decoded; null when it has none. */
    function placementsOf(i = worlds.deployed.length - 1) {
      const d = worlds.deployed[i]
      const ref = fileOf(entityOf(i), PLACEMENTS_FILE)
      if (!ref) return null
      const bytes = d.files.get(ref.hash) ?? worlds.contents.get(ref.hash)
      return bytes ? decodePlacements(dec(bytes)) : null
    }
    /** A scene with model `a` placed once. */
    async function placedScene() {
      const { scene, preset } = await createScene(user, 'Cafe')
      const el = await createElement(preset.id, { type: 'model', name: 'a', properties: { modelSrc: `${CDN}/m/a.glb` } })
      const copy = await createInstance(el.id)
      return { scene, preset, el, copy }
    }

    it("a Virvi-signed import carries virvi/placements.json for its placed Virvi models; the owner's files and scene.json deploy as built, and the map checks start", async () => {
      const { scene, copy } = await placedScene()
      await grantedDest(scene.id)
      const imp = await built({ sceneId: scene.id })
      await deployImport(imp.id, { fetch: fetcher })
      await whenSettled((await importRow(imp.id)).deploymentId!)
      expect((await importRow(imp.id)).status).toBe('deployed')
      const e = entityOf()
      expect(placementsOf()).toEqual([expect.objectContaining({ instanceId: copy.id, src: 'models/virvi/a.glb', position: { x: 1, y: 1, z: 1 } })])
      expect(e.metadata).toEqual(JSON.parse(sceneJson()))
      for (const [file, bytes] of builtFiles()) expect(fileOf(e, file)?.hash).toBe(await dclHash(bytes))
      const dest = (await destByWorld())!
      expect(dest.deployedFiles).toContain(PLACEMENTS_FILE)
      expect([dest.mapStatus, dest.mapEntityId]).toEqual(['pending', worlds.deployed[0].entityId])
    })

    it('an import with no placed Virvi model deploys no snapshot', async () => {
      const { scene, preset } = await createScene(user, 'Cafe')
      await createElement(preset.id, { type: 'model', name: 'a', properties: { modelSrc: `${CDN}/m/a.glb` } })
      await grantedDest(scene.id)
      const imp = await built({ sceneId: scene.id })
      await deployImport(imp.id, { fetch: fetcher })
      await whenSettled((await importRow(imp.id)).deploymentId!)
      expect(fileOf(entityOf(), PLACEMENTS_FILE)).toBeUndefined()
    })

    it("the owner-signed path keeps the snapshot inline through the signature, and replaces one carried in the upload", async () => {
      const { scene, copy } = await placedScene()
      const stale = encodePlacements([{ instanceId: 'old', elementId: 'x', src: 'models/virvi/a.glb', position: { x: 9, y: 9, z: 9 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, collisions: false }])
      const imp = await built({ sceneId: scene.id, files: builtFiles({ [PLACEMENTS_FILE]: enc(stale) }) })
      const started = await startImportDeploy(await importRow(imp.id), user.id, { fetch: fetcher })
      const { deployment, payload } = started as Extract<typeof started, { mode: 'sign' }>
      const bundle = (await depRow(deployment.id)).assetBundle as SignedBundle
      const src = bundle.newFiles.find((f) => f.file === PLACEMENTS_FILE)!
      expect('base64' in src && decodePlacements(Buffer.from(src.base64, 'base64').toString('utf8')).map((p) => p.instanceId)).toEqual([copy.id])
      await submitSignedDeploy(deployment.id, await chainFor(owner, payload), { fetch: fetcher })
      expect((await importRow(imp.id)).status).toBe('deployed')
      expect(placementsOf()!.map((p) => p.instanceId)).toEqual([copy.id])
      expect(entityOf().content.filter((c) => c.file.toLowerCase() === PLACEMENTS_FILE)).toHaveLength(1)
    })

    it('counts toward the file budget, once even when the upload carries its own copy', async () => {
      const { scene } = await placedScene()
      const extra: Record<string, Uint8Array> = {}
      for (let i = 0; i < 195; i++) extra[`assets/f${i}.txt`] = enc(`f${i}`)
      // 4 built + 195 + model a = 200 (the budget), + the snapshot = 201
      const crowded = await built({ sceneId: scene.id, files: builtFiles(extra, ['0,0']) })
      await grantedDest(scene.id, { parcels: ['0,0'] })
      await expect(deployImport(crowded.id, { fetch: fetcher })).rejects.toMatchObject({ code: 'scene_too_big' })
      expect((await importRow(crowded.id)).errorMessage).toMatch(/201 files/)

      // An upload carrying Virvi's file has it replaced, not added: 4 + 194 + its copy + model a + the snapshot = 200
      delete extra['assets/f194.txt']
      const fits = await built({ sceneId: scene.id, files: builtFiles({ ...extra, [PLACEMENTS_FILE]: enc('{"v":1,"models":[]}') }, ['0,0']) })
      await deployImport(fits.id, { fetch: fetcher })
      await whenSettled((await importRow(fits.id)).deploymentId!)
      expect((await importRow(fits.id)).status).toBe('deployed')
      expect(entityOf().content).toHaveLength(200)
    })

    it('counts toward the World storage check', async () => {
      const { scene } = await placedScene()
      await db.insert(assetLibraryItems).values({ name: 'a', storageKey: 'm/a.glb', cdnUrl: `${CDN}/m/a.glb`, fileSizeBytes: 1000 })
      const snapshot = placementsFile(await placementsInScene(scene.id), ['models/virvi/a.glb'])!.byteLength
      const need = [...builtFiles().values()].reduce((n, b) => n + b.byteLength, 0) + 1000 + snapshot
      await grantedDest(scene.id)
      const short = await built({ sceneId: scene.id })
      worlds.stats.set(user.wallet!, { maxAllowedBytes: need - 1, usedBytes: 0 })
      await expect(deployImport(short.id, { fetch: fetcher })).rejects.toMatchObject({ code: 'world_storage_full' })
      const fits = await built({ sceneId: scene.id })
      worlds.stats.set(user.wallet!, { maxAllowedBytes: need, usedBytes: 0 })
      await deployImport(fits.id, { fetch: fetcher })
      await whenSettled((await importRow(fits.id)).deploymentId!)
      expect((await importRow(fits.id)).status).toBe('deployed')
    })

    it('after an import, a model placed in-world redeploys with the snapshot; a move alone redeploys nothing', async () => {
      const { scene, preset } = await createScene(user, 'Cafe')
      const dest = await grantedDest(scene.id)
      const imp = await built({ sceneId: scene.id })
      await deployImport(imp.id, { fetch: fetcher })
      await whenSettled((await importRow(imp.id)).deploymentId!)
      const first = goLive()
      expect(fileOf(entityOf(), PLACEMENTS_FILE)).toBeUndefined()

      const el = await createElement(preset.id, { type: 'model', name: 'a', properties: { modelSrc: `${CDN}/m/a.glb` } })
      const copy = await createInstance(el.id)
      const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
      await whenSettled(dep.id)
      expect((await depRow(dep.id)).status).toBe('deployed')
      const next = entityOf()
      expect(placementsOf()!.map((p) => p.instanceId)).toEqual([copy.id])
      expect(next.metadata).toEqual(first.metadata)
      for (const c of first.content) expect(next.content).toContainEqual(c)
      const now = (await destByWorld())!
      expect(now.adopted).toBe(true)
      expect([now.mapStatus, now.mapEntityId]).toEqual(['pending', worlds.deployed[1].entityId])
      goLive()

      await db.update(sceneElementInstances).set({ position: { x: 5, y: 0, z: 5 } }).where(eq(sceneElementInstances.id, copy.id))
      expect(await pendingModels((await destByWorld())!)).toEqual([])
      expect(await sweepRedeploys(new Date(Date.now() + 2 * BATCH_WINDOW_MS), { fetch: fetcher })).toEqual({ started: 0, marked: 0 })
      const again = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
      await whenSettled(again.id)
      expect((await depRow(again.id)).errorMessage).toMatch(/already has everything/)
      expect(worlds.deployed).toHaveLength(2)
    })
  })

  describe('scene thumbnail (LIV-88)', () => {
    const THUMB = 'images/scene-thumbnail-0123456789abcdef.png'
    async function withThumbnail(sceneId: string) {
      const key = `scenes/${sceneId}/thumbnail-0123456789abcdef.png`
      await db.update(scenes).set({ thumbnailKey: key, thumbnailUrl: `${CDN}/${key}`, thumbnailBytes: 900_000 }).where(eq(scenes.id, sceneId))
    }

    it("the deployed scene.json gets only display.navmapThumbnail, and the image is in the deployment", async () => {
      const { scene } = await createScene(user, 'Cafe')
      await withThumbnail(scene.id)
      await grantedDest(scene.id)
      const imp = await built({ sceneId: scene.id })
      await deployImport(imp.id, { fetch: fetcher })
      await whenSettled((await importRow(imp.id)).deploymentId!)
      const e = entityOf()
      expect(e.metadata).toEqual({ ...JSON.parse(sceneJson()), display: { title: 'Owner Title', navmapThumbnail: THUMB } })
      expect(e.content.map((c) => c.file)).toContain(THUMB)
    })

    it('without a thumbnail in Virvi the scene.json is deployed as built', async () => {
      const { scene } = await createScene(user, 'Cafe')
      await grantedDest(scene.id)
      const imp = await built({ sceneId: scene.id })
      await deployImport(imp.id, { fetch: fetcher })
      await whenSettled((await importRow(imp.id)).deploymentId!)
      expect(entityOf().metadata).toEqual(JSON.parse(sceneJson()))
    })

    it('counts towards the file budget and the World storage before deploying', async () => {
      const { scene } = await createScene(user, 'Cafe')
      await withThumbnail(scene.id)
      const extra: Record<string, Uint8Array> = {}
      for (let i = 0; i < 196; i++) extra[`assets/f${i}.txt`] = enc(`f${i}`)
      const crowded = await built({ sceneId: scene.id, files: builtFiles(extra, ['0,0']) })
      await grantedDest(scene.id, { parcels: ['0,0'] })
      await expect(deployImport(crowded.id, { fetch: fetcher })).rejects.toMatchObject({ code: 'scene_too_big' })

      await db.delete(dclWorldDestinations)
      const small = await built({ sceneId: scene.id })
      const builtBytes = [...builtFiles().values()].reduce((n, b) => n + b.byteLength, 0)
      worlds.stats.set(user.wallet!, { maxAllowedBytes: builtBytes + 500_000, usedBytes: 0 })
      await grantedDest(scene.id)
      await expect(deployImport(small.id, { fetch: fetcher })).rejects.toMatchObject({ code: 'world_storage_full' })
    })
  })

  describe('a "Download live" zip re-imported keeps its Virvi-named thumbnail (LIV-133)', () => {
    const OWN = 'images/scene-thumbnail-fedcba9876543210.jpg'
    const UPLOAD = 'images/scene-thumbnail-0123456789abcdef.png'
    /** The built files of a downloaded live scene: Virvi's deployed thumbnail, named by its scene.json. */
    function downloaded(): Map<string, Uint8Array> {
      const files = builtFiles({ [OWN]: enc('the thumbnail Virvi deployed') })
      const json = JSON.parse(dec(files.get('scene.json')!))
      files.set('scene.json', enc(JSON.stringify({ ...json, display: { ...json.display, navmapThumbnail: OWN } })))
      return files
    }
    const later = () => new Date(Date.now() + 2 * BATCH_WINDOW_MS)
    /** Imports the downloaded zip into `sceneId` and deploys it; the World's destination after. */
    async function reimport(sceneId: string) {
      const imp = await built({ sceneId, files: downloaded() })
      await deployImport(imp.id, { fetch: fetcher })
      await whenSettled((await importRow(imp.id)).deploymentId!)
      expect((await importRow(imp.id)).status).toBe('deployed')
      goLive()
      return (await destByWorld())!
    }

    for (const source of ['import', null] as const) {
      it(`nothing is pending and nothing redeploys (the scene's thumbnail: ${source ?? 'none'}); a later redeploy keeps the file and navmapThumbnail`, async () => {
        const { scene, preset } = await createScene(user, 'Cafe')
        if (source) {
          // LIV-89 recorded the downloaded thumbnail as the scene's imported one (re-encoded, so under another hash)
          const key = `scenes/${scene.id}/thumbnail-1111111111111111.jpg`
          await db.update(scenes).set({ thumbnailKey: key, thumbnailUrl: `${CDN}/${key}`, thumbnailBytes: 1000, thumbnailSource: source }).where(eq(scenes.id, scene.id))
        }
        await grantedDest(scene.id)
        const dest = await reimport(scene.id)
        expect(dest.deployedFiles).toContain(OWN)
        expect(entityOf().metadata.display.navmapThumbnail).toBe(OWN)
        expect(await pendingModels(dest)).toEqual([])
        expect(await sweepRedeploys(later(), { fetch: fetcher })).toEqual({ started: 0, marked: 0 })
        expect(worlds.deployed).toHaveLength(1)

        // A model placed later redeploys the World: the scene's thumbnail stays
        await createElement(preset.id, { type: 'model', name: 'a', properties: { modelSrc: `${CDN}/m/a.glb` } })
        const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
        await whenSettled(dep.id)
        const e = entityOf()
        expect(worlds.deployed).toHaveLength(2)
        expect(e.content.map((c) => c.file)).toEqual(expect.arrayContaining([OWN, 'models/virvi/a.glb']))
        expect(e.metadata.display.navmapThumbnail).toBe(OWN)
      })
    }

    it("a thumbnail uploaded in Virvi afterwards, then removed: Virvi's file and navmapThumbnail go, the scene's own file stays", async () => {
      const { scene } = await createScene(user, 'Cafe')
      await grantedDest(scene.id)
      const dest = await reimport(scene.id)
      const key = `scenes/${scene.id}/thumbnail-0123456789abcdef.png`
      await db.update(scenes).set({ thumbnailKey: key, thumbnailUrl: `${CDN}/${key}`, thumbnailBytes: 1000, thumbnailSource: 'upload' }).where(eq(scenes.id, scene.id))
      expect((await pendingModels(dest)).map((m) => m.file)).toEqual([UPLOAD])
      await whenSettled((await startVirviDeploy(dest.id, user.id, { fetch: fetcher })).id)
      expect(entityOf().metadata.display.navmapThumbnail).toBe(UPLOAD)
      goLive()

      await db.update(scenes).set({ thumbnailKey: null, thumbnailUrl: null, thumbnailBytes: null, thumbnailSource: null }).where(eq(scenes.id, scene.id))
      const now = (await destByWorld())!
      expect((await pendingModels(now)).map((m) => [m.file, m.removed])).toEqual([[UPLOAD, true]])
      await whenSettled((await startVirviDeploy(dest.id, user.id, { fetch: fetcher })).id)
      const e = entityOf()
      expect(e.content.map((c) => c.file)).toContain(OWN)
      expect(e.content.map((c) => c.file)).not.toContain(UPLOAD)
      expect(e.metadata.display.navmapThumbnail).toBeUndefined()
      goLive()
      expect(await pendingModels((await destByWorld())!)).toEqual([])
    })
  })

  it("a re-upload of a scene using more than half the World's storage is not refused: the scene it replaces is credited", async () => {
    const { scene } = await createScene(user, 'Cafe')
    await grantedDest(scene.id)
    const big = new Uint8Array(60_000).fill(7)
    const first = await built({ sceneId: scene.id, files: builtFiles({ 'models/big.glb': big }) })
    await deployImport(first.id)
    await whenSettled((await importRow(first.id)).deploymentId!)
    const live = goLive()
    // The Worlds server holds what went live, and counts it as used
    const sent = worlds.deployed[0]
    for (const c of live.content) worlds.contents.set(c.hash, sent.files.get(c.hash)!)
    const liveBytes = live.content.reduce((n, c) => n + sent.files.get(c.hash)!.byteLength, 0)
    worlds.stats.set(user.wallet!, { maxAllowedBytes: 100_000, usedBytes: liveBytes })

    const again = await built({ sceneId: scene.id, files: builtFiles({ 'models/big.glb': big, 'bin/index.js': enc('owner code v2') }) })
    await deployImport(again.id)
    expect((await importRow(again.id)).errorCode).toBeNull()
    await whenSettled((await importRow(again.id)).deploymentId!)
    expect((await importRow(again.id)).status).toBe('deployed')

    // Still refused when even the credit isn't enough
    const now = goLive()
    for (const c of now.content) worlds.contents.set(c.hash, worlds.deployed[1].files.get(c.hash) ?? worlds.contents.get(c.hash)!)
    worlds.stats.set(user.wallet!, { maxAllowedBytes: 100_000, usedBytes: 100_000 })
    const huge = await built({ sceneId: scene.id, files: builtFiles({ 'models/big.glb': big, 'models/more.glb': new Uint8Array(60_000).fill(8) }) })
    await expect(deployImport(huge.id)).rejects.toMatchObject({ code: 'world_storage_full' })
  })
})
