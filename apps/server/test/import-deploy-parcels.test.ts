import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsScenes, dclWorldDestinations, sceneDeployments, sceneImports, userAuthMethods } from '../src/db/schema.js'
import { setDclDirectory, type ParcelRights } from '../src/analytics/dcl-directory.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { setCatalystClient } from '../src/services/dcl/catalyst-client.js'
import { setWorldsClient, type LiveEntity } from '../src/services/dcl/worlds-client.js'
import { PARCEL_MAX_BYTES_PER_PARCEL, submitSignedDeploy } from '../src/services/dcl/world-deployer.js'
import { startImportDeploy } from '../src/services/import/import-deploy.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { FakeCatalystClient } from './helpers/fake-catalyst.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'

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

function builtFiles(extra: Record<string, Uint8Array> = {}, o: { world?: string } = {}) {
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
  async function built(o: { files?: Map<string, Uint8Array>; by?: TestUser } = {}) {
    const by = o.by ?? user
    const sceneId = (await createScene(by, 'Plaza')).scene.id
    const [row] = await db.insert(sceneImports).values({
      userId: by.id, sceneId, locationKind: 'parcels', base: BASE, parcels: PARCELS, kind: 'sdk7', sourceKey: 'pending', status: 'built', builtAt: new Date(),
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
})
