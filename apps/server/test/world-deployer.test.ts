import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { Wallet } from 'ethers'
import { and, eq, isNull } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { analyticsScenes, assetLibraryItems, dclWorldDestinations, locationSetups, sceneDeployments, scenes } from '../src/db/schema.js'
import { chainSigner, verifyChain, virviSigner } from '../src/services/dcl/entity.js'
import { setWorldsClient, WorldsError, type LiveEntity } from '../src/services/dcl/worlds-client.js'
import { DCL_RUNTIME_VERSION } from '../src/services/dcl/runtime.js'
import {
  DEPLOY_WINDOW_MS, DeployerError, liveBaseFor, prepareSignedDeploy, sceneLimitProblem, sceneTriangleWarning, startVirviDeploy,
  submitSignedDeploy, whenSettled,
} from '../src/services/dcl/world-deployer.js'
import { modelsInScene } from '../src/services/dcl/assemble.js'
import { getActiveSetup, linkWorldLocation } from '../src/setup/setups.js'
import { resetDb } from './helpers/db.js'
import { createElement, createInstance, createScene, createUser } from './helpers/factories.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'

const CDN = 'https://cdn.virvi.test'
const WORLD = 'cafe.dcl.eth'
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

type Identity = ReturnType<typeof createUnsafeIdentity>
async function ownerChain(wallet: Identity, payload: string) {
  const identity = await Authenticator.initializeAuthChain(
    wallet.address, createUnsafeIdentity(), 10, async (m) => Authenticator.createSignature(wallet, m),
  )
  return Authenticator.signPayload(identity, payload)
}

let fake: FakeWorldsClient
let saved: { cdnUrl: string | null; key: string | null }
const cfg = config as { cdnUrl: string | null; virviDclDeployKey: string | null }
const fetcher = vi.fn(async (url: string) => enc(`bytes of ${url}`))

beforeEach(async () => {
  await resetDb()
  saved = { cdnUrl: cfg.cdnUrl, key: cfg.virviDclDeployKey }
  cfg.cdnUrl = CDN
  cfg.virviDclDeployKey = Wallet.createRandom().privateKey
  fake = new FakeWorldsClient()
  setWorldsClient(fake)
  fetcher.mockClear()
})
afterEach(() => {
  cfg.cdnUrl = saved.cdnUrl
  cfg.virviDclDeployKey = saved.key
  setWorldsClient(null)
  vi.useRealTimers()
})

async function setup(opts: { mode?: 'virvi' | 'sign'; granted?: boolean; models?: string[] } = {}) {
  const owner = createUnsafeIdentity()
  const user = await createUser({ wallet: owner.address })
  const { scene, preset } = await createScene(user, 'Cafe')
  for (const m of opts.models ?? ['a']) {
    await createElement(preset.id, { type: 'model', name: m, properties: { modelSrc: `${CDN}/m/${m}.glb` } })
  }
  const mode = opts.mode ?? 'virvi'
  const [dest] = await db.insert(dclWorldDestinations).values({
    sceneId: scene.id, ownerUserId: user.id, ownerWallet: owner.address.toLowerCase(), worldName: WORLD,
    base: '0,0', parcels: ['0,0', '1,0'], mode,
    grantedAt: (opts.granted ?? mode === 'virvi') ? new Date() : null,
  }).returning()
  return { owner, user, scene, preset, dest }
}

const destRow = async (id: string) => (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, id) }))!
const depRow = async (id: string) => (await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, id) }))!

/** The fake's last deployment as the World's live entity (the fake does not do this itself). */
function goLive(i = fake.deployed.length - 1) {
  const d = fake.deployed[i]
  const e = JSON.parse(dec(d.files.get(d.entityId)!))
  const live: LiveEntity = { id: d.entityId, pointers: e.pointers, content: e.content, metadata: e.metadata }
  fake.entities.set(WORLD, [live])
  return live
}

