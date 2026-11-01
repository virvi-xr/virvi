import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, catalogPacks, mediaAssets } from '../src/db/schema.js'
import { linkToScene } from '../src/library/scene-library.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const SECRET = 'headset-secret-hud'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

describe('the in-world HUD routes take a headset pass', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let other: TestUser
  let mine: { sceneId: string; elementId: string; libId: string; catalogItemId: string }
  let theirs: { sceneId: string; elementId: string; libId: string }
  let deviceId: string
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    owner = await createUser({ wallet: randomWallet() })
    other = await createUser({ wallet: randomWallet() })
    await db.insert(catalogPacks).values({ id: 'p', name: 'p', source: 'test', license: 'x', attribution: 'x', sourceUrl: 'x' })
    const [item] = await db.insert(assetLibraryItems).values({ name: 'Duck', storageKey: 'k', cdnUrl: 'https://cdn/duck.glb', isPublic: true, packId: 'p' } as any).returning()
    const build = async (u: TestUser, n: string) => {
      const { scene, preset } = await createScene(u, n)
      const el = await createElement(preset.id)
      const [m] = await db.insert(mediaAssets).values({ ownerId: u.id, filename: 'x.png', contentType: 'image/png', sizeBytes: 10, storageKey: `k-${n}`, publicUrl: `https://cdn/${n}.png`, status: 'ready' } as any).returning()
      const libId = await linkToScene(scene.id, { mediaAssetId: m.id }, u.id)
      return { sceneId: scene.id, elementId: el.id, libId }
    }
    mine = { ...(await build(owner, 'Mine')), catalogItemId: item.id }
    theirs = await build(other, 'Theirs')
    const { code } = (await app.inject({ method: 'POST', url: '/api/ar/pair', payload: { secretHash: sha256(SECRET), deviceName: 'Vision Pro' } })).json()
    expect((await app.inject({ method: 'POST', url: `/api/ar/pair/${code}/approve`, headers: as(owner), payload: { kind: 'personal' } })).statusCode).toBe(200)
    deviceId = (await app.inject({ method: 'POST', url: `/api/ar/pair/${code}/claim`, payload: { secret: SECRET } })).json().deviceId
  })
  afterEach(async () => { await app.close() })

  const passFor = async (sceneId: string) => {
    const res = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/pass`, payload: { secret: SECRET, sceneId } })
    expect(res.statusCode).toBe(200)
    return { authorization: `Bearer ${res.json().pass}` }
  }

  type Ids = { sceneId: string; elementId: string; libId: string }
  const wallet = '0x' + 'ab'.repeat(20)
  // [label, method, url, body, normal status]
  const routes: Array<[string, string, (i: Ids) => string, (() => unknown) | undefined, number]> = [
    ['GET library', 'GET', (i) => `/api/scenes/${i.sceneId}/library`, undefined, 200],
    ['POST library', 'POST', (i) => `/api/scenes/${i.sceneId}/library`, () => ({ assetItemId: mine.catalogItemId }), 201],
    ['PATCH library item', 'PATCH', (i) => `/api/scenes/${i.sceneId}/library/${i.libId}`, () => ({ name: 'renamed' }), 200],
    ['DELETE library item', 'DELETE', (i) => `/api/scenes/${i.sceneId}/library/${i.libId}`, undefined, 204],
    ['POST upload-tokens', 'POST', () => '/api/upload-tokens', undefined, 201],
    ['GET roles', 'GET', (i) => `/api/scenes/${i.sceneId}/roles`, undefined, 200],
    ['POST roles', 'POST', (i) => `/api/scenes/${i.sceneId}/roles`, () => ({ wallet, role: 'viewer' }), 201],
    ['DELETE roles', 'DELETE', (i) => `/api/scenes/${i.sceneId}/roles/${wallet}`, undefined, 204],
    // No destination is set up, so the documented answer is 200 with destination: null.
    ['GET publish-status', 'GET', (i) => `/api/scenes/${i.sceneId}/dcl/publish-status`, undefined, 200],
    ['POST element live', 'POST', (i) => `/api/elements/${i.elementId}/live`, () => ({ enabled: true }), 200],
    ['PUT scene', 'PUT', (i) => `/api/scenes/${i.sceneId}`, () => ({ name: 'Renamed' }), 200],
    ['GET scene', 'GET', (i) => `/api/scenes/${i.sceneId}`, undefined, 200],
  ]

  it.each(routes)('%s: the owner pass gets the normal status', async (_l, method, url, body, status) => {
    const headers = await passFor(mine.sceneId)
    const payload = body ? body() : undefined
    const u = url(mine)
    const res = await app.inject({ method: method as any, url: u, headers, payload: (u === '/api/upload-tokens' ? { sceneId: mine.sceneId } : payload) as any })
    expect(res.body).not.toContain('ar_pass_not_allowed')
    expect(res.statusCode).toBe(status)
  })

  it.each(routes)('%s: the same pass on another scene gets 403', async (_l, method, url, body) => {
    const headers = await passFor(mine.sceneId)
    const u = url(theirs)
    const payload = u === '/api/upload-tokens' ? { sceneId: theirs.sceneId } : body ? body() : undefined
    const res = await app.inject({ method: method as any, url: u, headers, payload: payload as any })
    expect(res.statusCode).toBe(403)
  })

  it('keeps transfer-host and the web hand-off away from a headset pass', async () => {
    const headers = await passFor(mine.sceneId)
    const th = await app.inject({ method: 'POST', url: `/api/scenes/${mine.sceneId}/transfer-host`, headers, payload: { wallet } })
    expect([th.statusCode, th.json().error]).toEqual([403, 'ar_pass_not_allowed'])
    const ho = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers, payload: {} })
    expect([ho.statusCode, ho.json().error]).toEqual([403, 'ar_pass_not_allowed'])
  })
})
