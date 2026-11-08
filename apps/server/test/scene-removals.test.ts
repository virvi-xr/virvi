import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, hyperfyWorlds, sceneDeployments, sceneImports, sceneRemovals, scenes } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { chainSigner, signedFetchPayload, verifyChain, virviParcelSigner, virviSigner } from '../src/services/dcl/entity.js'
import { setWorldsClient, WorldsError } from '../src/services/dcl/worlds-client.js'
import { setCatalystClient } from '../src/services/dcl/catalyst-client.js'
import { startVirviDeploy } from '../src/services/dcl/world-deployer.js'
import { sweepRedeploys } from '../src/services/dcl/redeploy-sweep.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'
import { FakeCatalystClient } from './helpers/fake-catalyst.js'

const WORLD = 'cafe.dcl.eth'
const PARCEL = '-30,-30'
type Identity = ReturnType<typeof createUnsafeIdentity>

async function chainFor(wallet: Identity, payload: string) {
  const identity = await Authenticator.initializeAuthChain(wallet.address, createUnsafeIdentity(), 10, async (m) => Authenticator.createSignature(wallet, m))
  return Authenticator.signPayload(identity, payload)
}

describe('removing deployments when a scene is deleted (LIV-83)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let worlds: FakeWorldsClient
  let catalyst: FakeCatalystClient
  let dir: FakeDclDirectory
  let ownerKey: Identity
  let user: TestUser
  let sceneId: string
  const cfg = config as { virviDclDeployKey: string | null; virviDclParcelDeployKey: string | null }
  const saved = { world: cfg.virviDclDeployKey, parcels: cfg.virviDclParcelDeployKey }

  beforeEach(async () => {
    await resetDb()
    cfg.virviDclDeployKey = Wallet.createRandom().privateKey
    cfg.virviDclParcelDeployKey = Wallet.createRandom().privateKey
    worlds = new FakeWorldsClient()
    catalyst = new FakeCatalystClient()
    dir = new FakeDclDirectory()
    setWorldsClient(worlds)
    setCatalystClient(catalyst)
    setDclDirectory(dir)
    ownerKey = createUnsafeIdentity()
    user = await createUser({ wallet: ownerKey.address })
    sceneId = (await createScene(user, 'Cafe')).scene.id
    worlds.deployers.set(WORLD, { owner: user.wallet, deployers: [virviSigner()!.address] })
    dir.rights.set(PARCEL, { owner: user.wallet!, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [] })
    app = await testApp()
  })
  afterEach(async () => {
    cfg.virviDclDeployKey = saved.world
    cfg.virviDclParcelDeployKey = saved.parcels
    setWorldsClient(null)
    setCatalystClient(null)
    setDclDirectory(null)
    await app.close()
  })

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tokenFor(user)}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const insertWorld = async (extra: Partial<typeof dclWorldDestinations.$inferInsert> = {}) =>
    (await db.insert(dclWorldDestinations).values({
      sceneId, ownerUserId: user.id, ownerWallet: user.wallet!, worldName: WORLD, base: '0,0', parcels: ['0,0', '0,1'], mode: 'virvi', grantedAt: new Date(),
      lastEntityId: 'bafkreilive', ...extra,
    }).returning())[0]
  const insertParcels = async (extra: Partial<typeof dclWorldDestinations.$inferInsert> = {}) =>
    (await db.insert(dclWorldDestinations).values({
      sceneId, ownerUserId: user.id, ownerWallet: user.wallet!, kind: 'parcels', worldName: null, base: PARCEL, parcels: [PARCEL], mode: 'virvi', grantedAt: new Date(),
      lastEntityId: 'bafkreiparcel', ...extra,
    }).returning())[0]
  const deployed = async (destinationId: string) =>
    (await db.insert(sceneDeployments).values({
      sceneId, platform: 'decentraland', deploymentType: 'world', destinationId, target: {}, status: 'deployed', deployedAt: new Date(), catalystEntityId: 'bafkreilive',
    }).returning())[0]
  const destRow = async (id: string) => (await db.select().from(dclWorldDestinations).where(eq(dclWorldDestinations.id, id)))[0]

  it('the dialog ticks a Virvi-built World and unticks one whose live scene is the owner\'s own (adopted or uploaded)', async () => {
    const built = await insertWorld()
    const adopted = await insertWorld({ worldName: 'own.dcl.eth', adopted: true, mode: 'sign', grantedAt: null })
    const uploaded = await insertWorld({ worldName: 'upload.dcl.eth' })
    await db.insert(sceneImports).values({ userId: user.id, sceneId, worldName: 'upload.dcl.eth', kind: 'sdk7', status: 'deployed', sourceKey: 'imports/x/source.zip', destinationId: uploaded.id })
    await insertWorld({ worldName: 'never.dcl.eth', lastEntityId: null }) // connected, never deployed: nothing to remove
    const plan = (await call('GET', `/api/scenes/${sceneId}/delete-plan`)).json()
    expect(plan.running).toEqual([
      expect.objectContaining({ id: built.id, kind: 'dcl_world', label: `Remove the scene from ${WORLD}`, defaultChecked: true, needsSignature: false, ownContent: false }),
      expect.objectContaining({ id: adopted.id, defaultChecked: false, needsSignature: true, ownContent: true }),
      expect.objectContaining({ id: uploaded.id, defaultChecked: false, ownContent: true }),
    ])
  })

  it("with Virvi's grant, Virvi undeploys the scene on the World's base parcel (signed fetch), stamps the deployment and disconnects the World", async () => {
    const dest = await insertWorld()
    const dep = await deployed(dest.id)
    const res = await call('DELETE', `/api/scenes/${sceneId}`, { remove: [dest.id] })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().removals).toEqual([expect.objectContaining({ kind: 'dcl_world', status: 'done' })])
    expect(worlds.signed).toHaveLength(1)
    const { req, chain } = worlds.signed[0]
    expect(req).toMatchObject({ method: 'DELETE', path: `/world/${WORLD}/scenes/0,0`, metadata: '{}' })
    expect(chainSigner(chain)).toBe(virviSigner()!.address)
    expect(await verifyChain(chain, signedFetchPayload('DELETE', `/world/${WORLD}/scenes/0,0`, req.timestamp, '{}'), virviSigner()!.address)).toBe(true)
    expect(await destRow(dest.id)).toBeUndefined()
    const [stamped] = await db.select().from(sceneDeployments).where(eq(sceneDeployments.id, dep.id))
    expect(stamped.removalOutcome).toBe('undeployed')
    expect(stamped.removedAt).not.toBeNull()
    // Nothing is undeployed twice: a retry of a done removal sends nothing
    const [removal] = await db.select().from(sceneRemovals)
    await call('POST', `/api/scenes/${sceneId}/removals/${removal.id}/retry`)
    expect(worlds.signed).toHaveLength(1)
  })

  it("without the grant, the owner's wallet signs the undeploy in the browser; a signature from another wallet is refused", async () => {
    const dest = await insertWorld({ mode: 'sign', grantedAt: null })
    const res = await call('DELETE', `/api/scenes/${sceneId}`, { remove: [dest.id] })
    const [removal] = res.json().removals
    expect(removal).toMatchObject({ status: 'awaiting_signature' })
    expect(worlds.signed).toHaveLength(0)

    const sign = (await call('GET', `/api/scenes/${sceneId}/removals/${removal.id}/sign`)).json()
    expect(sign).toMatchObject({ kind: 'request', signer: user.wallet, request: { method: 'DELETE', path: `/world/${WORLD}/scenes/0,0` } })
    expect(sign.request.payload).toBe(signedFetchPayload('DELETE', sign.request.path, sign.request.timestamp, '{}'))

    const stranger = createUnsafeIdentity()
    const wrong = await call('POST', `/api/scenes/${sceneId}/removals/${removal.id}/signature`, { chain: await chainFor(stranger, sign.request.payload), timestamp: sign.request.timestamp })
    expect(wrong.statusCode).toBe(403)
    expect(worlds.signed).toHaveLength(0)

    const ok = await call('POST', `/api/scenes/${sceneId}/removals/${removal.id}/signature`, { chain: await chainFor(ownerKey, sign.request.payload), timestamp: sign.request.timestamp })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().removal.status).toBe('done')
    expect(worlds.signed).toHaveLength(1)
    expect(chainSigner(worlds.signed[0].chain)).toBe(user.wallet)
    expect(await destRow(dest.id)).toBeUndefined()
  })

  it("a refusal from Decentraland leaves the scene deleted and the World connected; Retry removes it", async () => {
    const dest = await insertWorld()
    worlds.failNext = new WorldsError(403, '{"message":"Unauthorized"}')
    const res = await call('DELETE', `/api/scenes/${sceneId}`, { remove: [dest.id] })
    const [removal] = res.json().removals
    expect(removal).toMatchObject({ status: 'failed', errorMessage: 'Decentraland refused it: Unauthorized' })
    expect((await db.select().from(scenes).where(eq(scenes.id, sceneId)))[0].deletedAt).not.toBeNull()
    expect(await destRow(dest.id)).toBeDefined()
    const retry = await call('POST', `/api/scenes/${sceneId}/removals/${removal.id}/retry`)
    expect(retry.json().removal.status).toBe('done')
    expect(await destRow(dest.id)).toBeUndefined()
  })

  it('Genesis City parcels get an empty scene over the same parcels: Virvi signs it as their operator, or the owner does', async () => {
    const virviParcels = await insertParcels()
    const res = await call('DELETE', `/api/scenes/${sceneId}`, { remove: [virviParcels.id] })
    expect(res.json().removals).toEqual([expect.objectContaining({ kind: 'dcl_parcels', label: `Remove the scene from Genesis City parcels ${PARCEL}`, status: 'done' })])
    expect(catalyst.deployed).toHaveLength(1)
    const entity = JSON.parse(new TextDecoder().decode(catalyst.deployed[0].files.get(catalyst.deployed[0].entityId)!))
    expect(entity).toMatchObject({ type: 'scene', pointers: [PARCEL], metadata: { scene: { base: PARCEL, parcels: [PARCEL] }, display: { title: 'Empty parcels' } } })
    expect(chainSigner(catalyst.deployed[0].authChain)).toBe(virviParcelSigner()!.address)
    expect(await destRow(virviParcels.id)).toBeUndefined()

    // A second scene's parcels, signed in the browser
    sceneId = (await createScene(user, 'Second')).scene.id
    const signed = await insertParcels({ mode: 'sign', grantedAt: null })
    const [removal] = (await call('DELETE', `/api/scenes/${sceneId}`, { remove: [signed.id] })).json().removals
    expect(removal.status).toBe('awaiting_signature')
    const sign = (await call('GET', `/api/scenes/${sceneId}/removals/${removal.id}/sign`)).json()
    expect(sign.kind).toBe('entity')
    const ok = await call('POST', `/api/scenes/${sceneId}/removals/${removal.id}/signature`, { chain: await chainFor(ownerKey, sign.payload) })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().removal.status).toBe('done')
    expect(catalyst.deployed).toHaveLength(2)
    expect(catalyst.deployed[1].entityId).toBe(sign.payload)
    expect(await destRow(signed.id)).toBeUndefined()
  })

  it('a self-run Hyperfy world is unlinked: its key stops working', async () => {
    const [w] = await db.insert(hyperfyWorlds).values({ sceneId, ownerId: user.id, name: 'Mine', keyHash: 'self-hash', keyPrefix: 'virviw_self' }).returning()
    const plan = (await call('GET', `/api/scenes/${sceneId}/delete-plan`)).json()
    expect(plan.running).toEqual([expect.objectContaining({ id: w.id, kind: 'hyperfy_world', label: 'Remove the scene from Mine (Hyperfy)' })])
    const res = await call('DELETE', `/api/scenes/${sceneId}`, { remove: [w.id] })
    expect(res.json().removals).toEqual([expect.objectContaining({ status: 'done' })])
    expect(await db.select().from(hyperfyWorlds)).toEqual([])
  })

  it("a deployment left up stays connected while deleted, comes back on restore, and nothing deploys meanwhile", async () => {
    const dest = await insertWorld()
    expect((await call('DELETE', `/api/scenes/${sceneId}`)).statusCode).toBe(200)
    await expect(startVirviDeploy(dest.id, user.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(await sweepRedeploys(new Date())).toEqual({ started: 0, marked: 0 })
    expect(worlds.signed).toHaveLength(0)
    // Its World says which deleted scene still holds it
    const lookup = (await call('GET', `/api/dcl/worlds/${WORLD}`)).json()
    expect(lookup.connectedScene).toMatchObject({ sceneId, name: 'Cafe (deleted)', canDisconnect: false })
    expect((await call('POST', `/api/scenes/${sceneId}/restore`)).statusCode).toBe(200)
    expect(await destRow(dest.id)).toBeDefined()
    expect((await call('GET', `/api/scenes/${sceneId}/dcl/destinations`)).json().destinations).toHaveLength(1)
  })
})
