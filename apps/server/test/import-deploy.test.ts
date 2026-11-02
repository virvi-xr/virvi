import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { zipSync } from 'fflate'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { analyticsScenes, dclWorldDestinations, sceneDeployments, sceneImports } from '../src/db/schema.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { chainSigner, dclHash, virviSigner } from '../src/services/dcl/entity.js'
import { setWorldsClient, WorldsError, type LiveEntity } from '../src/services/dcl/worlds-client.js'
import { assembleImported } from '../src/services/dcl/assemble.js'
import { DEPLOY_WINDOW_MS, startVirviDeploy, whenSettled, type SignedBundle } from '../src/services/dcl/world-deployer.js'
import { setBuildRunner, setOnBuildDone, startBuild, type BuildRunner } from '../src/services/import/build-runner.js'
import { createImport, SUPERSEDED_MESSAGE } from '../src/services/import/imports.js'
import { deployImport } from '../src/services/import/import-deploy.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
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

function sceneJson(parcels = ['0,0', '1,0'], title = 'Owner Title') {
  return JSON.stringify({
    display: { title }, owner: '', main: 'bin/index.js', ecs7: true, runtimeVersion: '7',
    scene: { parcels, base: parcels[0] }, worldConfiguration: { name: WORLD }, spawnPoints: [],
  })
}

/** What a build of the owner's scene leaves behind. */
function builtFiles(extra: Record<string, Uint8Array> = {}, parcels?: string[]): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['scene.json', enc(sceneJson(parcels))],
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
  async function built(o: { sceneId?: string; files?: Map<string, Uint8Array> } = {}) {
    const sceneId = o.sceneId ?? (await createScene(user, 'Cafe')).scene.id
    const [row] = await db.insert(sceneImports).values({
      userId: user.id, sceneId, worldName: WORLD, kind: 'sdk7', sourceKey: 'pending', status: 'built', builtAt: new Date(),
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

  it("a scene over the World's file budget fails with scene_too_big", async () => {
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
    expect(row.builtKeyPrefix).not.toBeNull()
    expect((await destByWorld())!.pendingImportId).toBeNull()
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
    expect(worlds.deployed).toHaveLength(0)
  })

  it("a file over Decentraland's file limit fails with file_too_big, and a full World with world_storage_full", async () => {
    const big = await built({ files: builtFiles({ 'models/huge.glb': new Uint8Array(50 * 1024 * 1024 + 1) }) })
    const r = await post(`/api/imports/${big.id}/deploy`)
    expect([r.statusCode, r.json().error]).toEqual([413, 'file_too_big'])
    expect(await importRow(big.id)).toMatchObject({ status: 'failed', errorCode: 'file_too_big' })
    expect((await importRow(big.id)).errorMessage).toMatch(/models\/huge\.glb.*50 MB/)

    const imp = await built({ sceneId: big.sceneId })
    worlds.stats.set(user.wallet!, { maxAllowedBytes: 100, usedBytes: 90 })
    const full = await post(`/api/imports/${imp.id}/deploy`)
    expect([full.statusCode, full.json().error]).toEqual([413, 'world_storage_full'])
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

  it("a failed upload fails the import with the deploy's message", async () => {
    const { scene } = await createScene(user, 'Cafe')
    await grantedDest(scene.id)
    const imp = await built({ sceneId: scene.id })
    worlds.failNext = new WorldsError(400, JSON.stringify({ message: 'scene.json is wrong' }))
    await deployImport(imp.id)
    const depId = (await importRow(imp.id)).deploymentId!
    await whenSettled(depId)
    const dep = await depRow(depId)
    expect(dep.status).toBe('failed')
    const row = await importRow(imp.id)
    expect(row).toMatchObject({ status: 'failed', errorCode: 'deploy_failed', errorMessage: dep.errorMessage })
    expect(row.errorMessage).toMatch(/Decentraland rejected the deploy: scene\.json is wrong/)
    expect((await destByWorld())!.pendingImportId).toBeNull()
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

  it("a deploy that won't start after a build fails the import, and the build result is still accepted", async () => {
    const started: Record<string, string>[] = []
    const runner: BuildRunner = { async start(_id, env) { started.push(env); return { machineId: 'm1' } }, async stop() {} }
    setBuildRunner(runner)
    setOnBuildDone(deployImport)
    const { scene } = await createScene(user, 'Cafe')
    await grantedDest(scene.id, { parcels: ['0,0'] })
    const [row] = await db.insert(sceneImports).values({
      userId: user.id, sceneId: scene.id, worldName: WORLD, kind: 'sdk7', sourceKey: 'x',
    }).returning()
    await startBuild(row.id)
    const extra: Record<string, Uint8Array> = {}
    for (let i = 0; i < 200; i++) extra[`assets/f${i}.txt`] = enc(`f${i}`)
    const zip = Buffer.from(zipSync(Object.fromEntries(builtFiles(extra, ['0,0']))))
    const r = await app.inject({
      method: 'POST', url: `/api/imports/build/${row.id}/result`, payload: zip,
      headers: { authorization: `Bearer ${started[0].BUILD_TOKEN}`, 'content-type': 'application/zip' },
    })
    expect(r.statusCode).toBe(204)
    await vi.waitFor(async () => expect((await importRow(row.id)).status).toBe('failed'))
    expect(await importRow(row.id)).toMatchObject({ errorCode: 'scene_too_big', builtKeyPrefix: `imports/${row.id}/built/` })
  })
})