describe('startVirviDeploy (mode A)', () => {
  it('deploys signed by Virvi, records the destination and links the World', async () => {
    const { user, scene, dest } = await setup()
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    expect(dep).toMatchObject({ status: 'building', platform: 'decentraland', deploymentType: 'world', destinationId: dest.id, target: { world: WORLD, parcels: ['0,0', '1,0'] } })
    await whenSettled(dep.id)

    const row = await depRow(dep.id)
    expect(row.status).toBe('deployed')
    expect(row.deployedAt).not.toBeNull()
    expect(fake.deployed).toHaveLength(1)
    const sent = fake.deployed[0]
    expect(row.catalystEntityId).toBe(sent.entityId)
    const virvi = virviSigner()!.address
    expect(chainSigner(sent.authChain)).toBe(virvi)
    expect(await verifyChain(sent.authChain, sent.entityId, virvi)).toBe(true)
    expect(row.assetBundle).toMatchObject({ progress: { modelsTotal: 1, modelsUploaded: 1 }, refused: [] })

    const entity = JSON.parse(dec(sent.files.get(sent.entityId)!))
    expect(entity.metadata.display.title).toBe('Cafe')
    expect(entity.metadata.spawnPoints[0].position).toEqual({ x: 16, y: 0, z: 1 })

    const d = await destRow(dest.id)
    expect(d.lastEntityId).toBe(sent.entityId)
    expect(d.deployedFiles).toEqual(['bin/index.js', 'images/virvi/hud-v.png', 'models/virvi/a.glb', 'scene.json'])
    expect(d.status).toBe('ok')

    const as = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, `world:${WORLD}`) })
    expect(as).toMatchObject({ kind: 'world', worldName: WORLD, realm: WORLD, virviSceneId: scene.id, activeEntityId: sent.entityId })
    const setupRow = await getActiveSetup(as!.id)
    expect(setupRow).toMatchObject({ virviSceneId: scene.id, deploymentEntityId: sent.entityId, hostUserId: user.id })
  })

  it('uses the stored spawn point', async () => {
    const { user, dest } = await setup()
    await db.update(dclWorldDestinations).set({ spawn: { x: 3, y: 1, z: 4 } }).where(eq(dclWorldDestinations.id, dest.id))
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    const sent = fake.deployed[0]
    expect(JSON.parse(dec(sent.files.get(sent.entityId)!)).metadata.spawnPoints[0].position).toEqual({ x: 3, y: 1, z: 4 })
  })

  it('refuses without a grant or without the deploy key, creating no row', async () => {
    const { user, dest } = await setup({ granted: false })
    await expect(startVirviDeploy(dest.id, user.id)).rejects.toMatchObject({ status: 409, code: 'not_granted' })
    await db.update(dclWorldDestinations).set({ grantedAt: new Date() }).where(eq(dclWorldDestinations.id, dest.id))
    cfg.virviDclDeployKey = null
    await expect(startVirviDeploy(dest.id, user.id)).rejects.toMatchObject({ status: 503, code: 'virvi_deploys_unavailable' })
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
  })

  it("fails in plain words with Decentraland's reason and leaves the destination unchanged", async () => {
    const { user, dest } = await setup()
    fake.failNext = new WorldsError(400, 'bad')
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    const row = await depRow(dep.id)
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toMatch(/Decentraland/)
    expect(row.errorMessage).toMatch(/bad/)
    const d = await destRow(dest.id)
    expect(d.lastEntityId).toBeNull()
    expect(d.deployedFiles).toEqual([])
    expect(await db.select().from(locationSetups)).toHaveLength(0)
  })

  it('never blocks on a refused model, and records it', async () => {
    const { user, preset, dest } = await setup()
    await createElement(preset.id, { type: 'model', name: 'evil', properties: { modelSrc: 'https://evil.example/x.glb' } })
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    const row = await depRow(dep.id)
    expect(row.status).toBe('deployed')
    expect((row.assetBundle as { refused: Array<{ name: string }> }).refused.map((r) => r.name)).toEqual(['evil'])
  })

  it('redeploys from the live entity, uploading only the new model', async () => {
    const { user, preset, dest } = await setup()
    await whenSettled((await startVirviDeploy(dest.id, user.id, { fetch: fetcher })).id)
    const live = goLive()
    await createElement(preset.id, { type: 'model', name: 'b', properties: { modelSrc: `${CDN}/m/b.glb` } })

    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    expect((await depRow(dep.id)).status).toBe('deployed')
    const sent = fake.deployed[1]
    expect(sent.files.size).toBe(2) // entity + b.glb
    const entity = JSON.parse(dec(sent.files.get(sent.entityId)!))
    for (const c of live.content) expect(entity.content).toContainEqual(c)
    expect((await destRow(dest.id)).deployedFiles).toContain('models/virvi/b.glb')
  })

  it('stops for review when the World changed outside Virvi', async () => {
    const { user, dest } = await setup()
    await whenSettled((await startVirviDeploy(dest.id, user.id, { fetch: fetcher })).id)
    const live = goLive()
    fake.entities.set(WORLD, [{ ...live, id: 'bafysomeoneelse' }])

    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    const row = await depRow(dep.id)
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toMatch(/changed outside Virvi/)
    expect(fake.deployed).toHaveLength(1)
    const d = await destRow(dest.id)
    expect(d).toMatchObject({ status: 'needs_review', statusDetail: 'Your World changed outside Virvi' })
  })
})

