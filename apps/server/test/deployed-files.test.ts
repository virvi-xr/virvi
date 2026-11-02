import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { unzipSync } from 'fflate'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, sceneCollaborators, sceneDeployments } from '../src/db/schema.js'
import { memoryPrivateStore, setImportStore, type PrivateStore } from '../src/storage/private-store.js'
import { dclHash, type ContentRef } from '../src/services/dcl/entity.js'
import { setWorldsClient, type LiveEntity } from '../src/services/dcl/worlds-client.js'
import { keepDeployedFiles } from '../src/services/dcl/deployed-files.js'
import { prepareSignedDeploy, startVirviDeploy, submitSignedDeploy, whenSettled } from '../src/services/dcl/world-deployer.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
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

const cfg = config as { cdnUrl: string | null; virviDclDeployKey: string | null }
const saved = { cdnUrl: cfg.cdnUrl, key: cfg.virviDclDeployKey }
const fetcher = vi.fn(async (url: string) => enc(`bytes of ${url}`))
let fake: FakeWorldsClient
let store: ReturnType<typeof memoryPrivateStore>
let app: Awaited<ReturnType<typeof testApp>>

beforeEach(async () => {
  await resetDb()
  cfg.cdnUrl = CDN
  cfg.virviDclDeployKey = Wallet.createRandom().privateKey
  fake = new FakeWorldsClient()
  setWorldsClient(fake)
  store = memoryPrivateStore()
  setImportStore(store)
  fetcher.mockClear()
  app = await testApp()
})
afterEach(async () => {
  cfg.cdnUrl = saved.cdnUrl
  cfg.virviDclDeployKey = saved.key
  setWorldsClient(null)
  setImportStore(null)
  vi.restoreAllMocks()
  await app.close()
})

async function setup(opts: { mode?: 'virvi' | 'sign'; models?: string[] } = {}) {
  const owner = createUnsafeIdentity()
  const user = await createUser({ wallet: owner.address })
  const { scene, preset } = await createScene(user, 'Cafe')
  for (const m of opts.models ?? ['a']) {
    await createElement(preset.id, { type: 'model', name: m, properties: { modelSrc: `${CDN}/m/${m}.glb` } })
  }
  const mode = opts.mode ?? 'virvi'
  const [dest] = await db.insert(dclWorldDestinations).values({
    sceneId: scene.id, ownerUserId: user.id, ownerWallet: owner.address.toLowerCase(), worldName: WORLD,
    base: '0,0', parcels: ['0,0', '1,0'], mode, grantedAt: mode === 'virvi' ? new Date() : null,
  }).returning()
  return { owner, user, scene, preset, dest }
}

const depRow = async (id: string) => (await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, id) }))!
const entityOf = (i = fake.deployed.length - 1) => {
  const d = fake.deployed[i]
  return JSON.parse(dec(d.files.get(d.entityId)!)) as { pointers: string[]; content: ContentRef[]; metadata: any }
}
function goLive(i = fake.deployed.length - 1) {
  const d = fake.deployed[i]
  const e = entityOf(i)
  const live: LiveEntity = { id: d.entityId, pointers: e.pointers, content: e.content, metadata: e.metadata }
  fake.entities.set(WORLD, [live])
  return live
}
const byFile = (c: ContentRef[]) => [...c].sort((a, b) => a.file.localeCompare(b.file))

/** Every file of the entity, path to bytes, from what was uploaded across deploys. */
function bytesOf(content: ContentRef[]): Record<string, string> {
  const all = new Map<string, Uint8Array>()
  for (const d of fake.deployed) for (const [h, b] of d.files) all.set(h, b)
  return Object.fromEntries(content.map((c) => [c.file, dec(all.get(c.hash)!)]))
}

async function deployA(dest: { id: string }, user: TestUser) {
  const dep = await startVirviDeploy(dest.id, user.id, { fetch: fetcher })
  await whenSettled(dep.id)
  return depRow(dep.id)
}

const download = (id: string, u: TestUser) => app.inject({ method: 'GET', url: `/api/deploy/${id}/files.zip`, headers: { authorization: `Bearer ${tokenFor(u)}` } })
const unzipped = (body: Buffer) => Object.fromEntries(Object.entries(unzipSync(new Uint8Array(body))).map(([k, v]) => [k, dec(v)]))

