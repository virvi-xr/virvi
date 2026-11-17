import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { mediaAssets, sceneLibrary, sceneRoles, uploadTokens } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG, 'base64').length

describe('companion uploads', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = { unlocked: config.allFeaturesUnlocked, dashboardDir: config.dashboardDir }
  beforeEach(async () => {
    await resetDb()
    config.allFeaturesUnlocked = true
    app = await testApp()
  })
  afterEach(async () => {
    config.allFeaturesUnlocked = prev.unlocked
    ;(config as any).dashboardDir = prev.dashboardDir
    await app.close()
  })

  async function setup() {
    const owner = await createUser()
    const editor = await createUser({ wallet: '0x00000000000000000000000000000000000000e2' })
    const { scene } = await createScene(owner)
    await db.insert(sceneRoles).values({ sceneId: scene.id, userId: editor.id, walletAddress: editor.wallet!, role: 'editor' } as any)
    return { owner, editor, scene }
  }

  const mint = async (user: TestUser, sceneId: string, extra: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST', url: '/api/upload-tokens', headers: { authorization: `Bearer ${tokenFor(user)}` },
      payload: { sceneId, kinds: ['image', 'model'], ...extra },
    })
    expect(res.statusCode).toBe(201)
    return res.json().token as { code: string; uploadUrl: string; qrUrl: string }
  }
  const start = (code: string, body: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/upload/${code}/start`, payload: { filename: 'a.png', contentType: 'image/png', sizeBytes: PNG_BYTES, ...body } })
  const send = (code: string, assetId: string, data = PNG) =>
    app.inject({ method: 'POST', url: `/api/upload/${code}/${assetId}`, payload: { fileData: data } })
  const asset = async (id: string) => (await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, id) }))!

  it('mints an in-world code with kinds, a web link and a QR url', async () => {
    const s = await setup()
    const t = await mint(s.editor, s.scene.id)
    expect(t.uploadUrl).toBe(`${config.webAppUrl}/u/${t.code}`)
    expect(t.qrUrl.endsWith(`/api/upload/${t.code}/qr.png`)).toBe(true)
    const info = await app.inject({ method: 'GET', url: `/api/upload/${t.code}` })
    expect(info.json()).toMatchObject({ kinds: ['image', 'model'] })
  })

  it("start then data stores an editor's upload in the owner's account, linked, ready", async () => {
    const s = await setup()
    const t = await mint(s.editor, s.scene.id)
    const st = await start(t.code)
    expect(st.statusCode).toBe(201)
    const { assetId } = st.json()
    expect((await asset(assetId)).status).toBe('uploading')
    const done = await send(t.code, assetId)
    expect(done.statusCode).toBe(201)
    const a = await asset(assetId)
    expect(a).toMatchObject({ status: 'ready', ownerId: s.owner.id })
    expect(a.storageKey).toBeTruthy()
    const [link] = await db.select().from(sceneLibrary).where(eq(sceneLibrary.mediaAssetId, assetId))
    expect(link.addedBy).toBe(s.editor.id)
  })

  it('a refused start leaves no row and spends no upload', async () => {
    const s = await setup()
    const t = await mint(s.editor, s.scene.id)
    const before = (await app.inject({ method: 'GET', url: `/api/upload/${t.code}` })).json().remainingUploads
    const st = await start(t.code, { sizeBytes: 11 * 1024 * 1024 })
    expect(st.statusCode).toBe(413)
    expect(await db.select().from(mediaAssets)).toHaveLength(0)
    expect((await app.inject({ method: 'GET', url: `/api/upload/${t.code}` })).json().remainingUploads).toBe(before)
  })

  it('refuses a type outside the code kinds', async () => {
    const s = await setup()
    const t = await mint(s.editor, s.scene.id, { kinds: ['image'] })
    expect((await start(t.code, { filename: 'm.glb', contentType: 'model/gltf-binary' })).statusCode).toBe(415)
  })

  it('a wallet-only editor and an admin minter both land', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const walletEd = await createUser({ wallet: '0x00000000000000000000000000000000000000e7' })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: walletEd.wallet!, role: 'editor' } as any)
    const admin = await createUser({ role: 'admin' })
    for (const u of [walletEd, admin]) {
      const t = await mint(u, scene.id)
      expect((await start(t.code)).statusCode).toBe(201)
    }
  })

  it('a minter who lost access is refused at start', async () => {
    const s = await setup()
    const t = await mint(s.editor, s.scene.id)
    await db.delete(sceneRoles).where(eq(sceneRoles.userId, s.editor.id))
    expect((await start(t.code)).statusCode).toBe(403)
  })

  it('data for an asset from another code is 404 and a second data post is 409', async () => {
    const s = await setup()
    const a = await mint(s.editor, s.scene.id)
    const b = await mint(s.editor, s.scene.id)
    const { assetId } = (await start(a.code)).json()
    expect((await send(b.code, assetId)).statusCode).toBe(404)
    expect((await send(a.code, assetId)).statusCode).toBe(201)
    expect((await send(a.code, assetId)).statusCode).toBe(409)
  })

  it('bytes that fail classification mark the asset failed with an error', async () => {
    const s = await setup()
    const t = await mint(s.editor, s.scene.id)
    const { assetId } = (await start(t.code, { sizeBytes: 10 })).json()
    const big = Buffer.alloc(11 * 1024 * 1024).toString('base64')
    expect((await send(t.code, assetId, big)).statusCode).toBe(413)
    const a = await asset(assetId)
    expect(a.status).toBe('failed')
    expect(a.error).toBeTruthy()
  })

  it('bytes larger than the declared size are refused (quota is checked on the declared size)', async () => {
    const s = await setup()
    const t = await mint(s.editor, s.scene.id)
    const { assetId } = (await start(t.code, { sizeBytes: 10 })).json()
    expect((await send(t.code, assetId)).statusCode).toBe(413)
    expect((await asset(assetId)).status).toBe('failed')
  })

  it('the dashboard media list leaves out unfinished uploads', async () => {
    const s = await setup()
    const t = await mint(s.owner, s.scene.id)
    await start(t.code)
    const ready = (await start(t.code, { filename: 'b.png' })).json().assetId
    await send(t.code, ready)
    const res = await app.inject({ method: 'GET', url: '/api/media', headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    expect(res.json().assets.map((a: { id: string }) => a.id)).toEqual([ready])
  })

  it('any editor can dismiss a failed upload', async () => {
    const s = await setup()
    const other = await createUser({ wallet: '0x00000000000000000000000000000000000000e3' })
    await db.insert(sceneRoles).values({ sceneId: s.scene.id, userId: other.id, walletAddress: other.wallet!, role: 'editor' } as any)
    const t = await mint(s.editor, s.scene.id)
    const failed = (await start(t.code)).json().assetId
    await db.update(mediaAssets).set({ status: 'failed', error: 'x' }).where(eq(mediaAssets.id, failed))
    const [link] = await db.select().from(sceneLibrary).where(eq(sceneLibrary.mediaAssetId, failed))
    const res = await app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}/library/${link.id}`, headers: { authorization: `Bearer ${tokenFor(other)}` } })
    expect(res.statusCode).toBe(204)
  })

  it('serves a QR png for a live code and 404 otherwise', async () => {
    const s = await setup()
    const t = await mint(s.editor, s.scene.id)
    const qr = await app.inject({ method: 'GET', url: `/api/upload/${t.code}/qr.png` })
    expect(qr.statusCode).toBe(200)
    expect(qr.headers['content-type']).toBe('image/png')
    expect(qr.rawPayload.subarray(0, 4).toString('hex')).toBe('89504e47')
    await db.update(uploadTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploadTokens.code, t.code))
    expect((await app.inject({ method: 'GET', url: `/api/upload/${t.code}/qr.png` })).statusCode).toBe(404)
  })

  it('unlinking a failed upload deletes the asset; unlinking a ready one keeps it', async () => {
    const s = await setup()
    const t = await mint(s.editor, s.scene.id)
    const failed = (await start(t.code)).json().assetId
    await db.update(mediaAssets).set({ status: 'failed', error: 'x' }).where(eq(mediaAssets.id, failed))
    const ready = (await start(t.code, { filename: 'b.png' })).json().assetId
    await send(t.code, ready)
    const linkOf = async (id: string) => (await db.select().from(sceneLibrary).where(eq(sceneLibrary.mediaAssetId, id)))[0].id
    const del = async (linkId: string) =>
      app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}/library/${linkId}`, headers: { authorization: `Bearer ${tokenFor(s.editor)}` } })
    expect((await del(await linkOf(failed))).statusCode).toBe(204)
    expect(await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, failed) })).toBeUndefined()
    expect((await del(await linkOf(ready))).statusCode).toBe(204)
    expect(await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, ready) })).toBeTruthy()
  })

  it('serves the upload page for /u/:code when the dashboard is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'virvi-dash-'))
    writeFileSync(join(dir, 'index.html'), 'HOME')
    mkdirSync(join(dir, 'u', '_'), { recursive: true })
    writeFileSync(join(dir, 'u', '_', 'index.html'), 'UPLOAD')
    ;(config as any).dashboardDir = dir
    await app.close()
    app = await testApp()
    for (const url of ['/u/abc234', '/u/abc234/']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain('UPLOAD')
    }
  })

  it('serves the public wallet page for /w/:address when the dashboard is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'virvi-dash-'))
    writeFileSync(join(dir, 'index.html'), 'HOME')
    mkdirSync(join(dir, 'w', '_'), { recursive: true })
    writeFileSync(join(dir, 'w', '_', 'index.html'), 'WALLET')
    ;(config as any).dashboardDir = dir
    await app.close()
    app = await testApp()
    for (const url of ['/w/0x52908400098527886E0F7030069857D2E4169EE7', '/w/0x52908400098527886E0F7030069857D2E4169EE7/']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain('WALLET')
    }
  })

  it('serves the pairing approval page for /pair/:code, leaving the API routes alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'virvi-dash-'))
    writeFileSync(join(dir, 'index.html'), 'HOME')
    mkdirSync(join(dir, 'pair', '_'), { recursive: true })
    writeFileSync(join(dir, 'pair', '_', 'index.html'), 'PAIR')
    ;(config as any).dashboardDir = dir
    await app.close()
    app = await testApp()
    for (const url of ['/pair/ABC-234', '/pair/ABC-234/']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain('PAIR')
    }
    const api = await app.inject({ method: 'GET', url: '/api/hyperfy/pair/ABC-234' })
    expect(api.statusCode).toBe(401)
    expect(api.body).not.toContain('PAIR')
  })
})

describe('renaming library files', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  async function setup() {
    const owner = await createUser()
    const editor = await createUser({ wallet: '0x00000000000000000000000000000000000000e4' })
    const viewer = await createUser({ wallet: '0x00000000000000000000000000000000000000e5' })
    const { scene } = await createScene(owner)
    await db.insert(sceneRoles).values([
      { sceneId: scene.id, userId: editor.id, walletAddress: editor.wallet!, role: 'editor' },
      { sceneId: scene.id, userId: viewer.id, walletAddress: viewer.wallet!, role: 'viewer' },
    ] as any)
    const media = async (filename: string, status = 'ready') => {
      const [m] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename, contentType: 'image/png', sizeBytes: 1, storageKey: 'k', publicUrl: 'https://x/a.png', status }).returning()
      const [l] = await db.insert(sceneLibrary).values({ sceneId: scene.id, mediaAssetId: m.id, addedBy: owner.id }).returning()
      return { m, linkId: l.id }
    }
    const rename = (user: TestUser, linkId: string, name: unknown) =>
      app.inject({ method: 'PATCH', url: `/api/scenes/${scene.id}/library/${linkId}`, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: { name } })
    return { owner, editor, viewer, scene, media, rename }
  }

  it("an editor renames a file, keeping its extension", async () => {
    const s = await setup()
    const { m, linkId } = await s.media('IMG_2041.png')
    const res = await s.rename(s.editor, linkId, '  Stage backdrop ')
    expect(res.statusCode).toBe(200)
    expect(res.json().item).toMatchObject({ id: linkId, name: 'Stage backdrop.png' })
    expect((await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, m.id) }))!.filename).toBe('Stage backdrop.png')
    expect((await s.rename(s.editor, linkId, 'Poster.png')).json().item.name).toBe('Poster.png')
  })

  it('refuses empty, too-long or path-like names', async () => {
    const s = await setup()
    const { linkId } = await s.media('a.png')
    for (const name of ['', '   ', 'x'.repeat(121), 'a/b', 42]) expect((await s.rename(s.editor, linkId, name)).statusCode).toBe(400)
  })

  it('refuses unfinished uploads and viewers', async () => {
    const s = await setup()
    const busy = await s.media('b.png', 'uploading')
    expect((await s.rename(s.editor, busy.linkId, 'x')).statusCode).toBe(409)
    const ok = await s.media('c.png')
    expect((await s.rename(s.viewer, ok.linkId, 'x')).statusCode).toBe(403)
  })
})

describe('local storage files', () => {
  it('are served at /uploads even when the server has no dashboard build (local dev)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'virvi-uploads-'))
    mkdirSync(join(dir, 'u1'))
    writeFileSync(join(dir, 'u1', 'a.png'), Buffer.from(PNG, 'base64'))
    const prevPath = process.env.LOCAL_STORAGE_PATH
    const prevDash = config.dashboardDir
    process.env.LOCAL_STORAGE_PATH = dir
    ;(config as any).dashboardDir = join(dir, 'no-dashboard-here')
    const app = await testApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/uploads/u1/a.png' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('image/png')
    } finally {
      await app.close()
      if (prevPath === undefined) delete process.env.LOCAL_STORAGE_PATH
      else process.env.LOCAL_STORAGE_PATH = prevPath
      ;(config as any).dashboardDir = prevDash
    }
  })
})