describe('liveBaseFor', () => {
  it('returns the live entity at the base, or null on a fresh destination', async () => {
    const { dest } = await setup()
    expect(await liveBaseFor(dest)).toBeNull()
    const e: LiveEntity = { id: 'bafyx', pointers: ['0,0'], content: [], metadata: {} as LiveEntity['metadata'] }
    fake.entities.set(WORLD, [{ ...e, id: 'bafyother', pointers: ['5,5'] }, e])
    expect((await liveBaseFor(dest))?.id).toBe('bafyx')
  })

  it('flags a changed World (adopted too) as needs_review with 409', async () => {
    const { dest } = await setup()
    await db.update(dclWorldDestinations).set({ lastEntityId: 'bafymine', adopted: true }).where(eq(dclWorldDestinations.id, dest.id))
    fake.entities.set(WORLD, [{ id: 'bafytheirs', pointers: ['0,0'], content: [], metadata: {} as LiveEntity['metadata'] }])
    const err = await liveBaseFor(await destRow(dest.id)).catch((e) => e)
    expect(err).toBeInstanceOf(DeployerError)
    expect(err).toMatchObject({ status: 409, code: 'needs_review' })
    expect((await destRow(dest.id)).status).toBe('needs_review')
  })

  it('a World that cannot be read is unreachable (503), never "empty"', async () => {
    const { dest } = await setup()
    fake.down = true
    await expect(liveBaseFor(dest)).rejects.toMatchObject({ status: 503, code: 'world_unreachable' })
    expect((await destRow(dest.id)).status).toBe('unreachable')
  })
})

