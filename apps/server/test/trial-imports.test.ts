import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Wallet } from 'ethers'
import { and, eq } from 'drizzle-orm'
import { zipSync, strToU8 } from 'fflate'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, sceneDeployments, sceneImports, scenes, userAuthMethods, users } from '../src/db/schema.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { setBuildRunner, type BuildRunner } from '../src/services/import/build-runner.js'
import { importLimits, trialUploadWork, uploadWork, IMPORTS_BUSY } from '../src/services/import/import-work.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { setWorldsClient } from '../src/services/dcl/worlds-client.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { ownThumbnailFile } from '../src/services/dcl/assemble.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { convertTrial } from '../src/auth/trial-convert.js'
import { latestImportFor, reserveTrialImport, SUPERSEDED_MESSAGE } from '../src/services/import/imports.js'
import { deployImport } from '../src/services/import/import-deploy.js'
import { sweepRetention } from '../src/services/import/retention.js'
import { sweepBuilds } from '../src/services/import/build-sweep.js'
import { sceneSourceFor } from '../src/services/import/uninstall-virvi.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

const B_WORLD = 'b.dcl.eth'
const MAIN = "import { engine } from '@dcl/sdk/ecs'\n\nexport function main() {\n  engine.addSystem(() => {})\n}\n"
const enc = (s: string) => new TextEncoder().encode(s)

function sceneJson(o: { world?: string | null; parcels?: string[]; base?: string; title?: string } = {}) {
  const world = o.world === undefined ? B_WORLD : o.world
  const parcels = o.parcels ?? ['0,0']
  return JSON.stringify({
    main: 'bin/index.js', runtimeVersion: '7', scene: { parcels, base: o.base ?? parcels[0] },
    ...(o.title ? { display: { title: o.title } } : {}),
    ...(world ? { worldConfiguration: { name: world } } : {}),
  })
}

