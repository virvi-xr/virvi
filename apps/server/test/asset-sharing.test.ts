import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, assetReports, catalogPacks, sceneLibrary, users } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'
import { listSceneLibrary } from '../src/library/scene-library.js'
import { deleteUserWithModels } from '../src/library/user-models.js'
import { shareLicense, SHARE_LICENSES } from '@virvixr/shared'

/** Sharing a model with other Virvi users (LIV-20): licenses, the Community view, unsharing, reports and takedowns. */
describe('sharing a model (LIV-20)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const as = (user: TestUser | null) => (user ? { authorization: `Bearer ${tokenFor(user)}` } : {})
  const model = async (owner: TestUser | null, values: Partial<typeof assetLibraryItems.$inferInsert> = {}) =>
    (await db.insert(assetLibraryItems).values({ name: 'Chair', storageKey: `k-${Math.random()}`, cdnUrl: `https://cdn.test/${Math.random()}.glb`, uploadedBy: owner?.id ?? null, ...values }).returning())[0]
  const share = (user: TestUser, id: string, payload: Record<string, unknown> = { license: 'cc-by-4.0', rightsConfirmed: true }) =>
    app.inject({ method: 'POST', url: `/api/assets/${id}/share`, headers: as(user), payload })
  const unshare = (user: TestUser, id: string) => app.inject({ method: 'POST', url: `/api/assets/${id}/unshare`, headers: as(user) })
  const row = async (id: string) => (await db.select().from(assetLibraryItems).where(eq(assetLibraryItems.id, id)))[0]

  it('every license has a summary, and legacy ids still read', () => {
    expect(SHARE_LICENSES.map((l) => l.id)).toEqual([
      'cc0-1.0', 'cc-by-4.0', 'cc-by-sa-4.0', 'cc-by-nd-4.0', 'cc-by-nc-4.0', 'cc-by-nc-sa-4.0', 'cc-by-nc-nd-4.0', 'virvi-only',
    ])
    for (const l of SHARE_LICENSES) expect(l.summary.length).toBeGreaterThan(20)
    expect(shareLicense('cc-by')?.id).toBe('cc-by-4.0')
    expect(shareLicense('cc0')?.id).toBe('cc0-1.0')
    expect(shareLicense('proprietary')).toBeNull()
  })

  it('the owner shares a model under a license, credited by their name unless they give one', async () => {
    const owner = await createUser({ name: 'Ada' })
    const m = await model(owner)
    const res = await share(owner, m.id)
    expect(res.statusCode).toBe(200)
    expect(res.json().asset).toMatchObject({ isPublic: true, license: 'cc-by-4.0', author: 'Ada' })
    const saved = await row(m.id)
    expect(saved.sharedAt).toBeInstanceOf(Date)
    expect(saved.priceCents).toBeNull()

    const m2 = await model(owner)
    expect((await share(owner, m2.id, { license: 'cc0-1.0', rightsConfirmed: true, credit: '  Ada Studio  ' })).json().asset.author).toBe('Ada Studio')
  })

  it('sharing needs the rights confirmed and a license from the list', async () => {
    const owner = await createUser()
    const m = await model(owner)
    expect((await share(owner, m.id, { license: 'cc-by-4.0' })).json().error).toBe('rights_not_confirmed')
    expect((await share(owner, m.id, { license: 'proprietary', rightsConfirmed: true })).json().error).toBe('unknown_license')
    expect((await share(owner, m.id, { license: 'cc-by-4.0', rightsConfirmed: true, credit: 'x'.repeat(81) })).statusCode).toBe(400)
    expect((await row(m.id)).isPublic).toBe(false)
  })

  it("only the owner shares, and never a catalog model, a room scan, an unfinished upload or a taken-down one", async () => {
    const owner = await createUser(); const other = await createUser()
    const m = await model(owner)
    expect((await share(other, m.id)).statusCode).toBe(403)
    await db.insert(catalogPacks).values({ id: 'p', name: 'P', source: 'dhingia', license: 'mit', attribution: 'a', sourceUrl: 'https://x.test' })
    expect((await share(owner, (await model(null, { packId: 'p', isPublic: true })).id)).statusCode).toBe(403)
    expect((await share(owner, (await model(owner, { category: 'room' })).id)).json().error).toBe('room_assets_private')
    expect((await share(owner, (await model(owner, { status: 'uploading' })).id)).json().error).toBe('not_ready')
    expect((await share(owner, (await model(owner, { takenDownAt: new Date() })).id)).json().error).toBe('taken_down')
  })

  it('PUT and upload no longer make a model public or set its license: sharing does', async () => {
    const owner = await createUser()
    const m = await model(owner)
    const put = await app.inject({ method: 'PUT', url: `/api/assets/${m.id}`, headers: as(owner), payload: { isPublic: true } })
    expect(put.statusCode).toBe(400)
    expect(put.json().error).toBe('use_share')
    expect((await app.inject({ method: 'PUT', url: `/api/assets/${m.id}`, headers: as(owner), payload: { license: 'cc0-1.0' } })).json().error).toBe('use_share')
    const up = await app.inject({ method: 'POST', url: '/api/assets', headers: as(owner), payload: { name: 'D', filename: 'd.glb', contentType: 'model/gltf-binary', fileData: 'AAAA', isPublic: true, license: 'cc0' } })
    expect(up.statusCode).toBe(201)
    expect(up.json().asset).toMatchObject({ isPublic: false, license: null })
  })

  it('Community lists models people shared, not the catalog, with their credit and license', async () => {
    const owner = await createUser({ name: 'Ada' })
    await db.insert(catalogPacks).values({ id: 'p', name: 'P', source: 'dhingia', license: 'mit', attribution: 'a', sourceUrl: 'https://x.test' })
    await model(null, { name: 'Catalog lamp', packId: 'p', isPublic: true })
    const shared = await model(owner, { name: 'Shared chair' })
    await share(owner, shared.id)
    await model(owner, { name: 'Private desk' })
    const res = await app.inject({ method: 'GET', url: '/api/assets?scope=community', headers: as(await createUser()) })
    expect(res.statusCode).toBe(200)
    expect(res.json().assets.map((a: { name: string }) => a.name)).toEqual(['Shared chair'])
    expect(res.json().assets[0]).toMatchObject({ author: 'Ada', license: 'cc-by-4.0' })
    // Who uploaded it is the owner's business: others see the credit, not an account id
    expect(res.json().assets[0]).toMatchObject({ mine: false })
    expect(res.json().assets[0].uploadedBy).toBeUndefined()
    const mine = await app.inject({ method: 'GET', url: '/api/assets?scope=community', headers: as(owner) })
    expect(mine.json().assets[0]).toMatchObject({ mine: true, uploadedBy: owner.id })
  })

  it('anyone can add a shared model to their scene; after unsharing, scenes that have it keep it and new ones can\'t add it', async () => {
    const owner = await createUser(); const other = await createUser()
    const m = await model(owner)
    await share(owner, m.id)
    const { scene: early } = await createScene(other, 'Early')
    const add = (scene: { id: string }) => app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/library`, headers: as(other), payload: { assetItemId: m.id } })
    expect((await add(early)).statusCode).toBe(201)

    expect((await unshare(owner, m.id)).json().asset.isPublic).toBe(false)
    expect((await listSceneLibrary(early.id)).map((i) => i.name)).toEqual(['Chair'])
    expect((await add((await createScene(other, 'Late')).scene)).statusCode).toBe(403)
  })

  it("deleting a model someone else's scene uses keeps it for them, private and no longer the owner's", async () => {
    const owner = await createUser(); const other = await createUser()
    const used = await model(owner)
    await share(owner, used.id)
    const { scene } = await createScene(other)
    await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/library`, headers: as(other), payload: { assetItemId: used.id } })
    const res = await app.inject({ method: 'DELETE', url: `/api/assets/${used.id}`, headers: as(owner) })
    expect(res.statusCode).toBe(200)
    expect(await row(used.id)).toMatchObject({ isPublic: false, uploadedBy: null })
    expect((await listSceneLibrary(scene.id)).length).toBe(1)

    const unused = await model(owner)
    await share(owner, unused.id)
    await app.inject({ method: 'DELETE', url: `/api/assets/${unused.id}`, headers: as(owner) })
    expect(await row(unused.id)).toBeUndefined()
  })

  it("deleting an account keeps a once-shared model another account's scene still uses", async () => {
    const owner = await createUser(); const other = await createUser()
    const m = await model(owner)
    await share(owner, m.id)
    const { scene } = await createScene(other)
    await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/library`, headers: as(other), payload: { assetItemId: m.id } })
    await unshare(owner, m.id)
    await deleteUserWithModels(owner.id, async (tx) => (await tx.delete(users).where(eq(users.id, owner.id)).returning()).length > 0)
    expect(await row(m.id)).toMatchObject({ uploadedBy: null, isPublic: false })
  })

  it('a signed-in person can report a shared model once; private ones can\'t be reported', async () => {
    const owner = await createUser(); const reporter = await createUser()
    const m = await model(owner)
    const report = (id: string, payload: Record<string, unknown> = { reason: 'copyright', details: 'This is my model' }) =>
      app.inject({ method: 'POST', url: `/api/assets/${id}/report`, headers: as(reporter), payload })
    expect((await report(m.id)).statusCode).toBe(404)
    await share(owner, m.id)
    expect((await report(m.id, { reason: 'boring' })).statusCode).toBe(400)
    expect((await report(m.id)).statusCode).toBe(201)
    expect((await report(m.id)).statusCode).toBe(200)
    expect((await db.select().from(assetReports)).length).toBe(1)
    expect((await app.inject({ method: 'POST', url: `/api/assets/${m.id}/report`, payload: { reason: 'spam' } })).statusCode).toBe(401)
  })

  it('an admin sees open reports and takes a model down: hidden, the reports closed, and the owner can\'t share it again', async () => {
    const owner = await createUser(); const reporter = await createUser(); const admin = await createUser({ role: 'admin' })
    const m = await model(owner)
    await share(owner, m.id)
    await app.inject({ method: 'POST', url: `/api/assets/${m.id}/report`, headers: as(reporter), payload: { reason: 'offensive' } })
    expect((await app.inject({ method: 'GET', url: '/api/admin/asset-reports', headers: as(owner) })).statusCode).toBe(403)
    const open = await app.inject({ method: 'GET', url: '/api/admin/asset-reports', headers: as(admin) })
    expect(open.json().reports).toHaveLength(1)
    expect(open.json().reports[0]).toMatchObject({ reason: 'offensive', asset: { id: m.id, name: 'Chair' } })

    const down = await app.inject({ method: 'POST', url: `/api/admin/assets/${m.id}/takedown`, headers: as(admin), payload: { reason: 'Copyright claim' } })
    expect(down.statusCode).toBe(200)
    expect(await row(m.id)).toMatchObject({ isPublic: false, takedownReason: 'Copyright claim' })
    expect((await app.inject({ method: 'GET', url: '/api/admin/asset-reports', headers: as(admin) })).json().reports).toHaveLength(0)
    expect((await share(owner, m.id)).json().error).toBe('taken_down')
  })

  it('an admin can dismiss a report without taking the model down', async () => {
    const owner = await createUser(); const reporter = await createUser(); const admin = await createUser({ role: 'admin' })
    const m = await model(owner)
    await share(owner, m.id)
    await app.inject({ method: 'POST', url: `/api/assets/${m.id}/report`, headers: as(reporter), payload: { reason: 'spam' } })
    const [r] = await db.select().from(assetReports)
    expect((await app.inject({ method: 'POST', url: `/api/admin/asset-reports/${r.id}/dismiss`, headers: as(admin) })).statusCode).toBe(200)
    expect((await row(m.id)).isPublic).toBe(true)
    expect((await db.select().from(assetReports))[0].status).toBe('dismissed')
    void sceneLibrary
  })
})