describe('prepareSignedDeploy / submitSignedDeploy (mode B)', () => {
  it('deploys with the owner signature over the payload', async () => {
    const { owner, user, scene, dest } = await setup({ mode: 'sign' })
    const prep = await prepareSignedDeploy(dest.id, user.id, { fetch: fetcher })
    expect(prep.deployment.status).toBe('awaiting_signature')
    const bundle = prep.deployment.assetBundle as Record<string, unknown>
    expect(prep.payload).toBe(bundle.entityId)
    expect(new Date(prep.expiresAt).getTime()).toBe((bundle.timestamp as number) + DEPLOY_WINDOW_MS)
    // Enough to rebuild, never the model bytes.
    expect(JSON.stringify(bundle)).not.toContain(Buffer.from(`bytes of ${CDN}/m/a.glb`).toString('base64'))
    expect(bundle.newFiles).toContainEqual(expect.objectContaining({ file: 'models/virvi/a.glb', url: `${CDN}/m/a.glb` }))
    expect(bundle.newFiles).toContainEqual(expect.objectContaining({ file: 'bin/index.js', runtimeVersion: DCL_RUNTIME_VERSION }))
    expect(bundle.newFiles).toContainEqual(expect.objectContaining({ file: 'images/virvi/hud-v.png', runtimeVersion: DCL_RUNTIME_VERSION }))
    expect(fake.deployed).toHaveLength(0)

    const done = await submitSignedDeploy(prep.deployment.id, await ownerChain(owner, prep.payload), { fetch: fetcher })
    expect(done.status).toBe('deployed')
    expect(fake.deployed).toHaveLength(1)
    expect(fake.deployed[0].entityId).toBe(prep.payload)
    expect(chainSigner(fake.deployed[0].authChain)).toBe(owner.address.toLowerCase())
    expect((await destRow(dest.id)).lastEntityId).toBe(prep.payload)
    const as = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, `world:${WORLD}`) })
    expect((await getActiveSetup(as!.id))?.virviSceneId).toBe(scene.id)
  })

  it('is expired 241 s after prepare, with nothing uploaded', async () => {
    const { owner, user, dest } = await setup({ mode: 'sign' })
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    vi.setSystemTime(t0)
    const prep = await prepareSignedDeploy(dest.id, user.id, { fetch: fetcher })
    const chain = await ownerChain(owner, prep.payload)
    vi.setSystemTime(t0 + 241_000)
    await expect(submitSignedDeploy(prep.deployment.id, chain, { fetch: fetcher })).rejects.toMatchObject({ status: 409, code: 'expired' })
    expect(fake.deployed).toHaveLength(0)
    expect((await depRow(prep.deployment.id)).status).toBe('failed')
  })

  it('slow packing gets a fresh timestamp, so the full signing window remains', async () => {
    const { owner, user, dest } = await setup({ mode: 'sign' })
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    vi.setSystemTime(t0)
    const slow = vi.fn(async (url: string) => { vi.setSystemTime(Date.now() + 60_000); return enc(`bytes of ${url}`) })
    const prep = await prepareSignedDeploy(dest.id, user.id, { fetch: slow })
    expect((prep.deployment.assetBundle as { timestamp: number }).timestamp).toBe(t0 + 60_000)
    expect(new Date(prep.expiresAt).getTime()).toBe(t0 + 60_000 + DEPLOY_WINDOW_MS)
    vi.setSystemTime(t0 + 60_000 + 200_000)
    const done = await submitSignedDeploy(prep.deployment.id, await ownerChain(owner, prep.payload), { fetch: fetcher })
    expect(done.status).toBe('deployed')
  })

  it("rejects another wallet's chain with 403, with nothing uploaded", async () => {
    const { user, dest } = await setup({ mode: 'sign' })
    const prep = await prepareSignedDeploy(dest.id, user.id, { fetch: fetcher })
    const err = await submitSignedDeploy(prep.deployment.id, await ownerChain(createUnsafeIdentity(), prep.payload), { fetch: fetcher }).catch((e) => e)
    expect(err).toMatchObject({ status: 403, code: 'not_world_owner' })
    expect(fake.deployed).toHaveLength(0)
    expect((await depRow(prep.deployment.id)).status).toBe('awaiting_signature')
  })

  it('refuses to upload when the rebuilt entity differs (500 entity_mismatch)', async () => {
    const { owner, user, dest } = await setup({ mode: 'sign' })
    const prep = await prepareSignedDeploy(dest.id, user.id, { fetch: fetcher })
    const changed = vi.fn(async () => enc('different bytes'))
    await expect(submitSignedDeploy(prep.deployment.id, await ownerChain(owner, prep.payload), { fetch: changed }))
      .rejects.toMatchObject({ status: 500, code: 'entity_mismatch' })
    expect(fake.deployed).toHaveLength(0)
  })

  it('a submitted deployment cannot be submitted again', async () => {
    const { owner, user, dest } = await setup({ mode: 'sign' })
    const prep = await prepareSignedDeploy(dest.id, user.id, { fetch: fetcher })
    const chain = await ownerChain(owner, prep.payload)
    await submitSignedDeploy(prep.deployment.id, chain, { fetch: fetcher })
    await expect(submitSignedDeploy(prep.deployment.id, chain, { fetch: fetcher })).rejects.toMatchObject({ status: 409 })
    expect(fake.deployed).toHaveLength(1)
  })
})