function sceneZip(o: Parameters<typeof sceneJson>[0] = {}): Buffer {
  const files = {
    'scene.json': sceneJson(o),
    'package.json': JSON.stringify({ name: 'moon', devDependencies: { '@dcl/sdk': 'latest' } }),
    'src/index.ts': MAIN,
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

describe('trial (guest) scene imports: a sandbox that never touches the real place', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let worlds: FakeWorldsClient
  let dir: FakeDclDirectory
  let store: ReturnType<typeof memoryPrivateStore>
  let fake: ReturnType<typeof fakeRunner>
  let b: TestUser
  const cfg = config as { virviDclDeployKey: string | null; cdnUrl: string | null }
  const saved = { key: cfg.virviDclDeployKey, cdn: cfg.cdnUrl }

  beforeEach(async () => {
    await resetDb()
    cfg.virviDclDeployKey = Wallet.createRandom().privateKey
    cfg.cdnUrl = 'https://cdn.virvi.test'
    worlds = new FakeWorldsClient()
    setWorldsClient(worlds)
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
    store = memoryPrivateStore()
    setImportStore(store)
    fake = fakeRunner()
    setBuildRunner(fake.runner)
    b = await createUser({ wallet: randomWallet() })
    worlds.deployers.set(B_WORLD, { owner: b.wallet, deployers: [] })
    app = await testApp()
  })
  afterEach(async () => {
    cfg.virviDclDeployKey = saved.key
    cfg.cdnUrl = saved.cdn
    setWorldsClient(null)
    setDclDirectory(null)
    setImportStore(null)
    setBuildRunner(null)
    await app.close()
  })

  async function makeTrial() {
    const u = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
    const s = issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() })
    return { u, h: { authorization: `Bearer ${s.accessToken}` } }
  }

  /** The trial becomes an account with a verified wallet, as phase 1's wallet sign-in leaves it. */
  async function convert(trialId: string, wallet = randomWallet()): Promise<TestUser> {
    const user = await convertTrial(trialId, { displayName: 'Converted' })
    await db.insert(userAuthMethods).values({ userId: trialId, type: 'wallet', identifier: wallet.toLowerCase(), metadata: { verified: true } })
    return { ...user, wallet: wallet.toLowerCase() } as TestUser
  }

  const auth = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const upload = (zip: Buffer, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/imports', payload: zip, headers: { ...headers, 'content-type': 'application/zip' } })
  const importRow = async (id: string) => (await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, id) }))!
  const destByWorld = async (world = B_WORLD) => db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.worldName, world) })

  /** Marks an import built with a build of `world` in the store, as the build box leaves it. */
  async function makeBuilt(id: string, world = B_WORLD) {
    const prefix = `imports/${id}/built/`
    await db.update(sceneImports).set({ status: 'built', builtAt: new Date(), builtKeyPrefix: prefix, buildTokenHash: null }).where(eq(sceneImports.id, id))
    const files = new Map<string, Uint8Array>([
      ['scene.json', enc(JSON.stringify({
        display: { title: 'T' }, main: 'bin/index.js', runtimeVersion: '7', scene: { parcels: ['0,0'], base: '0,0' }, worldConfiguration: { name: world }, spawnPoints: [],
      }))],
      ['bin/index.js', enc('code')],
    ])
    for (const [path, bytes] of files) await store.put(prefix + path, Buffer.from(bytes), 'application/octet-stream')
  }

  /** B's own import of its World, in `status`, on B's scene. */
  async function bImport(status: typeof sceneImports.$inferSelect['status'], sceneId?: string) {
    const scene = sceneId ?? (await createScene(b, 'B scene')).scene.id
    const [row] = await db.insert(sceneImports).values({
      userId: b.id, sceneId: scene, worldName: B_WORLD, kind: 'sdk7', sourceKey: 'x', status,
    }).returning()
    return row
  }

  async function bGrantedDest(sceneId: string, pendingImportId: string | null = null) {
    const [d] = await db.insert(dclWorldDestinations).values({
      sceneId, ownerUserId: b.id, ownerWallet: b.wallet!, worldName: B_WORLD, base: '0,0', parcels: ['0,0'],
      mode: 'virvi', grantedAt: new Date(), pendingImportId,
    }).returning()
    return d
  }

  it("a guest imports a World it doesn't own", async () => {
    const t = await makeTrial()
    const res = await upload(sceneZip({ title: 'My Try' }), t.h)
    expect(res.statusCode).toBe(201)
    const view = res.json().import
    const row = await importRow(view.id)
    expect(row).toMatchObject({ userId: t.u.id, sandbox: true, worldName: B_WORLD, status: 'building' })
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, row.sceneId))
    expect(scene).toMatchObject({ ownerId: t.u.id, name: 'My Try' })
    expect(fake.started).toEqual([view.id])
    // the guest reads its own import, its list and log
    expect((await app.inject({ method: 'GET', url: `/api/imports/${view.id}`, headers: t.h })).statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/imports', headers: t.h })
    expect(list.json().imports.map((i: { id: string }) => i.id)).toEqual([view.id])
    expect((await app.inject({ method: 'GET', url: `/api/imports/${view.id}/log`, headers: t.h })).statusCode).toBe(404) // no log yet
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].trialImports).toBe(1)
  })

  it("a guest's import always gets a new scene, never the World's connected or last-imported one", async () => {
    const mine = await bImport('deployed')
    await bGrantedDest(mine.sceneId)
    const t = await makeTrial()
    const res = await upload(sceneZip(), t.h)
    expect(res.statusCode).toBe(201)
    const row = await importRow(res.json().import.id)
    expect(row.sceneId).not.toBe(mine.sceneId)
    expect((await db.select().from(scenes).where(eq(scenes.id, row.sceneId)))[0].ownerId).toBe(t.u.id)
  })

  it('a guest import never touches the place', async () => {
    const { scene } = await createScene(b, 'B scene')
    const waiting = await bImport('awaiting_signature', scene.id)
    const dest = await bGrantedDest(scene.id, waiting.id)
    const t = await makeTrial()
    const res = await upload(sceneZip(), t.h)
    expect(res.statusCode).toBe(201)
    expect((await importRow(waiting.id)).status).toBe('awaiting_signature')
    expect((await destByWorld())!.pendingImportId).toBe(dest.pendingImportId)
    // B uploads again while the guest's import is building: no import_in_progress from it
    expect((await importRow(res.json().import.id)).status).toBe('building')
    const again = await upload(sceneZip(), auth(b))
    expect(again.statusCode).toBe(201)
    expect(again.json().import.sceneId).toBe(scene.id)
    // and B's own building import doesn't hold the guest back either
    const t2 = await makeTrial()
    expect((await upload(sceneZip(), t2.h)).statusCode).toBe(201)
  })

  it("the place's latest import is never a guest's", async () => {
    const mine = await bImport('deployed')
    const t = await makeTrial()
    expect((await upload(sceneZip(), t.h)).statusCode).toBe(201)
    expect((await latestImportFor(B_WORLD))?.id).toBe(mine.id)
    const p = await upload(sceneZip({ world: null, parcels: ['5,5'] }), t.h)
    expect(p.statusCode).toBe(201)
    expect(await latestImportFor({ kind: 'parcels', base: '5,5', parcels: ['5,5'] })).toBeNull()
  })

  it("a guest upload after B's built import leaves it B's newest: B still deploys it", async () => {
    const mine = await bImport('built')
    await makeBuilt(mine.id)
    const t = await makeTrial()
    expect((await upload(sceneZip(), t.h)).statusCode).toBe(201)
    const r = await app.inject({ method: 'POST', url: `/api/imports/${mine.id}/deploy`, headers: auth(b) })
    expect(r.statusCode).toBe(200)
    expect(await importRow(mine.id)).toMatchObject({ status: 'awaiting_signature' })
    expect((await destByWorld())!.pendingImportId).toBe(mine.id)
  })

  it('a finished guest build never auto-deploys', async () => {
    const { scene } = await createScene(b, 'B scene')
    const dest = await bGrantedDest(scene.id)
    const t = await makeTrial()
    const id = (await upload(sceneZip(), t.h)).json().import.id
    await makeBuilt(id)
    await deployImport(id)
    expect(await importRow(id)).toMatchObject({ status: 'built', errorCode: null, destinationId: null, deploymentId: null })
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
    expect(await destByWorld()).toMatchObject({ id: dest.id, sceneId: scene.id, pendingImportId: null })
    expect(worlds.deployed).toHaveLength(0)
  })

  it("a converted guest's sandbox build doesn't auto-deploy even to a granted World it owns", async () => {
    const t = await makeTrial()
    const id = (await upload(sceneZip({ world: 'mine.dcl.eth' }), t.h)).json().import.id
    const acct = await convert(t.u.id)
    worlds.deployers.set('mine.dcl.eth', { owner: acct.wallet, deployers: [] })
    const row = await importRow(id)
    await db.insert(dclWorldDestinations).values({
      sceneId: row.sceneId, ownerUserId: acct.id, ownerWallet: acct.wallet!, worldName: 'mine.dcl.eth', base: '0,0', parcels: ['0,0'], mode: 'virvi', grantedAt: new Date(),
    })
    await makeBuilt(id, 'mine.dcl.eth')
    await deployImport(id)
    expect(await importRow(id)).toMatchObject({ status: 'built', sandbox: true, deploymentId: null })
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
  })

  it("a sandbox row is never the destination's own thumbnail import", async () => {
    const mine = await bImport('deployed')
    const dest = await bGrantedDest(mine.sceneId)
    await db.update(sceneImports).set({ destinationId: dest.id, navmapThumbnail: 'images/own.png', finishedAt: new Date(Date.now() - 60_000) }).where(eq(sceneImports.id, mine.id))
    const t = await makeTrial()
    const id = (await upload(sceneZip(), t.h)).json().import.id
    // even a row forced onto the destination as deployed (it can't get there) is not read while sandboxed
    await db.update(sceneImports).set({ status: 'deployed', destinationId: dest.id, navmapThumbnail: 'images/guest.png', finishedAt: new Date() }).where(eq(sceneImports.id, id))
    expect(await ownThumbnailFile(dest.id)).toBe('images/own.png')
  })

  it('two guest imports, then a third is account_required', async () => {
    const t = await makeTrial()
    expect((await upload(sceneZip(), t.h)).statusCode).toBe(201)
    expect((await upload(sceneZip({ world: 'other.dcl.eth' }), t.h)).statusCode).toBe(201)
    const third = await upload(sceneZip(), t.h)
    expect([third.statusCode, third.json()]).toEqual([403, { error: 'account_required', action: 'more_imports' }])
    expect(await db.select().from(sceneImports).where(eq(sceneImports.userId, t.u.id))).toHaveLength(2)
  })

  it('a failed guest import still counts', async () => {
    const t = await makeTrial()
    const bad = await upload(Buffer.from('not a zip'), t.h)
    expect(bad.statusCode).toBeGreaterThanOrEqual(400)
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].trialImports).toBe(0) // an unreadable zip never reserved one
    fake.runner.start = async () => { throw new Error('no machine') }
    expect((await upload(sceneZip(), t.h)).statusCode).toBe(502)
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].trialImports).toBe(1)
  })

  it('two at once with one left: one accepted', async () => {
    const t = await makeTrial()
    await db.update(users).set({ trialImports: 1 }).where(eq(users.id, t.u.id))
    const [r1, r2] = await Promise.all([upload(sceneZip(), t.h), upload(sceneZip({ world: 'other.dcl.eth' }), t.h)])
    // the second is refused by the guests' single upload slot (503) or, past it, by the reservation (403 more_imports)
    const codes = [r1.statusCode, r2.statusCode].sort()
    expect(codes[0]).toBe(201)
    expect([403, 503]).toContain(codes[1])
    expect(await db.select().from(sceneImports).where(eq(sceneImports.userId, t.u.id))).toHaveLength(1)
    // the reservation itself is atomic, whatever the slots do
    const t2 = await makeTrial()
    await db.update(users).set({ trialImports: 1 }).where(eq(users.id, t2.u.id))
    expect((await Promise.all([reserveTrialImport(t2.u.id), reserveTrialImport(t2.u.id), reserveTrialImport(t2.u.id)])).filter(Boolean)).toHaveLength(1)
  })

  it('reserveTrialImport only counts for trials, up to TRIAL_IMPORTS', async () => {
    const t = await makeTrial()
    expect(await reserveTrialImport(t.u.id)).toBe(true)
    expect(await reserveTrialImport(t.u.id)).toBe(true)
    expect(await reserveTrialImport(t.u.id)).toBe(false)
    expect(await reserveTrialImport(b.id)).toBe(false)
  })

  it('a zip over 25 MB is account_required for a guest', async () => {
    expect(config.trialImportMaxBytes).toBe(26214400)
    const t = await makeTrial()
    const big = Buffer.alloc(26214401)
    const res = await upload(big, { ...t.h, 'content-length': String(big.length) })
    expect([res.statusCode, res.json()]).toEqual([403, { error: 'account_required', action: 'import_larger' }])
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].trialImports).toBe(0)
    // an account's same zip passes the gate (and is then read: it isn't a zip)
    const acct = await upload(big, { ...auth(b), 'content-length': String(big.length) })
    expect(acct.statusCode).not.toBe(403)
    expect(acct.json().error).not.toBe('account_required')
  })

  it('a guest Genesis City import needs no parcel control and leaves the parcels alone', async () => {
    const { scene } = await createScene(b, 'B parcels')
    const [mine] = await db.insert(sceneImports).values({
      userId: b.id, sceneId: scene.id, locationKind: 'parcels', base: '5,5', parcels: ['5,5'], kind: 'sdk7', sourceKey: 'x', status: 'built',
    }).returning()
    const t = await makeTrial()
    const res = await upload(sceneZip({ world: null, parcels: ['5,5', '5,6'] }), t.h)
    expect(res.statusCode).toBe(201)
    expect(await importRow(res.json().import.id)).toMatchObject({ sandbox: true, locationKind: 'parcels', base: '5,5' })
    expect((await importRow(mine.id)).status).toBe('built')
    // the parcel format check still applies
    const bad = await upload(sceneZip({ world: null, parcels: ['5,5'], base: '9,9' }), t.h)
    expect([bad.statusCode, bad.json().error]).toEqual([422, 'bad_scene_json'])
  })

  it("a guest's deploy is account_required", async () => {
    const t = await makeTrial()
    const id = (await upload(sceneZip(), t.h)).json().import.id
    await makeBuilt(id)
    const r = await app.inject({ method: 'POST', url: `/api/imports/${id}/deploy`, headers: t.h })
    expect(r.statusCode).toBe(403)
    expect(r.json().error).toBe('account_required')
    expect((await importRow(id)).sandbox).toBe(true)
  })

  it("deploying a converted guest's import claims its place", async () => {
    const mine = await bImport('built')
    const t = await makeTrial()
    const id = (await upload(sceneZip(), t.h)).json().import.id
    await makeBuilt(id)
    // B uploads after the guest; it's still superseded by the claim
    const later = await bImport('built', mine.sceneId)
    // a wallet that doesn't own the World: refused, nothing claimed
    const acct = await convert(t.u.id)
    const no = await app.inject({ method: 'POST', url: `/api/imports/${id}/deploy`, headers: auth(acct) })
    expect([no.statusCode, no.json().error]).toEqual([403, 'not_world_owner'])
    expect(await importRow(id)).toMatchObject({ sandbox: true, status: 'built' })
    expect((await importRow(mine.id)).status).toBe('built')

    worlds.deployers.set(B_WORLD, { owner: acct.wallet, deployers: [] })
    const ok = await app.inject({ method: 'POST', url: `/api/imports/${id}/deploy`, headers: auth(acct) })
    expect(ok.statusCode).toBe(200)
    expect(await importRow(id)).toMatchObject({ sandbox: false, status: 'awaiting_signature' })
    for (const r of [mine, later]) expect(await importRow(r.id)).toMatchObject({ status: 'failed', errorCode: 'superseded', errorMessage: SUPERSEDED_MESSAGE })
    expect((await destByWorld())!.pendingImportId).toBe(id)
  })

  it('a claim waits for an import under way at the place', async () => {
    const t = await makeTrial()
    const id = (await upload(sceneZip(), t.h)).json().import.id
    await makeBuilt(id)
    const running = await bImport('building')
    const acct = await convert(t.u.id)
    worlds.deployers.set(B_WORLD, { owner: acct.wallet, deployers: [] })
    const r = await app.inject({ method: 'POST', url: `/api/imports/${id}/deploy`, headers: auth(acct) })
    expect([r.statusCode, r.json().error]).toEqual([409, 'import_in_progress'])
    expect((await importRow(id)).sandbox).toBe(true)
    expect((await importRow(running.id)).status).toBe('building')
  })

  it("a claim never takes a World connected to another account's scene", async () => {
    const mine = await bImport('awaiting_signature')
    await bGrantedDest(mine.sceneId, mine.id)
    const t = await makeTrial()
    const id = (await upload(sceneZip(), t.h)).json().import.id
    await makeBuilt(id)
    const acct = await convert(t.u.id)
    worlds.deployers.set(B_WORLD, { owner: acct.wallet, deployers: [] })
    const r = await app.inject({ method: 'POST', url: `/api/imports/${id}/deploy`, headers: auth(acct) })
    expect([r.statusCode, r.json().error]).toEqual([409, 'world_in_use'])
    expect(await importRow(id)).toMatchObject({ sandbox: true, status: 'built' })
    expect((await importRow(mine.id)).status).toBe('awaiting_signature')
    expect((await destByWorld())!.pendingImportId).toBe(mine.id)
    expect(await db.select().from(sceneDeployments).where(and(eq(sceneDeployments.status, 'awaiting_signature')))).toHaveLength(0)
  })

  it("the sweeps and scene lookups never reach B's import through a guest's", async () => {
    const mine = await bImport('deployed')
    await db.update(sceneImports).set({ originalKey: `imports/${mine.id}/original.zip`, finishedAt: new Date() }).where(eq(sceneImports.id, mine.id))
    await store.put(`imports/${mine.id}/original.zip`, Buffer.from(sceneZip()), 'application/zip')
    const t = await makeTrial()
    const id = (await upload(sceneZip(), t.h)).json().import.id
    await makeBuilt(id)
    const before = await importRow(mine.id)
    await sweepRetention(new Date())
    await sweepBuilds(new Date(Date.now() + 60 * 60_000))
    expect(await importRow(mine.id)).toEqual(before)
    expect(await store.get(`imports/${mine.id}/original.zip`)).toBeTruthy()
    // the guest's import is on its own scene, so B's scene's source is still B's import's
    expect((await sceneSourceFor(mine.sceneId, { userId: b.id, fullAccess: true })).origin).toBe('original')
    expect((await importRow(id)).sceneId).not.toBe(mine.sceneId)
  })

  describe('fix round 1: upload slots and the claim', () => {
    /** Starts an upload on a real socket that sends `sent` bytes of a declared `length` and then stalls; resolves when the server answers or closes. */
    async function stalledUpload(headers: Record<string, string>, length = 100_000, sent = 100) {
      const { port } = app.server.address() as AddressInfo
      return new Promise<string>((resolve) => {
        const req = httpRequest({
          host: '127.0.0.1', port, method: 'POST', path: '/api/imports',
          headers: { ...headers, 'content-type': 'application/zip', 'content-length': String(length) },
        }, (res) => {
          let body = ''
          res.on('data', (c) => { body += c })
          res.on('end', () => resolve(`status ${res.statusCode} ${body}`))
          res.on('error', () => resolve(`status ${res.statusCode}`))
        })
        req.on('error', (e) => resolve(`error ${(e as NodeJS.ErrnoException).code}`))
        req.write(Buffer.alloc(sent))
      })
    }

    it('a trial at its import limit is refused before it takes an upload slot', async () => {
      const t = await makeTrial()
      await db.update(users).set({ trialImports: config.trialImports }).where(eq(users.id, t.u.id))
      // both shared slots taken: the limit still answers first, so it never needed one
      const held = [uploadWork.tryTake()!, uploadWork.tryTake()!]
      try {
        const res = await upload(sceneZip(), t.h)
        expect([res.statusCode, res.json()]).toEqual([403, { error: 'account_required', action: 'more_imports' }])
        expect(trialUploadWork.inUse()).toBe(0)
      } finally {
        held.forEach((r) => r())
      }
      expect(uploadWork.inUse()).toBe(0)
    })

    it("a trial's chunked upload (no Content-Length) is refused before a slot", async () => {
      const t = await makeTrial()
      await app.listen({ port: 0, host: '127.0.0.1' })
      const { port } = app.server.address() as AddressInfo
      const ended = await new Promise<string>((resolve) => {
        const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/imports', headers: { ...t.h, 'content-type': 'application/zip', 'transfer-encoding': 'chunked' } }, (res) => {
          let body = ''
          res.on('data', (c) => { body += c })
          res.on('end', () => resolve(`status ${res.statusCode} ${body}`))
        })
        req.on('error', (e) => resolve(`error ${(e as NodeJS.ErrnoException).code}`))
        req.write(sceneZip())
        req.end()
      })
      expect(ended).toBe(`status 411 ${JSON.stringify({ error: 'length_required', message: 'Send the zip with its Content-Length.' })}`)
      expect(uploadWork.inUse()).toBe(0)
      expect(trialUploadWork.inUse()).toBe(0)
      expect(await db.select().from(sceneImports)).toHaveLength(0)
    })

    it("trials share one upload slot: a second guest's upload is busy while an account still gets one", async () => {
      const saved = importLimits.uploadBodyMs
      importLimits.uploadBodyMs = 1500
      await app.listen({ port: 0, host: '127.0.0.1' })
      try {
        const t1 = await makeTrial()
        const t2 = await makeTrial()
        const first = stalledUpload(t1.h)
        await vi.waitFor(() => expect(trialUploadWork.inUse()).toBe(1))
        expect(uploadWork.inUse()).toBe(1)
        const second = await upload(sceneZip(), t2.h)
        expect([second.statusCode, second.json()]).toEqual([503, { error: 'imports_busy', message: IMPORTS_BUSY }])
        const acct = await upload(sceneZip(), auth(b))
        expect(acct.statusCode).toBe(201)
        expect(await first).toMatch(/^status 408/)
        await vi.waitFor(() => expect([trialUploadWork.inUse(), uploadWork.inUse()]).toEqual([0, 0]))
        expect((await db.select().from(users).where(eq(users.id, t1.u.id)))[0].trialImports).toBe(0)
        // the slot came back: the second guest can upload now
        expect((await upload(sceneZip(), t2.h)).statusCode).toBe(201)
        expect([trialUploadWork.inUse(), uploadWork.inUse()]).toEqual([0, 0])
      } finally {
        importLimits.uploadBodyMs = saved
      }
    })

    it('the import view says whether it is a sandbox', async () => {
      const t = await makeTrial()
      expect((await upload(sceneZip(), t.h)).json().import.sandbox).toBe(true)
      expect((await upload(sceneZip(), auth(b))).json().import.sandbox).toBe(false)
    })

    it("a claim joins the World's destination scene when the account can manage it, as an upload would", async () => {
      const t = await makeTrial()
      const id = (await upload(sceneZip(), t.h)).json().import.id
      await makeBuilt(id)
      const sandboxScene = (await importRow(id)).sceneId
      const acct = await convert(t.u.id)
      worlds.deployers.set(B_WORLD, { owner: acct.wallet, deployers: [] })
      // the account's own scene is connected to the World
      const { scene } = await createScene(acct, 'Connected')
      await db.insert(dclWorldDestinations).values({
        sceneId: scene.id, ownerUserId: acct.id, ownerWallet: acct.wallet!, worldName: B_WORLD, base: '0,0', parcels: ['0,0'], mode: 'sign',
      })
      const r = await app.inject({ method: 'POST', url: `/api/imports/${id}/deploy`, headers: auth(acct) })
      expect(r.statusCode).toBe(200)
      expect(await importRow(id)).toMatchObject({ sandbox: false, sceneId: scene.id, status: 'awaiting_signature' })
      expect((await destByWorld())).toMatchObject({ sceneId: scene.id, pendingImportId: id })
      // the guest's sandbox scene stays (it may hold the guest's layout)
      expect(await db.select().from(scenes).where(eq(scenes.id, sandboxScene))).toHaveLength(1)
    })

    it("a claim refuses a World set up under someone else's Virvi scene, and changes nothing", async () => {
      const mine = await bImport('built')
      const loc = await createAnalyticsScene({ kind: 'world', locationKey: `world:${B_WORLD}`, worldName: B_WORLD, baseParcel: '0,0', parcels: ['0,0'] })
      await createSetup(loc.id, mine.sceneId)
      const t = await makeTrial()
      const id = (await upload(sceneZip(), t.h)).json().import.id
      await makeBuilt(id)
      const acct = await convert(t.u.id)
      worlds.deployers.set(B_WORLD, { owner: acct.wallet, deployers: [] })
      const r = await app.inject({ method: 'POST', url: `/api/imports/${id}/deploy`, headers: auth(acct) })
      expect([r.statusCode, r.json()]).toEqual([409, { error: 'world_set_up_elsewhere', message: "This World is set up under a Virvi scene you can't manage." }])
      expect(await importRow(id)).toMatchObject({ sandbox: true, status: 'built' })
      expect((await importRow(mine.id)).status).toBe('built')
    })

    it("a claim refuses parcels set up under someone else's Virvi scene", async () => {
      const { scene } = await createScene(b, 'B parcels')
      const loc = await createAnalyticsScene({ kind: 'parcels', locationKey: 'gc:5,5', baseParcel: '5,5', parcels: ['5,5'] })
      await createSetup(loc.id, scene.id)
      const t = await makeTrial()
      const res = await upload(sceneZip({ world: null, parcels: ['5,5'] }), t.h)
      expect(res.statusCode).toBe(201)
      const id = res.json().import.id
      await db.update(sceneImports).set({ status: 'built' }).where(eq(sceneImports.id, id))
      const wallet = randomWallet()
      const acct = await convert(t.u.id, wallet)
      dir.rights.set('5,5', { owner: acct.wallet!, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [] })
      const r = await app.inject({ method: 'POST', url: `/api/imports/${id}/deploy`, headers: auth(acct) })
      expect([r.statusCode, r.json().error]).toEqual([409, 'parcels_set_up_elsewhere'])
      expect((await importRow(id)).sandbox).toBe(true)
    })
  })
})
