import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsScenes, dclWorldDestinations, locationSetups, sceneDeployments, sceneImports, userAuthMethods } from '../src/db/schema.js'
import { setDclDirectory, type ParcelRights } from '../src/analytics/dcl-directory.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { setCatalystClient } from '../src/services/dcl/catalyst-client.js'
import { setWorldsClient, type LiveEntity } from '../src/services/dcl/worlds-client.js'
import { PARCEL_MAX_BYTES_PER_PARCEL, submitSignedDeploy } from '../src/services/dcl/world-deployer.js'
import { startImportDeploy } from '../src/services/import/import-deploy.js'
import { createImport } from '../src/services/import/imports.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { FakeCatalystClient } from './helpers/fake-catalyst.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'
import { config } from '../src/config.js'
import { createElement } from './helpers/factories.js'

// Model downloads in "Redeploy now" resolve the CDN's host; the tests' CDN has none
vi.mock('../src/net/public-url.js', async (orig) => ({
  ...(await orig<typeof import('../src/net/public-url.js')>()),
  assertPublicHttpUrl: async (url: string) => new URL(url),
}))
const CDN = 'https://cdn.virvi.test'

const PARCELS = ['10,10', '10,11']
const BASE = '10,10'
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
type Identity = ReturnType<typeof createUnsafeIdentity>

async function chainFor(wallet: Identity, payload: string) {
  const identity = await Authenticator.initializeAuthChain(
    wallet.address, createUnsafeIdentity(), 10, async (m) => Authenticator.createSignature(wallet, m),
  )
  return Authenticator.signPayload(identity, payload)
}

const rights = (r: Partial<ParcelRights> = {}): ParcelRights => ({ owner: null, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [], ...r })

function sceneJson(o: { parcels?: string[]; world?: string } = {}) {
  const parcels = o.parcels ?? PARCELS
  return JSON.stringify({
    display: { title: 'Plaza' }, owner: '', main: 'bin/index.js', ecs7: true, runtimeVersion: '7',
    scene: { parcels, base: parcels[0] }, spawnPoints: [], ...(o.world ? { worldConfiguration: { name: o.world } } : {}),
  })
}

function builtFiles(extra: Record<string, Uint8Array> = {}, o: { world?: string; parcels?: string[] } = {}) {
  return new Map<string, Uint8Array>([
    ['scene.json', enc(sceneJson(o))],
    ['bin/index.js', enc('owner code')],
    ['models/Tree.glb', enc('tree bytes')],
    ...Object.entries(extra),
  ])
}