describe('every deploy path checks first', () => {
  /** 3 placed trees of 8,000 triangles: 24,000, over the 20,000 two parcels allow. */
  async function overBudget(mode: 'virvi' | 'sign') {
    const s = await setup({ mode, models: [] })
    await db.insert(assetLibraryItems).values({ name: 'tree', storageKey: 'k', cdnUrl: `${CDN}/m/tree.glb`, triangleCount: 8_000 })
    const el = await createElement(s.preset.id, { type: 'model', name: 'tree', properties: { modelSrc: `${CDN}/m/tree.glb` } })
    for (let i = 0; i < 3; i++) await createInstance(el.id)
    return s
  }

  it.each(['virvi', 'sign'] as const)('mode %s over the triangle budget still deploys: Decentraland only warns', async (mode) => {
    const { user, dest } = await overBudget(mode)
    const start = mode === 'virvi' ? startVirviDeploy : prepareSignedDeploy
    await start(dest.id, user.id, { fetch: fetcher })
    expect(await db.select().from(sceneDeployments)).toHaveLength(1)
    expect((await destRow(dest.id)).status).not.toBe('over_budget')
  })

  it('a scene over its triangle budget gets a warning, not a problem', async () => {
    const { dest } = await overBudget('virvi')
    const models = await modelsInScene(dest.sceneId)
    expect(sceneLimitProblem(dest, models)).toBeNull()
    expect(sceneTriangleWarning(dest, models)).toBe(
      'Your scene has 24,000 triangles, more than the 20,000 Decentraland recommends for your 2 parcels. It still deploys, but it may run slowly for visitors.')
    expect(sceneTriangleWarning(dest, [{ ...models[0], triangles: null, instances: 1 }, { ...models[0], instances: 3 }]))
      .toMatch(/1 model has no triangle count yet and counted as 0\.$/)
    expect(sceneTriangleWarning(dest, [{ ...models[0], instances: 1 }])).toBeNull()
  })

  it('too many placed models is still a problem', async () => {
    const { dest } = await overBudget('virvi')
    const [model] = await modelsInScene(dest.sceneId)
    expect(sceneLimitProblem(dest, [{ ...model, triangles: 1, instances: 1_000 }])).toMatch(/1,000 placed models/)
  })

  it('new model bytes over the World storage left is 422 over_budget', async () => {
    const { user, dest } = await setup({ mode: 'sign' })
    await db.insert(assetLibraryItems).values({ name: 'a', storageKey: 'k', cdnUrl: `${CDN}/m/a.glb`, triangleCount: 10, fileSizeBytes: 5_000 })
    fake.stats.set(dest.ownerWallet, { maxAllowedBytes: 10_000, usedBytes: 8_000 })
    await expect(prepareSignedDeploy(dest.id, user.id, { fetch: fetcher })).rejects.toMatchObject({ status: 422, code: 'over_budget' })
    expect((await destRow(dest.id)).statusDetail).toMatch(/storage/)
  })

  it('a redeploy that would change nothing is not signed or uploaded', async () => {
    const { user, dest } = await setup()
    await whenSettled((await startVirviDeploy(dest.id, user.id, { fetch: fetcher })).id)
    goLive()
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    expect(fake.deployed).toHaveLength(1)
    const row = await depRow(dep.id)
    expect(row.status).not.toBe('deployed')
    expect(row.errorMessage).toMatch(/already has everything/)
    expect((await destRow(dest.id)).status).toBe('ok')

    await db.update(dclWorldDestinations).set({ mode: 'sign' }).where(eq(dclWorldDestinations.id, dest.id))
    await expect(prepareSignedDeploy(dest.id, user.id, { fetch: fetcher })).rejects.toMatchObject({ status: 409, code: 'nothing_to_deploy' })
  })

  it('a redeploy after renaming the scene deploys the new title', async () => {
    const { user, dest } = await setup()
    await whenSettled((await startVirviDeploy(dest.id, user.id, { fetch: fetcher })).id)
    goLive()
    await db.update(scenes).set({ name: 'Renamed scene' }).where(eq(scenes.id, dest.sceneId))
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    expect(fake.deployed).toHaveLength(2)
    expect((await depRow(dep.id)).status).toBe('deployed')
    const sent = fake.deployed[1]
    expect(JSON.parse(dec(sent.files.get(sent.entityId)!)).metadata.display.title).toBe('Renamed scene')
  })

  it('a World wrongly marked adopted whose live scene runs the Virvi runtime is treated as Virvi-built: a rename deploys', async () => {
    const { user, dest } = await setup()
    await whenSettled((await startVirviDeploy(dest.id, user.id, { fetch: fetcher })).id)
    goLive()
    await db.update(dclWorldDestinations).set({ adopted: true }).where(eq(dclWorldDestinations.id, dest.id))
    await db.update(scenes).set({ name: 'Renamed scene' }).where(eq(scenes.id, dest.sceneId))
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    expect((await depRow(dep.id)).status).toBe('deployed')
    const sent = fake.deployed[1]
    expect(JSON.parse(dec(sent.files.get(sent.entityId)!)).metadata.display.title).toBe('Renamed scene')
    expect((await destRow(dest.id)).adopted).toBe(false) // healed, so the dashboard offers renames again
  })

  it('a redeploy whose only new model is refused says which and why, and needs a look', async () => {
    const { user, preset, dest } = await setup()
    await whenSettled((await startVirviDeploy(dest.id, user.id, { fetch: fetcher })).id)
    goLive()
    await createElement(preset.id, { type: 'model', name: 'Evil chair', properties: { modelSrc: 'https://evil.example/x.glb' } })
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    expect(fake.deployed).toHaveLength(1)
    expect((await depRow(dep.id)).errorMessage).toMatch(/Evil chair/)
    expect(await destRow(dest.id)).toMatchObject({ status: 'needs_review', statusDetail: expect.stringMatching(/Evil chair.*not hosted by Virvi/) })
  })

  it('an unexpected error is reported in plain words, never the raw message', async () => {
    const { user, dest } = await setup()
    fake.deploy = async () => { throw new Error('relation "secret_table" does not exist') }
    const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
    await whenSettled(dep.id)
    const row = await depRow(dep.id)
    expect(row.status).toBe('failed')
    expect(row.errorMessage).not.toMatch(/secret_table/)
    expect(row.errorMessage).toMatch(/went wrong/)
  })

  it('a generated file too big to keep for signing is a DeployerError, not a bare 500', async () => {
    const { user, dest } = await setup({ mode: 'sign' })
    await db.update(scenes).set({ name: 'x'.repeat(70_000) }).where(eq(scenes.id, dest.sceneId))
    const err = await prepareSignedDeploy(dest.id, user.id, { fetch: fetcher }).catch((e) => e)
    expect(err).toBeInstanceOf(DeployerError)
    expect(err.message).not.toMatch(/scene\.json/)
  })
})

