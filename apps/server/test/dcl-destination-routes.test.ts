import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, dclWorldDestinations, sceneDeployments } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { dclHash, signedFetchPayload, virviSigner } from '../src/services/dcl/entity.js'
import { setWorldsClient, WorldsError, type LiveEntity } from '../src/services/dcl/worlds-client.js'
import { startVirviDeploy, whenSettled } from '../src/services/dcl/world-deployer.js'
import { resetDb } from './helpers/db.js'
import { createElement, createInstance, createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'

const WORLD = 'cafe.dcl.eth'
const CDN = 'https://cdn.virvi.test'
type Identity = ReturnType<typeof createUnsafeIdentity>

async function chainFor(wallet: Identity, payload: string) {
  const identity = await Authenticator.initializeAuthChain(
    wallet.address, createUnsafeIdentity(), 10, async (m) => Authenticator.createSignature(wallet, m),
  )
  return Authenticator.signPayload(identity, payload)
}

function liveEntity(id: string, parcels: string[], files: string[] = ['bin/index.js', 'scene.json', 'models/Tree.glb']): LiveEntity {
  return {
    id,
    pointers: parcels,
    content: files.map((file, i) => ({ file, hash: `bafy${id}${i}` })),
    metadata: {
      display: { title: 'Live' }, scene: { parcels, base: parcels[0] }, main: 'bin/index.js', ecs7: true,
      runtimeVersion: '7', worldConfiguration: { name: WORLD }, spawnPoints: [],
    },
  }
}

describe('World destination routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let worlds: FakeWorldsClient
  let dir: FakeDclDirectory
  let owner: Identity
  let user: TestUser
  let virvi: string
  const cfg = config as { virviDclDeployKey: string | null; cdnUrl: string | null; webAppUrl: string }
  const saved = { key: cfg.virviDclDeployKey, cdn: cfg.cdnUrl }

  beforeEach(async () => {
    await resetDb()
    cfg.virviDclDeployKey = Wallet.createRandom().privateKey
    cfg.cdnUrl = CDN
    virvi = virviSigner()!.address
    worlds = new FakeWorldsClient()
    dir = new FakeDclDirectory()
    setWorldsClient(worlds)
    setDclDirectory(dir)
    owner = createUnsafeIdentity()
    user = await createUser({ wallet: owner.address })
    worlds.deployers.set(WORLD, { owner: user.wallet, deployers: [] })
    app = await testApp()
  })
  afterEach(async () => {
    cfg.virviDclDeployKey = saved.key
    cfg.cdnUrl = saved.cdn
    setWorldsClient(null)
    setDclDirectory(null)
    await app.close()
  })

  const auth = (u: TestUser, extra: Record<string, unknown> = {}) => ({ authorization: `Bearer ${tokenFor(u, extra)}` })
  const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, u: TestUser = user) =>
    app.inject({ method, url, headers: auth(u), ...(payload === undefined ? {} : { payload: payload as object }) })
  const destRows = () => db.select().from(dclWorldDestinations)
  const destRow = async (id: string) => (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, id) }))!

  async function insertDest(sceneId: string, o: Partial<typeof dclWorldDestinations.$inferInsert> = {}) {
    const [d] = await db.insert(dclWorldDestinations).values({
      sceneId, ownerUserId: user.id, ownerWallet: user.wallet!, worldName: WORLD, base: '0,0', parcels: ['0,0', '1,0'], mode: 'virvi', ...o,
    }).returning()
    return d
  }

  describe('GET /api/dcl/names', () => {
    it("lists the wallet's names with hasScene, footprint and storage", async () => {
      dir.ownedNames.set(user.wallet!, [WORLD, 'empty.dcl.eth'])
      worlds.entities.set(WORLD, [liveEntity('e1', ['5,5', '5,6'])])
      worlds.stats.set(user.wallet!, { maxAllowedBytes: 100_000_000, usedBytes: 2_000 })
      const res = await req('GET', '/api/dcl/names')
      expect(res.statusCode).toBe(200)
      const storage = { maxAllowedBytes: 100_000_000, usedBytes: 2_000 }
      expect(res.json()).toEqual({
        wallets: [{
          address: user.wallet,
          names: [
            { world: WORLD, hasScene: true, footprint: { base: '5,5', parcels: ['5,5', '5,6'] }, storage },
            { world: 'empty.dcl.eth', hasScene: false, footprint: null, storage },
          ],
        }],
      })
    })

    it('says the World is unreachable, never empty, when Decentraland fails', async () => {
      dir.ownedNames.set(user.wallet!, [WORLD])
      worlds.getWorldEntities = async () => { throw new WorldsError(404, '', 'unresolvable') }
      const res = await req('GET', '/api/dcl/names')
      expect([res.statusCode, res.json().error]).toEqual([502, 'world_unreachable'])
    })
  })

  it('GET /api/dcl/worlds/:world describes one typed name and whether the caller owns it', async () => {
    worlds.entities.set('me.eth', [liveEntity('e2', ['0,0'])])
    worlds.deployers.set('me.eth', { owner: user.wallet, deployers: [] })
    const mine = await req('GET', '/api/dcl/worlds/ME.eth')
    expect(mine.statusCode).toBe(200)
    expect(mine.json()).toMatchObject({ world: 'me.eth', hasScene: true, footprint: { base: '0,0', parcels: ['0,0'] }, owner: true })
    worlds.deployers.set('other.dcl.eth', { owner: '0x' + 'b'.repeat(40), deployers: [] })
    const theirs = await req('GET', '/api/dcl/worlds/other.dcl.eth')
    expect(theirs.json()).toMatchObject({ world: 'other.dcl.eth', hasScene: false, footprint: null, owner: false })
    expect((await req('GET', '/api/dcl/worlds/not a name')).statusCode).toBe(400)
  })

  describe('POST /api/dcl/destinations', () => {
    const plot = { width: 2, depth: 2, base: { x: 0, y: 0 } }

    it('creates a wizard destination on an empty World from the plot and spawn', async () => {
      const { scene } = await createScene(user)
      const res = await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'sign', plot, spawn: { x: 3, z: 4 } })
      expect(res.statusCode).toBe(201)
      const { destination, replaces } = res.json()
      expect(replaces).toBeUndefined()
      expect(destination).toMatchObject({
        sceneId: scene.id, worldName: WORLD, base: '0,0', parcels: ['0,0', '1,0', '0,1', '1,1'], mode: 'sign',
        ownerUserId: user.id, ownerWallet: user.wallet, grantedAt: null, adopted: false, spawn: { x: 3, y: 0, z: 4 },
      })
    })

    it("moves the plot onto the World's live scene and says what it replaces", async () => {
      const { scene } = await createScene(user)
      worlds.entities.set(WORLD, [liveEntity('e1', ['5,5', '5,6'])])
      const res = await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'virvi', plot })
      expect(res.statusCode).toBe(201)
      expect(res.json().destination).toMatchObject({ base: '5,5', parcels: ['5,5', '6,5', '5,6', '6,6'], lastEntityId: null })
      expect(res.json().replaces).toEqual({ parcels: ['5,5', '5,6'] })
    })

    it('refuses a caller whose wallet does not own the World (no rows)', async () => {
      const { scene } = await createScene(user)
      worlds.deployers.set(WORLD, { owner: '0x' + 'b'.repeat(40), deployers: [] })
      const res = await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'virvi', plot })
      expect([res.statusCode, res.json().error]).toEqual([403, 'not_world_owner'])
      expect(await destRows()).toHaveLength(0)
    })

    it('needs full access to the scene', async () => {
      const other = await createUser({ wallet: '0x' + 'c'.repeat(40) })
      const { scene } = await createScene(other)
      const res = await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'virvi', plot })
      expect(res.statusCode).toBe(403)
      expect(await destRows()).toHaveLength(0)
    })

    it('rejects a bad body', async () => {
      const { scene } = await createScene(user)
      for (const body of [
        { sceneId: scene.id, world: WORLD, mode: 'x', plot },
        { sceneId: scene.id, world: WORLD, mode: 'sign', plot: { width: 0, depth: 1, base: { x: 0, y: 0 } } },
        { sceneId: scene.id, world: 'bad/name', mode: 'sign', plot },
        { sceneId: 'nope', world: WORLD, mode: 'sign', plot },
        { sceneId: scene.id, world: WORLD, mode: 'sign', plot, spawn: { x: 'a', z: 1 } },
      ]) {
        expect((await req('POST', '/api/dcl/destinations', body)).statusCode).toBe(400)
      }
    })

    it('a second destination for the same World is 409 world_in_use', async () => {
      const { scene } = await createScene(user)
      const { scene: second } = await createScene(user, 'Second')
      expect((await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'sign', plot })).statusCode).toBe(201)
      const res = await req('POST', '/api/dcl/destinations', { sceneId: second.id, world: WORLD, mode: 'sign', plot })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'world_in_use', sceneId: scene.id })
      expect(await destRows()).toHaveLength(1)
    })

    it('adopting needs a live scene set up for this Virvi scene', async () => {
      const { scene } = await createScene(user)
      worlds.entities.set(WORLD, [liveEntity('e1', ['2,2', '3,2'])])
      const res = await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'sign' })
      expect([res.statusCode, res.json().error]).toEqual([400, 'not_connected'])

      // Set up for another scene: still not connected
      const { scene: other } = await createScene(user, 'Other')
      const loc = await createAnalyticsScene({ kind: 'world', locationKey: `world:${WORLD}`, realm: WORLD, worldName: WORLD, baseParcel: '2,2', parcels: ['2,2', '3,2'] })
      await createSetup(loc.id, other.id)
      expect((await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'sign' })).json().error).toBe('not_connected')
      expect(await destRows()).toHaveLength(0)
    })

    it('adopts the live scene: base, parcels, entity and files come from it', async () => {
      const { scene } = await createScene(user)
      worlds.entities.set(WORLD, [liveEntity('e1', ['2,2', '3,2'], ['bin/index.js', 'scene.json', 'Models/Tree.GLB'])])
      const loc = await createAnalyticsScene({ kind: 'world', locationKey: `world:${WORLD}`, realm: WORLD, worldName: WORLD, baseParcel: '2,2', parcels: ['2,2', '3,2'] })
      await createSetup(loc.id, scene.id)
      const res = await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'sign' })
      expect(res.statusCode).toBe(201)
      expect(res.json().destination).toMatchObject({
        base: '2,2', parcels: ['2,2', '3,2'], lastEntityId: 'e1', adopted: true,
        deployedFiles: ['bin/index.js', 'scene.json', 'models/tree.glb'],
      })
    })

    it("connecting a World whose live scene Virvi built doesn't adopt it: Virvi still owns its scene.json", async () => {
      const { scene } = await createScene(user)
      const built = liveEntity('e1', ['2,2'])
      built.metadata = { ...built.metadata, virvi: { apiUrl: 'https://virvi.io', wssUrl: 'wss://virvi.io', runtime: 3 } }
      worlds.entities.set(WORLD, [built])
      const loc = await createAnalyticsScene({ kind: 'world', locationKey: `world:${WORLD}`, realm: WORLD, worldName: WORLD, baseParcel: '2,2', parcels: ['2,2'] })
      await createSetup(loc.id, scene.id)
      const res = await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'sign' })
      expect(res.statusCode).toBe(201)
      expect(res.json().destination).toMatchObject({ lastEntityId: 'e1', adopted: false })
    })

    it('adopting an empty World is refused', async () => {
      const { scene } = await createScene(user)
      const res = await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'sign' })
      expect([res.statusCode, res.json().error]).toEqual([400, 'no_live_scene'])
    })

    it('a World read failure is 502 world_unreachable', async () => {
      const { scene } = await createScene(user)
      worlds.down = true
      const res = await req('POST', '/api/dcl/destinations', { sceneId: scene.id, world: WORLD, mode: 'sign', plot })
      expect([res.statusCode, res.json().error]).toEqual([502, 'world_unreachable'])
      expect(await destRows()).toHaveLength(0)
    })
  })

  describe('GET and PATCH /api/dcl/destinations/:id', () => {
    it('shows the destination with pending models and the last deployment', async () => {
      const { scene, preset } = await createScene(user)
      await createElement(preset.id, { type: 'model', name: 'Tree', properties: { modelSrc: `${CDN}/m/tree.glb` } })
      await createElement(preset.id, { type: 'model', name: 'Bench', properties: { modelSrc: `${CDN}/m/bench.glb` } })
      const dest = await insertDest(scene.id, { deployedFiles: ['models/virvi/tree.glb'] })
      const [dep] = await db.insert(sceneDeployments).values({
        sceneId: scene.id, platform: 'decentraland', deploymentType: 'world', destinationId: dest.id, target: {}, status: 'deployed',
        assetBundle: { refused: [{ name: 'Big', reason: 'too big' }] },
      }).returning()
      const res = await req('GET', `/api/dcl/destinations/${dest.id}`)
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.destination.id).toBe(dest.id)
      expect(body.pending.map((p: any) => p.file)).toEqual(['models/virvi/bench.glb'])
      expect(body.refused).toEqual([{ name: 'Big', reason: 'too big' }])
      expect(body.lastDeployment.id).toBe(dep.id)

      const stranger = await createUser({ wallet: '0x' + 'd'.repeat(40) })
      expect((await req('GET', `/api/dcl/destinations/${dest.id}`, undefined, stranger)).statusCode).toBe(404)
      expect((await req('GET', '/api/dcl/destinations/not-a-uuid')).statusCode).toBe(404)
    })

    it('switching to sign clears grantedAt and says how to revoke', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { grantedAt: new Date() })
      const res = await req('PATCH', `/api/dcl/destinations/${dest.id}`, { mode: 'sign' })
      expect(res.statusCode).toBe(200)
      expect(res.json().destination).toMatchObject({ mode: 'sign', grantedAt: null })
      expect(res.json().message).toMatch(/Creator Hub/)
      expect((await req('PATCH', `/api/dcl/destinations/${dest.id}`, { mode: 'nope' })).statusCode).toBe(400)
    })
  })

  describe('grant', () => {
    /** The fake's World state follows the permission calls, as the real server's does. */
    function trackPermissions() {
      const orig = worlds.sendSigned.bind(worlds)
      worlds.sendSigned = async (r, c) => {
        await orig(r, c)
        const d = worlds.deployers.get(WORLD)!
        if (r.method === 'PUT') worlds.deployers.set(WORLD, { ...d, deployers: unique([...d.deployers, virvi]) })
        if (r.method === 'DELETE') worlds.deployers.set(WORLD, { ...d, deployers: d.deployers.filter((x) => x !== virvi) })
      }
    }
    const unique = (xs: string[]) => [...new Set(xs)]
    const sign = (requests: any[]) => Promise.all(requests.map((r: any) => chainFor(owner, r.payload)))

    it('round trip: PUT, parcels POST and a pre-signed rollback; the first two are sent, then grantedAt', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { mode: 'virvi', base: '0,0', parcels: ['0,0', '1,0'] })
      // The World's live scene overlaps the plot and is bigger: its footprint joins the grant
      worlds.entities.set(WORLD, [liveEntity('e1', ['0,0', '0,1', '0,2']), liveEntity('far', ['9,9'])])
      trackPermissions()

      const got = await req('GET', `/api/dcl/destinations/${dest.id}/grant`)
      expect(got.statusCode).toBe(200)
      const { virviAddress, requests } = got.json()
      expect(virviAddress).toBe(virvi)
      expect(requests.map((r: any) => r.purpose)).toEqual(['grant', 'scope', 'rollback'])
      const [put, post, rollback] = requests
      expect(put).toMatchObject({ method: 'PUT', path: `/world/${WORLD}/permissions/deployment/${virvi}`, metadata: '{}' })
      expect(post).toMatchObject({ method: 'POST', path: `/world/${WORLD}/permissions/deployment/address/${virvi}/parcels`, metadata: '{}' })
      expect(rollback).toMatchObject({ method: 'DELETE', path: `/world/${WORLD}/permissions/deployment/${virvi}`, metadata: '{}' })
      expect([...post.body.parcels].sort()).toEqual(['0,0', '0,1', '0,2', '1,0'])
      for (const r of requests) expect(r.payload).toBe(signedFetchPayload(r.method, r.path, r.timestamp, r.metadata))

      const chains = await sign(requests)
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains, timestamp: put.timestamp })
      expect(res.statusCode).toBe(200)
      expect(worlds.signed.map((s) => [s.req.method, s.req.path])).toEqual([['PUT', put.path], ['POST', post.path]])
      expect(worlds.signed[1].req.body).toEqual(post.body)
      expect(worlds.signed[0].chain).toEqual(chains[0])
      expect((await destRow(dest.id)).grantedAt).not.toBeNull()
      expect(res.json().destination.grantedAt).not.toBeNull()
    })

    it('a second grant starts clean: the old parcel list is removed first (the PUT would not reset it)', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { mode: 'virvi' })
      worlds.deployers.set(WORLD, { owner: user.wallet, deployers: [virvi] })
      trackPermissions()
      const { requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json()
      expect(requests.map((r: any) => [r.purpose, r.method])).toEqual([['reset', 'DELETE'], ['grant', 'PUT'], ['scope', 'POST'], ['rollback', 'DELETE']])
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: await sign(requests), timestamp: requests[0].timestamp })
      expect(res.statusCode).toBe(200)
      expect(worlds.signed.map((s) => s.req.method)).toEqual(['DELETE', 'PUT', 'POST'])
    })

    it('when the parcels POST fails, the pre-signed rollback removes the world-wide permission', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id)
      trackPermissions()
      const tracked = worlds.sendSigned
      worlds.sendSigned = async (r, c) => {
        if (r.method === 'POST') throw new WorldsError(400, '{"error":"bad parcels"}')
        return tracked(r, c)
      }
      const { requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json()
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: await sign(requests), timestamp: requests[0].timestamp })
      expect([res.statusCode, res.json().error]).toEqual([502, 'grant_rejected'])
      expect(res.json().message).toMatch(/removed again/)
      expect(worlds.signed.map((s) => s.req.method)).toEqual(['PUT', 'DELETE'])
      expect(worlds.deployers.get(WORLD)!.deployers).toEqual([])
      expect((await destRow(dest.id)).grantedAt).toBeNull()
    })

    it('when the rollback fails too, 502 grant_partial says Virvi can deploy anywhere and how to remove it', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { grantedAt: new Date() })
      trackPermissions()
      const tracked = worlds.sendSigned
      worlds.sendSigned = async (r, c) => {
        if (r.method !== 'PUT') throw new WorldsError(503, '')
        return tracked(r, c)
      }
      const { requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json()
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: await sign(requests), timestamp: requests[0].timestamp })
      expect([res.statusCode, res.json().error]).toEqual([502, 'grant_partial'])
      expect(res.json().message).toMatch(/anywhere in your World/)
      expect(res.json().message).toMatch(/Creator Hub/)
      expect((await destRow(dest.id)).grantedAt).toBeNull()
    })

    it('when the PUT times out (it may have landed), the rollback goes out; each step gets less time than the signature has left', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id)
      trackPermissions()
      const tracked = worlds.sendSigned
      const timeouts: Array<[string, number | undefined]> = []
      worlds.sendSigned = async (r, c, timeoutMs?: number) => {
        timeouts.push([r.method, timeoutMs])
        if (r.method === 'PUT') throw new WorldsError(0, '', 'timed out')
        return tracked(r, c)
      }
      const { requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json()
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: await sign(requests), timestamp: requests[0].timestamp })
      expect([res.statusCode, res.json().error]).toEqual([502, 'grant_rejected'])
      expect(timeouts.map(([m]) => m)).toEqual(['PUT', 'DELETE'])
      expect(worlds.signed.map((s) => s.req.method)).toEqual(['DELETE'])
      for (const [, ms] of timeouts) expect(ms).toBeLessThanOrEqual(60_000)
      expect(timeouts[0][1]!).toBeLessThan(timeouts[1][1]!) // the PUT leaves time for the rollback
    })

    it('an ambiguous PUT failure whose rollback also fails is grant_partial; a plain 4xx is not', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id)
      const status = { put: 503 }
      worlds.sendSigned = async (r) => { throw new WorldsError(r.method === 'PUT' ? status.put : 500, '') }
      let { requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json()
      let res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: await sign(requests), timestamp: requests[0].timestamp })
      expect([res.statusCode, res.json().error]).toEqual([502, 'grant_partial'])

      status.put = 400
      ;({ requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json())
      res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: await sign(requests), timestamp: requests[0].timestamp })
      expect([res.statusCode, res.json().error]).toEqual([502, 'grant_rejected'])
    })

    it('a 404 from the rollback means there was nothing to remove', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id)
      worlds.sendSigned = async (r) => { throw new WorldsError(r.method === 'PUT' ? 0 : 404, '') }
      const { requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json()
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: await sign(requests), timestamp: requests[0].timestamp })
      expect([res.statusCode, res.json().error]).toEqual([502, 'grant_rejected'])
    })

    it('a PUT that fails after the reset says the old permission was removed', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { grantedAt: new Date() })
      worlds.deployers.set(WORLD, { owner: user.wallet, deployers: [virvi] })
      trackPermissions()
      const tracked = worlds.sendSigned
      worlds.sendSigned = async (r, c) => {
        if (r.method === 'PUT') throw new WorldsError(400, 'nope')
        return tracked(r, c)
      }
      const { requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json()
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: await sign(requests), timestamp: requests[0].timestamp })
      expect([res.statusCode, res.json().error]).toEqual([502, 'grant_rejected'])
      expect(res.json().message).toMatch(/earlier permission .*was removed/)
      expect((await destRow(dest.id)).grantedAt).toBeNull()
    })

    it('grant_not_visible clears a stale grantedAt', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { grantedAt: new Date() })
      const { requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json()
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: await sign(requests), timestamp: requests[0].timestamp })
      expect(res.json().error).toBe('grant_not_visible')
      expect((await destRow(dest.id)).grantedAt).toBeNull()
    })

    it("502 grant_not_visible when Virvi isn't listed afterwards", async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id)
      const { requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json()
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: await sign(requests), timestamp: requests[0].timestamp })
      expect([res.statusCode, res.json().error]).toEqual([502, 'grant_not_visible'])
      expect(worlds.signed).toHaveLength(2)
      expect((await destRow(dest.id)).grantedAt).toBeNull()
    })

    it("refuses a signature that isn't the owner's, a stale timestamp and a wrong chain count; sends nothing", async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id)
      const { requests } = (await req('GET', `/api/dcl/destinations/${dest.id}/grant`)).json()
      const ts = requests[0].timestamp
      const stranger = createUnsafeIdentity()
      const bad = await Promise.all(requests.map((r: any) => chainFor(stranger, r.payload)))
      const r1 = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: bad, timestamp: ts })
      expect([r1.statusCode, r1.json().error]).toEqual([403, 'not_world_owner'])

      // Signed by the owner, but over a payload the server didn't derive (another timestamp)
      const forged = await Promise.all(requests.map((r: any) => chainFor(owner, signedFetchPayload(r.method, r.path, ts + 1, r.metadata))))
      const r2 = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: forged, timestamp: ts })
      expect([r2.statusCode, r2.json().error]).toEqual([400, 'invalid_signature'])

      // Past 50 s: Decentraland would refuse it at 60 s, so Virvi refuses first, in plain words
      const old = Date.now() - 51_000
      const stale = await Promise.all(requests.map((r: any) => chainFor(owner, signedFetchPayload(r.method, r.path, old, r.metadata))))
      const r3 = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: stale, timestamp: old })
      expect([r3.statusCode, r3.json().error]).toEqual([400, 'expired'])
      expect(r3.json().message).toMatch(/try again/i)

      const good = await chainFor(owner, requests[0].payload)
      const r4 = await req('POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: [good], timestamp: ts })
      expect(r4.statusCode).toBe(400)
      expect(worlds.signed).toHaveLength(0)
    })

    it('non-owner: grant and deploy are 403 not_world_owner', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { mode: 'sign' })
      worlds.deployers.set(WORLD, { owner: '0x' + 'b'.repeat(40), deployers: [] })
      for (const [method, url, body] of [
        ['GET', `/api/dcl/destinations/${dest.id}/grant`, undefined],
        ['POST', `/api/dcl/destinations/${dest.id}/grant`, { chains: [[], [], []], timestamp: Date.now() }],
        ['DELETE', `/api/dcl/destinations/${dest.id}/grant`, undefined],
        ['POST', `/api/dcl/destinations/${dest.id}/deploy`, {}],
      ] as const) {
        const res = await req(method, url, body)
        expect([url, res.statusCode, res.json().error]).toEqual([url, 403, 'not_world_owner'])
      }
      expect(await db.select().from(sceneDeployments)).toHaveLength(0)
      expect(worlds.signed).toHaveLength(0)
    })

    it('revoke: a DELETE to sign, then grantedAt is cleared and mode is sign', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { mode: 'virvi', grantedAt: new Date() })
      const got = await req('DELETE', `/api/dcl/destinations/${dest.id}/grant`)
      expect(got.statusCode).toBe(200)
      const { requests } = got.json()
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ method: 'DELETE', path: `/world/${WORLD}/permissions/deployment/${virvi}`, metadata: '{}' })
      expect(requests[0].payload).toBe(signedFetchPayload('DELETE', requests[0].path, requests[0].timestamp, '{}'))
      const chains = [await chainFor(owner, requests[0].payload)]
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/revoke`, { chains, timestamp: requests[0].timestamp })
      expect(res.statusCode).toBe(200)
      expect(worlds.signed.map((s) => s.req.method)).toEqual(['DELETE'])
      expect(await destRow(dest.id)).toMatchObject({ mode: 'sign', grantedAt: null })
    })
  })

  describe('deploy', () => {
    it('mode virvi without a grant maps the DeployerError', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { mode: 'virvi', grantedAt: null })
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/deploy`, {})
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_granted'])
    })

    it('mode virvi with a grant starts a deploy (202)', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { mode: 'virvi', grantedAt: new Date() })
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/deploy`, {})
      expect(res.statusCode).toBe(202)
      expect(res.json().deployment).toMatchObject({ destinationId: dest.id, status: 'building' })
      await whenSettled(res.json().deployment.id)
      expect(worlds.deployed).toHaveLength(1)
    })

    it('mode sign: prepare, then the owner signature deploys it', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { mode: 'sign' })
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/deploy`, {})
      expect(res.statusCode).toBe(200)
      const { deployment, payload, expiresAt } = res.json()
      expect(deployment.status).toBe('awaiting_signature')
      expect(typeof payload).toBe('string')
      expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())

      const stranger = await createUser({ wallet: '0x' + 'e'.repeat(40) })
      const chain = await chainFor(owner, payload)
      expect((await req('POST', `/api/deploy/${deployment.id}/signature`, { chain }, stranger)).statusCode).toBe(404)
      const wrong = await req('POST', `/api/deploy/${deployment.id}/signature`, { chain: await chainFor(createUnsafeIdentity(), payload) })
      expect([wrong.statusCode, wrong.json().error]).toEqual([403, 'not_world_owner'])
      const ok = await req('POST', `/api/deploy/${deployment.id}/signature`, { chain })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().deployment.status).toBe('deployed')
      expect(worlds.deployed).toHaveLength(1)
    })

    it.each(['virvi', 'sign'] as const)('mode %s over the triangle budget deploys, and the destination carries a warning', async (mode) => {
      const { scene, preset } = await createScene(user)
      await db.insert(assetLibraryItems).values({ name: 'tree', storageKey: 'k', cdnUrl: `${CDN}/m/tree.glb`, triangleCount: 8_000 })
      const el = await createElement(preset.id, { type: 'model', name: 'tree', properties: { modelSrc: `${CDN}/m/tree.glb` } })
      for (let i = 0; i < 3; i++) await createInstance(el.id)
      const dest = await insertDest(scene.id, { mode, grantedAt: mode === 'virvi' ? new Date() : null })
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/deploy`, {})
      expect(res.statusCode).toBeLessThan(300)
      expect(await db.select().from(sceneDeployments)).toHaveLength(1)
      const detail = await req('GET', `/api/dcl/destinations/${dest.id}`)
      expect(detail.json().warning).toMatch(/24,000 triangles, more than the .* Decentraland recommends/)
    })

    it('a World read failure during a deploy maps to world_unreachable', async () => {
      const { scene } = await createScene(user)
      const dest = await insertDest(scene.id, { mode: 'sign' })
      worlds.getWorldEntities = async () => { throw new WorldsError(0, '', 'down') }
      const res = await req('POST', `/api/dcl/destinations/${dest.id}/deploy`, {})
      expect(res.json().error).toBe('world_unreachable')
    })
  })

  it('rebase takes the live entity as the new base', async () => {
    const { scene } = await createScene(user)
    const dest = await insertDest(scene.id, { lastEntityId: 'old', status: 'needs_review', statusDetail: 'changed' })
    worlds.entities.set(WORLD, [liveEntity('new', ['0,0', '1,0'], ['bin/index.js', 'scene.json', 'models/virvi/A.glb'])])
    const res = await req('POST', `/api/dcl/destinations/${dest.id}/rebase`, {})
    expect(res.statusCode).toBe(200)
    expect(await destRow(dest.id)).toMatchObject({
      lastEntityId: 'new', deployedFiles: ['bin/index.js', 'scene.json', 'models/virvi/a.glb'], status: 'ok', statusDetail: null,
    })
    worlds.entities.set(WORLD, [])
    expect((await req('POST', `/api/dcl/destinations/${dest.id}/rebase`, {})).json().error).toBe('no_live_scene')
  })

  it("rebasing onto a scene the owner built elsewhere marks it adopted; the next redeploy keeps the owner's code", async () => {
    const { scene, preset } = await createScene(user)
    const dest = await insertDest(scene.id, { lastEntityId: 'old', status: 'needs_review', statusDetail: 'changed', grantedAt: new Date() })
    // The owner rebuilt the World in the Creator Hub: their own bin/index.js, no virvi block
    const theirs = liveEntity('theirs', ['0,0', '1,0'])
    theirs.content = await Promise.all(['bin/index.js', 'scene.json'].map(async (file) => ({ file, hash: await dclHash(new TextEncoder().encode(`owner ${file}`)) })))
    worlds.entities.set(WORLD, [theirs])
    expect((await req('POST', `/api/dcl/destinations/${dest.id}/rebase`, {})).statusCode).toBe(200)
    expect((await destRow(dest.id)).adopted).toBe(true)

    await createElement(preset.id, { type: 'model', name: 'B', properties: { modelSrc: `${CDN}/m/b.glb` } })
    const fetch = async (url: string) => new TextEncoder().encode(`bytes of ${url}`)
    await whenSettled((await startVirviDeploy(dest.id, user.id, { fetch })).id)
    expect(worlds.deployed).toHaveLength(1)
    const sent = worlds.deployed[0]
    const entity = JSON.parse(new TextDecoder().decode(sent.files.get(sent.entityId)!))
    expect(entity.content).toContainEqual(theirs.content[0])
    expect(entity.metadata).toEqual(theirs.metadata)
  })

  describe('GET /api/scenes/:sceneId/dcl/destinations', () => {
    it("lists the scene's destinations and the set-up Worlds it could adopt", async () => {
      const { scene } = await createScene(user)
      const empty = await req('GET', `/api/scenes/${scene.id}/dcl/destinations`)
      expect(empty.statusCode).toBe(200)
      expect(empty.json()).toEqual({ destinations: [], adoptable: [] })

      // A Creator Hub scene set up for this Virvi scene, one set up for another scene, and an ended setup
      const { scene: other } = await createScene(user, 'Other')
      const hub = await createAnalyticsScene({ kind: 'world', locationKey: 'world:hub.dcl.eth', realm: 'hub.dcl.eth', worldName: 'hub.dcl.eth' })
      await createSetup(hub.id, scene.id)
      const elsewhere = await createAnalyticsScene({ kind: 'world', locationKey: 'world:else.dcl.eth', realm: 'else.dcl.eth', worldName: 'else.dcl.eth' })
      await createSetup(elsewhere.id, other.id)
      const ended = await createAnalyticsScene({ kind: 'world', locationKey: 'world:old.dcl.eth', realm: 'old.dcl.eth', worldName: 'old.dcl.eth' })
      await createSetup(ended.id, scene.id, { endedAt: new Date() })
      const parcel = await createAnalyticsScene({ kind: 'parcels' })
      await createSetup(parcel.id, scene.id)

      const dest = await insertDest(scene.id)
      const cafe = await createAnalyticsScene({ kind: 'world', locationKey: `world:${WORLD}`, realm: WORLD, worldName: WORLD })
      await createSetup(cafe.id, scene.id)

      const res = await req('GET', `/api/scenes/${scene.id}/dcl/destinations`)
      expect(res.statusCode).toBe(200)
      expect(res.json().destinations.map((d: { id: string }) => d.id)).toEqual([dest.id])
      expect(res.json().adoptable).toEqual([{ world: 'hub.dcl.eth' }])
    })

    it("is 404 for a scene the caller can't edit", async () => {
      const { scene } = await createScene(user)
      const stranger = await createUser()
      expect((await req('GET', `/api/scenes/${scene.id}/dcl/destinations`, undefined, stranger)).statusCode).toBe(404)
      expect((await req('GET', '/api/scenes/not-a-uuid/dcl/destinations')).statusCode).toBe(404)
    })
  })

  describe('GET /api/scenes/:sceneId/dcl/publish-status', () => {
    it("works with the scene's own pass and is refused for another scene's", async () => {
      const { scene, preset } = await createScene(user)
      await createElement(preset.id, { type: 'model', name: 'Tree', properties: { modelSrc: `${CDN}/m/tree.glb` } })
      const { scene: other } = await createScene(user, 'Other')
      const pass = (sceneId: string) => ({ authorization: `Bearer ${tokenFor(user, { kind: 'scene', sceneId, locationId: null, orgId: null })}` })

      const none = await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/dcl/publish-status`, headers: pass(scene.id) })
      expect(none.json()).toEqual({ destination: null })

      const dest = await insertDest(scene.id, { mode: 'sign' })
      const res = await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/dcl/publish-status`, headers: pass(scene.id) })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        destination: { id: dest.id, world: WORLD, mode: 'sign', status: 'ok', granted: false, pending: 1, publishUrl: `${cfg.webAppUrl}/publish/?d=${dest.id}` },
      })

      const foreign = await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/dcl/publish-status`, headers: pass(other.id) })
      expect(foreign.statusCode).toBe(403)
      expect(foreign.json().error).toBe('scene_pass_not_allowed')

      // A pass for a scene the holder can't edit gets 404
      const stranger = await createUser()
      const strangerPass = { authorization: `Bearer ${tokenFor(stranger, { kind: 'scene', sceneId: scene.id, locationId: null, orgId: null })}` }
      expect((await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/dcl/publish-status`, headers: strangerPass })).statusCode).toBe(404)
    })
  })
})