describe('deploying an imported scene to Genesis City parcels', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let catalyst: FakeCatalystClient
  let worlds: FakeWorldsClient
  let dir: FakeDclDirectory
  let store: ReturnType<typeof memoryPrivateStore>
  let owner: Identity
  let user: TestUser

  beforeEach(async () => {
    await resetDb()
    catalyst = new FakeCatalystClient()
    setCatalystClient(catalyst)
    worlds = new FakeWorldsClient()
    setWorldsClient(worlds)
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
    store = memoryPrivateStore()
    setImportStore(store)
    owner = createUnsafeIdentity()
    user = await createUser({ wallet: owner.address })
    for (const p of PARCELS) dir.rights.set(p, rights({ owner: user.wallet }))
    app = await testApp()
  })
  afterEach(async () => {
    setCatalystClient(null)
    setWorldsClient(null)
    setDclDirectory(null)
    setImportStore(null)
    await app.close()
  })

  const importRow = async (id: string) => (await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, id) }))!
  const depRow = async (id: string) => (await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, id) }))!
  const entityOf = (i = catalyst.deployed.length - 1) => {
    const d = catalyst.deployed[i]
    return JSON.parse(dec(d.files.get(d.entityId)!)) as { pointers: string[]; content: Array<{ file: string; hash: string }>; metadata: any }
  }

  /** A built parcel import for `u`'s new scene, its files in the store. */
  async function built(o: { files?: Map<string, Uint8Array>; by?: TestUser; sceneId?: string; parcels?: string[] } = {}) {
    const by = o.by ?? user
    const sceneId = o.sceneId ?? (await createScene(by, 'Plaza')).scene.id
    const parcels = o.parcels ?? PARCELS
    const [row] = await db.insert(sceneImports).values({
      userId: by.id, sceneId, locationKind: 'parcels', base: parcels[0], parcels, kind: 'sdk7', sourceKey: 'pending', status: 'built', builtAt: new Date(),
    }).returning()
    const prefix = `imports/${row.id}/built/`
    await db.update(sceneImports).set({ sourceKey: `imports/${row.id}/source.zip`, builtKeyPrefix: prefix }).where(eq(sceneImports.id, row.id))
    for (const [path, bytes] of o.files ?? builtFiles()) await store.put(prefix + path, Buffer.from(bytes), 'application/octet-stream')
    return { row: await importRow(row.id), sceneId }
  }

  /** Starts the deploy as `by` and signs it with `signer`. */
  async function deploy(imp: Awaited<ReturnType<typeof built>>, signer: Identity, by: TestUser = user) {
    const started = await startImportDeploy(imp.row, by.id)
    if (started?.mode !== 'sign') throw new Error('expected a signed deploy')
    expect((await importRow(imp.row.id)).status).toBe('awaiting_signature')
    return { started, deployment: await submitSignedDeploy(started.deployment.id, await chainFor(signer, started.payload)) }
  }

  it('deploys a parcel import signed by the owner', async () => {
    const imp = await built()
    const { started, deployment } = await deploy(imp, owner)

    expect(catalyst.deployed).toHaveLength(1)
    expect(worlds.deployed).toHaveLength(0)
    const entity = entityOf()
    expect(entity.pointers).toEqual(PARCELS)
    expect(entity.metadata.worldConfiguration).toBeUndefined()
    expect(entity.content.map((c) => c.file).sort()).toEqual(['bin/index.js', 'models/Tree.glb', 'scene.json'])
    expect(deployment.status).toBe('deployed')

    const row = await importRow(imp.row.id)
    expect(row.status).toBe('deployed')
    const dep = await depRow(started.deployment.id)
    expect(dep).toMatchObject({ deploymentType: 'parcel', target: { parcels: PARCELS } })
    expect((dep.target as Record<string, unknown>).world).toBeUndefined()

    const dest = (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, row.destinationId!) }))!
    expect(dest).toMatchObject({
      kind: 'parcels', worldName: null, base: BASE, parcels: PARCELS, ownerWallet: user.wallet, mode: 'sign', adopted: true,
      pendingImportId: null, lastEntityId: catalyst.deployed[0].entityId, status: 'ok',
    })
    const as = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, `gc:${BASE}`) })
    expect(as).toMatchObject({ kind: 'parcels', virviSceneId: imp.sceneId, activeEntityId: catalyst.deployed[0].entityId, baseParcel: BASE, parcels: PARCELS })
  })

  it('an update operator may sign', async () => {
    const operator = createUnsafeIdentity()
    const op = await createUser({ wallet: operator.address })
    for (const p of PARCELS) dir.rights.set(p, rights({ owner: user.wallet, updateOperator: op.wallet }))
    const imp = await built({ by: op })
    await deploy(imp, operator, op)

    expect(catalyst.deployed).toHaveLength(1)
    expect((await importRow(imp.row.id)).status).toBe('deployed')
    const dest = (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.base, BASE) }))!
    expect(dest.ownerWallet).toBe(op.wallet)
  })

  it('a signature from a wallet that lost a parcel is refused', async () => {
    const imp = await built()
    const started = await startImportDeploy(imp.row, user.id)
    if (started?.mode !== 'sign') throw new Error('expected a signed deploy')
    // Between prepare and submit the second parcel changes hands
    dir.rights.set(PARCELS[1], rights({ owner: createUnsafeIdentity().address.toLowerCase() }))
    const err = await submitSignedDeploy(started.deployment.id, await chainFor(owner, started.payload)).catch((e) => e)
    expect(err).toMatchObject({ status: 403, code: 'not_parcel_controller' })
    expect(catalyst.deployed).toHaveLength(0)
    expect((await importRow(imp.row.id)).status).toBe('awaiting_signature')
  })

  it('a signature from a wallet with no rights at all is refused', async () => {
    const imp = await built()
    const started = await startImportDeploy(imp.row, user.id)
    if (started?.mode !== 'sign') throw new Error('expected a signed deploy')
    const err = await submitSignedDeploy(started.deployment.id, await chainFor(createUnsafeIdentity(), started.payload)).catch((e) => e)
    expect(err).toMatchObject({ status: 403, code: 'not_parcel_controller' })
    expect(catalyst.deployed).toHaveLength(0)
  })

  it('an import replaces a parcel scene deployed outside Virvi', async () => {
    const foreign: LiveEntity = {
      id: 'bafyforeignscene', pointers: PARCELS, content: [{ file: 'scene.json', hash: 'bafyforeignjson' }],
      metadata: JSON.parse(sceneJson()),
    }
    for (const p of PARCELS) catalyst.entities.set(p, [foreign])
    const imp = await built()
    const { started } = await deploy(imp, owner)

    expect(catalyst.deployed).toHaveLength(1)
    expect((await importRow(imp.row.id)).status).toBe('deployed')
    expect((await depRow(started.deployment.id)).assetBundle).toMatchObject({ baseEntityId: 'bafyforeignscene' })
    const dest = (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.base, BASE) }))!
    expect(dest.lastEntityId).toBe(catalyst.deployed[0].entityId)
  })

  it('a built scene.json that gained worldConfiguration is refused', async () => {
    const imp = await built({ files: builtFiles({}, { world: 'sneaky.dcl.eth' }) })
    const err = await startImportDeploy(imp.row, user.id).catch((e) => e)
    expect(err).toMatchObject({ status: 422, code: 'place_changed' })
    expect(catalyst.deployed).toHaveLength(0)
    expect(await importRow(imp.row.id)).toMatchObject({ status: 'failed', errorCode: 'place_changed' })
  })

  it('over the parcel size limit is refused before deploying', async () => {
    // Two parcels: just over twice the per-parcel limit in all
    const big = new Uint8Array(PARCEL_MAX_BYTES_PER_PARCEL + 1)
    const imp = await built({ files: builtFiles({ 'models/a.glb': big, 'models/b.glb': big }) })
    const err = await startImportDeploy(imp.row, user.id).catch((e) => e)
    expect(err).toMatchObject({ status: 413, code: 'scene_too_big' })
    expect(catalyst.deployed).toHaveLength(0)
    expect((await importRow(imp.row.id)).status).toBe('failed')
  })

  it('the destination reports its kind, parcels and who may sign', async () => {
    const second = createUnsafeIdentity()
    await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: second.address.toLowerCase(), metadata: { verified: true } })
    // The second wallet is an update manager of only one parcel, so it can't sign
    dir.rights.set(PARCELS[0], rights({ owner: user.wallet, updateManagers: [second.address.toLowerCase()] }))
    const imp = await built()
    await startImportDeploy(imp.row, user.id)
    const destId = (await importRow(imp.row.id)).destinationId!
    const res = await app.inject({ method: 'GET', url: `/api/dcl/destinations/${destId}`, headers: { authorization: `Bearer ${tokenFor(user)}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ kind: 'parcels', parcels: PARCELS, signers: [user.wallet] })
  })

  it('the destination says signers is null when Decentraland cannot say who controls the parcels', async () => {
    const imp = await built()
    await startImportDeploy(imp.row, user.id)
    const destId = (await importRow(imp.row.id)).destinationId!
    dir.down = true
    const res = await app.inject({ method: 'GET', url: `/api/dcl/destinations/${destId}`, headers: { authorization: `Bearer ${tokenFor(user)}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ kind: 'parcels', parcels: PARCELS, signers: null })
  })

  it('a re-import of the same scene updates its parcels destination', async () => {
    const first = await built()
    await deploy(first, owner)
    const destId = (await importRow(first.row.id)).destinationId!
    // The creator shrinks the scene to its base parcel
    const again = await built({ sceneId: first.sceneId, parcels: [BASE], files: builtFiles({}, { parcels: [BASE] }) })
    await deploy(again, owner)
    expect((await importRow(again.row.id))).toMatchObject({ status: 'deployed', destinationId: destId })
    const dests = await db.query.dclWorldDestinations.findMany({ where: eq(dclWorldDestinations.kind, 'parcels') })
    expect(dests).toHaveLength(1)
    expect(dests[0]).toMatchObject({ id: destId, parcels: [BASE], lastEntityId: catalyst.deployed[1].entityId })
    expect(entityOf().pointers).toEqual([BASE])
  })

  describe('a re-import whose base moved', () => {
    const MOVED = ['10,11', '10,12']
    beforeEach(() => { dir.rights.set('10,12', rights({ owner: user.wallet })) })
    const parcelsDests = () => db.query.dclWorldDestinations.findMany({ where: eq(dclWorldDestinations.kind, 'parcels') })

    it('moves the one destination to the new base, and the HUD and the location follow it', async () => {
      const first = await built()
      await deploy(first, owner)
      const destId = (await importRow(first.row.id)).destinationId!
      const again = await built({ sceneId: first.sceneId, parcels: MOVED, files: builtFiles({}, { parcels: MOVED }) })
      await deploy(again, owner)

      expect(await importRow(again.row.id)).toMatchObject({ status: 'deployed', destinationId: destId })
      const dests = await parcelsDests()
      expect(dests).toHaveLength(1)
      expect(dests[0]).toMatchObject({ id: destId, base: '10,11', parcels: MOVED, pendingImportId: null, lastEntityId: catalyst.deployed[1].entityId })
      expect(entityOf().pointers).toEqual(MOVED)

      const pass = { authorization: `Bearer ${tokenFor(user, { kind: 'scene', sceneId: first.sceneId, locationId: null, orgId: null })}` }
      const hud = await app.inject({ method: 'GET', url: `/api/scenes/${first.sceneId}/dcl/publish-status`, headers: pass })
      expect(hud.json().destination).toMatchObject({ id: destId, world: 'gc:10,11' })

      // The location's setup moved with it: gc:10,11 is set up for the scene, gc:10,10 no longer is
      const at = async (key: string) => (await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) }))!
      const [oldLoc, newLoc] = [await at('gc:10,10'), await at('gc:10,11')]
      expect(newLoc).toMatchObject({ virviSceneId: first.sceneId, baseParcel: '10,11', parcels: MOVED })
      expect(oldLoc.virviSceneId).toBeNull()
      const setups = await db.select().from(locationSetups)
      expect(setups.find((x) => x.analyticsSceneId === newLoc.id && !x.endedAt)).toMatchObject({ virviSceneId: first.sceneId })
      expect(setups.find((x) => x.analyticsSceneId === oldLoc.id)).toMatchObject({ endedAt: expect.any(Date), endReason: 'replaced' })
    })

    it('a changed parcel set goes back to browser signing', async () => {
      const first = await built()
      await deploy(first, owner)
      const destId = (await importRow(first.row.id)).destinationId!
      await db.update(dclWorldDestinations).set({ mode: 'virvi', grantedAt: new Date() }).where(eq(dclWorldDestinations.id, destId))
      const again = await built({ sceneId: first.sceneId, parcels: MOVED, files: builtFiles({}, { parcels: MOVED }) })
      // The grant was for the old parcels: this deploy is signed in the browser, not refused for a missing Virvi key
      const started = await startImportDeploy(again.row, user.id)
      expect(started?.mode).toBe('sign')
      expect((await parcelsDests())).toEqual([expect.objectContaining({ id: destId, base: '10,11', mode: 'sign', grantedAt: null, pendingImportId: again.row.id })])
    })

    it('a newer upload on overlapping parcels supersedes the waiting one, and deploys to the same destination', async () => {
      const first = await built()
      const started = await startImportDeploy(first.row, user.id)
      expect(started?.mode).toBe('sign')
      const destId = (await importRow(first.row.id)).destinationId!
      const next = await createImport({ userId: user.id, location: { kind: 'parcels', base: '10,11', parcels: MOVED }, kind: 'sdk7', scene: { id: first.sceneId } })
      expect(await importRow(first.row.id)).toMatchObject({ status: 'failed', errorCode: 'superseded' })
      expect((await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, destId) }))!.pendingImportId).toBeNull()

      const prefix = `imports/${next.id}/built/`
      for (const [path, bytes] of builtFiles({}, { parcels: MOVED })) await store.put(prefix + path, Buffer.from(bytes), 'application/octet-stream')
      await db.update(sceneImports).set({ status: 'built', builtKeyPrefix: prefix, builtAt: new Date() }).where(eq(sceneImports.id, next.id))
      await deploy({ row: await importRow(next.id), sceneId: first.sceneId }, owner)
      expect(await importRow(next.id)).toMatchObject({ status: 'deployed', destinationId: destId })
      expect(await parcelsDests()).toEqual([expect.objectContaining({ id: destId, base: '10,11', parcels: MOVED })])
    })
  })

  it("a signature from a wallet that controls the parcels but isn't the deploying user's is refused", async () => {
    const outsider = createUnsafeIdentity()
    for (const p of PARCELS) dir.rights.set(p, rights({ owner: user.wallet, updateOperator: outsider.address.toLowerCase() }))
    const imp = await built()
    const started = await startImportDeploy(imp.row, user.id)
    if (started?.mode !== 'sign') throw new Error('expected a signed deploy')
    const err = await submitSignedDeploy(started.deployment.id, await chainFor(outsider, started.payload)).catch((e) => e)
    expect(err).toMatchObject({ status: 403, code: 'not_parcel_controller' })
    expect(catalyst.deployed).toHaveLength(0)
  })

  it('the destination names its signers from cached rights (fresh reads are for authorising)', async () => {
    const imp = await built()
    await startImportDeploy(imp.row, user.id)
    const destId = (await importRow(imp.row.id)).destinationId!
    dir.rightsReads = []
    const res = await app.inject({ method: 'GET', url: `/api/dcl/destinations/${destId}`, headers: { authorization: `Bearer ${tokenFor(user)}` } })
    expect(res.json().signers).toEqual([user.wallet])
    expect(dir.rightsReads.length).toBeGreaterThan(0)
    expect(dir.rightsReads.some((r) => r.fresh)).toBe(false)
  })

  it("refuses a parcels destination another scene holds on that base (409 parcels_in_use)", async () => {
    const other = (await createScene(user, 'Other')).scene.id
    await db.insert(dclWorldDestinations).values({
      sceneId: other, ownerUserId: user.id, ownerWallet: user.wallet!, kind: 'parcels', worldName: null, base: BASE, parcels: PARCELS, mode: 'sign', adopted: true,
    })
    const imp = await built()
    const err = await startImportDeploy(imp.row, user.id).catch((e) => e)
    expect(err).toMatchObject({ status: 409, code: 'parcels_in_use' })
    expect(await importRow(imp.row.id)).toMatchObject({ status: 'built', errorCode: 'parcels_in_use' })
    const held = (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.base, BASE) }))!
    expect(held).toMatchObject({ sceneId: other, pendingImportId: null })
  })

  describe('the deploy page and HUD routes on a parcels destination', () => {
    const cfg = config as { cdnUrl: string | null; webAppUrl: string }
    const savedCdn = cfg.cdnUrl
    beforeEach(() => { cfg.cdnUrl = CDN })
    afterEach(() => {
      cfg.cdnUrl = savedCdn
      vi.unstubAllGlobals()
    })
    const auth = (u: TestUser = user) => ({ authorization: `Bearer ${tokenFor(u)}` })
    const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, u: TestUser = user) =>
      app.inject({ method, url, headers: auth(u), ...(payload ? { payload } : {}) })

    /** A parcel import deployed and live on the catalyst; its destination. */
    async function liveParcels() {
      const { scene, preset } = await createScene(user, 'Plaza')
      const imp = await built({ sceneId: scene.id })
      await deploy(imp, owner)
      const d = catalyst.deployed[0]
      const e = JSON.parse(dec(d.files.get(d.entityId)!))
      const live: LiveEntity = { id: d.entityId, pointers: e.pointers, content: e.content, metadata: e.metadata }
      for (const p of PARCELS) catalyst.entities.set(p, [live])
      const dest = (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.base, BASE) }))!
      return { scene, preset, dest, live }
    }

    it('publish-status answers for the HUD with the parcels location where a World name goes', async () => {
      const { scene, preset, dest } = await liveParcels()
      await createElement(preset.id, { type: 'model', name: 'Tree', properties: { modelSrc: `${CDN}/m/tree.glb` } })
      const pass = { authorization: `Bearer ${tokenFor(user, { kind: 'scene', sceneId: scene.id, locationId: null, orgId: null })}` }
      const res = await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/dcl/publish-status`, headers: pass })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        destination: { id: dest.id, world: `gc:${BASE}`, mode: 'sign', status: 'ok', granted: false, pending: 1, publishUrl: `${cfg.webAppUrl}/publish/?d=${dest.id}` },
      })
    })

    it('Redeploy now prepares a browser-signed deploy of the new models, and the signature deploys it', async () => {
      const { preset, dest, live } = await liveParcels()
      await createElement(preset.id, { type: 'model', name: 'Bench', properties: { modelSrc: `${CDN}/m/bench.glb` } })
      vi.stubGlobal('fetch', async () => new Response(enc('bench bytes')))

      const stranger = createUnsafeIdentity()
      const notMine = await createUser({ wallet: stranger.address })
      await db.update(dclWorldDestinations).set({ ownerUserId: notMine.id }).where(eq(dclWorldDestinations.id, dest.id))
      // Scene access is checked first: a stranger can't even see it
      expect((await req('POST', `/api/dcl/destinations/${dest.id}/deploy`, {}, notMine)).statusCode).toBe(404)

      const res = await req('POST', `/api/dcl/destinations/${dest.id}/deploy`, {})
      expect(res.statusCode).toBe(200)
      const { deployment, payload } = res.json()
      expect(deployment.status).toBe('awaiting_signature')
      expect(typeof payload).toBe('string')
      // The owner wallet is brought up to date with the caller
      expect((await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, dest.id) }))!.ownerUserId).toBe(user.id)

      const ok = await req('POST', `/api/deploy/${deployment.id}/signature`, { chain: await chainFor(owner, payload) })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().deployment.status).toBe('deployed')
      expect(catalyst.deployed).toHaveLength(2)
      const entity = entityOf()
      expect(entity.pointers).toEqual(live.pointers)
      expect(entity.content.map((c) => c.file)).toContain('models/virvi/bench.glb')
      expect(entity.content.map((c) => c.file)).toContain('bin/index.js')
    })

    it('Redeploy now refuses a caller whose wallets no longer control every parcel', async () => {
      const { dest } = await liveParcels()
      dir.rights.set(PARCELS[1], rights({ owner: createUnsafeIdentity().address.toLowerCase() }))
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/deploy`, {})
      expect([res.statusCode, res.json().error]).toEqual([403, 'not_parcel_controller'])
    })

    it('Redeploy now with nothing new says so about the parcels, not a World', async () => {
      const { dest } = await liveParcels()
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/deploy`, {})
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'nothing_to_deploy', message: 'These parcels already have everything in this scene, so there was nothing to deploy.' })
    })

    it('a scene changed outside Virvi holds the parcels for review in plain words, and rebase takes the live scene', async () => {
      const { preset, dest } = await liveParcels()
      await createElement(preset.id, { type: 'model', name: 'Bench', properties: { modelSrc: `${CDN}/m/bench.glb` } })
      const foreign: LiveEntity = { id: 'bafyforeignscene', pointers: PARCELS, content: [{ file: 'scene.json', hash: 'bafyforeignjson' }], metadata: JSON.parse(sceneJson()) }
      for (const p of PARCELS) catalyst.entities.set(p, [foreign])

      const held = await req('POST', `/api/dcl/destinations/${dest.id}/deploy`, {})
      expect(held.json()).toEqual({ error: 'needs_review', message: 'The scene on these parcels changed outside Virvi' })

      const res = await req('POST', `/api/dcl/destinations/${dest.id}/rebase`)
      expect(res.statusCode).toBe(200)
      expect(res.json().destination).toMatchObject({ lastEntityId: 'bafyforeignscene', deployedFiles: ['scene.json'], adopted: true, status: 'ok' })

      catalyst.down = true
      expect((await req('POST', `/api/dcl/destinations/${dest.id}/rebase`)).json()).toEqual({ error: 'catalyst_unreachable' })
    })

    it('the World permission routes refuse parcels with 409 not_a_world', async () => {
      const { dest } = await liveParcels()
      const want = { error: 'not_a_world', message: 'Genesis City parcels use their own operator option.' }
      for (const [method, url] of [
        ['GET', `/api/dcl/destinations/${dest.id}/grant`],
        ['POST', `/api/dcl/destinations/${dest.id}/grant`],
        ['DELETE', `/api/dcl/destinations/${dest.id}/grant`],
        ['POST', `/api/dcl/destinations/${dest.id}/revoke`],
      ] as const) {
        const res = await req(method, url, method === 'POST' ? { chains: [], timestamp: Date.now() } : undefined)
        expect([url, method, res.statusCode, res.json()]).toEqual([url, method, 409, want])
      }
    })
  })
})