describe('linkWorldLocation', () => {
  it("replaces another scene's setup, ending it with 'replaced'", async () => {
    const u = await createUser()
    const { scene: a } = await createScene(u, 'A')
    const { scene: b } = await createScene(u, 'B')
    await linkWorldLocation({ world: WORLD, virviSceneId: a.id, hostUserId: u.id, entityId: 'bafy1', title: 'A' })
    await linkWorldLocation({ world: WORLD, virviSceneId: b.id, hostUserId: u.id, entityId: 'bafy2', title: 'B' })
    const rows = await db.select().from(locationSetups)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.virviSceneId === a.id)).toMatchObject({ endReason: 'replaced' })
    expect(rows.find((r) => r.virviSceneId === a.id)!.endedAt).not.toBeNull()
    expect(rows.find((r) => r.virviSceneId === b.id)).toMatchObject({ endedAt: null, deploymentEntityId: 'bafy2' })
    const as = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, `world:${WORLD}`) })
    expect(as!.virviSceneId).toBe(b.id)
  })

  it('linking the same scene twice keeps one active setup and updates its entity', async () => {
    const u = await createUser()
    const { scene } = await createScene(u, 'A')
    await linkWorldLocation({ world: WORLD, virviSceneId: scene.id, hostUserId: u.id, entityId: 'bafy1', title: 'A' })
    await linkWorldLocation({ world: WORLD, virviSceneId: scene.id, hostUserId: u.id, entityId: 'bafy2', title: 'A' })
    const active = await db.select().from(locationSetups).where(and(eq(locationSetups.virviSceneId, scene.id), isNull(locationSetups.endedAt)))
    expect(active).toHaveLength(1)
    expect(active[0].deploymentEntityId).toBe('bafy2')
    expect(await db.select().from(locationSetups)).toHaveLength(1)
  })
})