describe('keeping what went live', () => {
  it('a Virvi-signed deploy keeps its files and lists its content', async () => {
    const { user, preset, dest } = await setup()
    const first = await deployA(dest, user)
    expect(first.status).toBe('deployed')
    const entity = entityOf()
    expect(byFile((first.assetBundle as { content: ContentRef[] }).content)).toEqual(byFile(entity.content))
    const hashes = [...new Set(entity.content.map((c) => c.hash))].sort()
    expect(store.keys()).toEqual(hashes.map((h) => `deployed/${h}`).sort())
    for (const h of hashes) expect(dec((await store.get(`deployed/${h}`))!.body)).toBe(dec(fake.deployed[0].files.get(h)!))
    // The entity file itself is not one of the scene's files
    expect(store.keys()).not.toContain(`deployed/${fake.deployed[0].entityId}`)

    // A redeploy uploads only what's new; its content still lists every file, and nothing already kept is written again
    goLive()
    await createElement(preset.id, { type: 'model', name: 'b', properties: { modelSrc: `${CDN}/m/b.glb` } })
    const put = vi.spyOn(store, 'put')
    const second = await deployA(dest, user)
    expect(second.status).toBe('deployed')
    const sent = fake.deployed[1]
    const content = (second.assetBundle as { content: ContentRef[] }).content
    expect(byFile(content)).toEqual(byFile(entityOf().content))
    expect(content.some((c) => !sent.files.has(c.hash))).toBe(true) // some files were already live
    const written = put.mock.calls.map(([k]) => k).sort()
    expect(written).toEqual([...new Set(content.map((c) => c.hash))].filter((h) => sent.files.has(h) && !hashes.includes(h)).map((h) => `deployed/${h}`).sort())
    expect(written.length).toBeGreaterThan(0)
  })

  it('an owner-signed deploy keeps its files and lists its content too', async () => {
    const { owner, user, dest } = await setup({ mode: 'sign' })
    const { deployment, payload } = await prepareSignedDeploy(dest.id, user.id, { fetch: fetcher })
    const done = await submitSignedDeploy(deployment.id, await ownerChain(owner, payload), { fetch: fetcher })
    expect(done.status).toBe('deployed')
    const entity = entityOf()
    expect(byFile((done.assetBundle as { content: ContentRef[] }).content)).toEqual(byFile(entity.content))
    expect(store.keys()).toEqual([...new Set(entity.content.map((c) => c.hash))].map((h) => `deployed/${h}`).sort())
  })

  it("a storage error after the World accepted the deploy is logged and the deploy stays deployed", async () => {
    const broken: PrivateStore = { ...memoryPrivateStore(), put: async () => { throw new Error('bucket down') } }
    setImportStore(broken)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const a = await setup()
    const row = await deployA(a.dest, a.user)
    expect(row.status).toBe('deployed')
    expect(row.catalystEntityId).toBe(fake.deployed[0].entityId)
    expect((row.assetBundle as { content: ContentRef[] }).content.length).toBeGreaterThan(0)
    expect((await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, a.dest.id) }))!.status).toBe('ok')

    await db.delete(dclWorldDestinations)
    fake.entities.clear()
    const b = await setup({ mode: 'sign' })
    const { deployment, payload } = await prepareSignedDeploy(b.dest.id, b.user.id, { fetch: fetcher })
    const done = await submitSignedDeploy(deployment.id, await ownerChain(b.owner, payload), { fetch: fetcher })
    expect(done.status).toBe('deployed')

    const logged = errors.mock.calls.filter((c) => String(c[0]).includes('keep'))
    expect(logged.length).toBe(2)
    for (const c of logged) expect(c.join(' ')).toContain('bucket down')
  })

  it('keepDeployedFiles stores only the hashes it has bytes for, once each', async () => {
    const one = enc('one'), two = enc('two')
    const [h1, h2] = [await dclHash(one), await dclHash(two)]
    await keepDeployedFiles(
      [{ file: 'a.txt', hash: h1 }, { file: 'copy/a.txt', hash: h1 }, { file: 'b.txt', hash: h2 }, { file: 'gone.txt', hash: 'bafkreigone' }],
      new Map([[h1, one], [h2, two]]),
    )
    expect(store.keys()).toEqual([`deployed/${h1}`, `deployed/${h2}`].sort())
    const put = vi.spyOn(store, 'put')
    await keepDeployedFiles([{ file: 'a.txt', hash: h1 }], new Map([[h1, one]]))
    expect(put).not.toHaveBeenCalled()
  })
})

describe('GET /api/deploy/:id/files.zip', () => {
  async function deployedOnce() {
    const s = await setup()
    const row = await deployA(s.dest, s.user)
    await db.update(sceneDeployments).set({ deployedAt: new Date('2026-03-04T05:06:59Z') }).where(eq(sceneDeployments.id, row.id))
    return { ...s, row }
  }

  it('the download zips exactly the deployed files under their paths', async () => {
    const { user, row } = await deployedOnce()
    const res = await download(row.id, user)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${WORLD}-20260304-0506.zip"`)
    const content = (row.assetBundle as { content: ContentRef[] }).content
    expect(unzipped(res.rawPayload)).toEqual(bytesOf(content))
  })

  it('files no longer stored come from the Worlds server', async () => {
    const { user, row } = await deployedOnce()
    const content = (row.assetBundle as { content: ContentRef[] }).content
    const sent = fake.deployed[0]
    // Half the files were never kept here; the Worlds server has them
    for (const [i, c] of content.entries()) {
      if (i % 2 === 0) { await store.deletePrefix(`deployed/${c.hash}`); fake.contents.set(c.hash, sent.files.get(c.hash)!) }
    }
    const res = await download(row.id, user)
    expect(res.statusCode).toBe(200)
    expect(unzipped(res.rawPayload)).toEqual(bytesOf(content))
  })

  it('bytes from the Worlds server that do not match their hash never make a whole zip', async () => {
    const { user, row } = await deployedOnce()
    const c = (row.assetBundle as { content: ContentRef[] }).content[0]
    await store.deletePrefix(`deployed/${c.hash}`)
    fake.contents.set(c.hash, enc('tampered'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const got = await download(row.id, user).then((r) => r, (e: unknown) => e)
    if (!(got instanceof Error)) {
      expect(() => unzipped(got.rawPayload)).toThrow()
    }
  })

  it('a file gone everywhere is files_gone', async () => {
    const { user, row } = await deployedOnce()
    const c = (row.assetBundle as { content: ContentRef[] }).content[0]
    await store.deletePrefix(`deployed/${c.hash}`)
    const res = await download(row.id, user)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'files_gone', message: "Some of this deploy's files are no longer stored anywhere, so it can't be downloaded." })
  })

  it("an older deployment without content uses the live entity's content when it is still live, else files_gone", async () => {
    const { user, row } = await deployedOnce()
    const live = goLive()
    for (const [h, b] of fake.deployed[0].files) fake.contents.set(h, b)
    await store.deletePrefix('deployed/')
    const { content: _c, ...older } = row.assetBundle as Record<string, unknown>
    await db.update(sceneDeployments).set({ assetBundle: older }).where(eq(sceneDeployments.id, row.id))

    const res = await download(row.id, user)
    expect(res.statusCode).toBe(200)
    expect(unzipped(res.rawPayload)).toEqual(bytesOf(live.content))

    fake.entities.set(WORLD, [{ ...live, id: 'bafkreisomethingelse' }])
    const gone = await download(row.id, user)
    expect(gone.statusCode).toBe(409)
    expect(gone.json().error).toBe('files_gone')
  })

  it('a hostile path in the content never leaves the zip root', async () => {
    const { user, scene, row } = await deployedOnce()
    const ok = enc('fine'), evil = enc('evil')
    const [hOk, hEvil] = [await dclHash(ok), await dclHash(evil)]
    await keepDeployedFiles([{ file: 'ok.txt', hash: hOk }, { file: 'x', hash: hEvil }], new Map([[hOk, ok], [hEvil, evil]]))
    const content = [
      { file: 'ok.txt', hash: hOk }, { file: '../../etc/evil.txt', hash: hEvil }, { file: '/abs/evil.txt', hash: hEvil },
      { file: 'C:\\evil.txt', hash: hEvil }, { file: 'a\\..\\..\\evil.txt', hash: hEvil }, { file: './dir/./nested.txt', hash: hOk },
      { file: 'odd-hash.txt', hash: '../imports/x/source.zip' }, { file: 'ok.txt', hash: hEvil },
    ]
    await db.update(sceneDeployments).set({ assetBundle: { ...(row.assetBundle as object), content } }).where(eq(sceneDeployments.id, row.id))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await download(row.id, user)
    expect(res.statusCode).toBe(200)
    expect(unzipped(res.rawPayload)).toEqual({ 'ok.txt': 'fine', 'dir/nested.txt': 'fine' })
    expect(scene.id).toBeTruthy()
  })

  it('only people who can read the deployment can download it', async () => {
    const { user, scene, row } = await deployedOnce()
    const stranger = await createUser()
    const editor = await createUser()
    const viewer = await createUser()
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: editor.id, role: 'editor' },
      { sceneId: scene.id, userId: viewer.id, role: 'viewer' },
    ])
    expect((await download(row.id, user)).statusCode).toBe(200)
    expect((await download(row.id, editor)).statusCode).toBe(200)
    expect((await download(row.id, stranger)).statusCode).toBe(404)
    expect((await download(row.id, viewer)).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/deploy/${row.id}/files.zip` })).statusCode).toBe(401)
    expect((await download('not-a-uuid', user)).statusCode).toBe(404)
  })

  it('a deployment that never went live has nothing to download', async () => {
    const { user, row } = await deployedOnce()
    await db.update(sceneDeployments).set({ status: 'failed' }).where(eq(sceneDeployments.id, row.id))
    const res = await download(row.id, user)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('not_deployed')
  })
})
