import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { arReports, arSpaces, assetLibraryItems, assetReports, moderationActions } from '../src/db/schema.js'
import { sendEmail } from '../src/services/email.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

vi.mock('../src/services/email.js', () => ({ sendEmail: vi.fn(async () => true) }))

/** Moderation (LIV-34): the log of admin decisions, telling owners about a takedown, and appeals. */

describe('moderation', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); vi.mocked(sendEmail).mockClear(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const as = (user: TestUser) => ({ authorization: `Bearer ${tokenFor(user)}` })
  const post = (user: TestUser, url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: as(user), payload: payload as any })
  const model = async (owner: TestUser) =>
    (await db.insert(assetLibraryItems).values({ name: 'Chair <b>', storageKey: `k-${Math.random()}`, cdnUrl: `https://cdn.test/${Math.random()}.glb`, uploadedBy: owner.id, isPublic: true, license: 'cc-by-4.0' } as never).returning())[0]
  const settle = () => new Promise((r) => setTimeout(r, 20))
  const emailsTo = (address: string | null) => vi.mocked(sendEmail).mock.calls.filter(([to]) => to === address)

  it('a takedown is logged and the owner is emailed why, with how to appeal', async () => {
    const owner = await createUser({ name: 'Ada' })
    const admin = await createUser({ role: 'admin', name: 'Mod' })
    const m = await model(owner)
    expect((await post(admin, `/api/admin/assets/${m.id}/takedown`, { reason: 'Copyright claim' })).statusCode).toBe(200)
    await settle()
    const [log] = await db.select().from(moderationActions)
    expect(log).toMatchObject({ targetType: 'asset', targetId: m.id, action: 'taken_down', reason: 'Copyright claim', actorId: admin.id, ownerId: owner.id })
    const [[, subject, html]] = emailsTo(owner.email)
    expect(subject).toBe('Virvi took down your model Chair <b>')
    expect(html).toContain('Chair &lt;b&gt;') // escaped in the body
    expect(html).toContain('Why: Copyright claim')
    expect(html).toContain('Appeal')
  })

  it("an unconfirmed address isn't emailed", async () => {
    const owner = await createUser({ emailVerified: false })
    const admin = await createUser({ role: 'admin' })
    const m = await model(owner)
    await post(admin, `/api/admin/assets/${m.id}/takedown`, { reason: 'Spam' })
    await settle()
    expect(emailsTo(owner.email)).toHaveLength(0)
  })

  it('the owner appeals once; an admin restores it (it can be shared again) or rejects it with a reason', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const admin = await createUser({ role: 'admin' })
    const m = await model(owner)
    // Nothing to appeal before a takedown
    expect((await post(owner, `/api/assets/${m.id}/appeal`, { message: 'Please' })).statusCode).toBe(409)
    await post(admin, `/api/admin/assets/${m.id}/takedown`, { reason: 'Copyright claim' })

    expect((await post(stranger, `/api/assets/${m.id}/appeal`, { message: 'Mine!' })).statusCode).toBe(404)
    expect((await post(owner, `/api/assets/${m.id}/appeal`, { message: '' })).statusCode).toBe(400)
    expect((await post(owner, `/api/assets/${m.id}/appeal`, { message: 'I made it myself; here is the source file.' })).statusCode).toBe(201)
    expect((await post(owner, `/api/assets/${m.id}/appeal`, { message: 'Again' })).json().error).toBe('appeal_open')
    const mine = (await app.inject({ method: 'GET', url: `/api/assets/${m.id}/appeal`, headers: as(owner) })).json().appeal
    expect(mine).toMatchObject({ status: 'open', response: null })

    // The admin queue shows it
    expect((await app.inject({ method: 'GET', url: '/api/admin/moderation', headers: as(owner) })).statusCode).toBe(403)
    const overview = (await app.inject({ method: 'GET', url: '/api/admin/moderation', headers: as(admin) })).json()
    expect(overview.appeals).toEqual([expect.objectContaining({ id: mine.id, message: 'I made it myself; here is the source file.', asset: expect.objectContaining({ id: m.id, takedownReason: 'Copyright claim' }) })])

    // A rejection needs a reason
    expect((await post(admin, `/api/admin/appeals/${mine.id}/reject`, {})).statusCode).toBe(400)
    expect((await post(admin, `/api/admin/appeals/${mine.id}/restore`, { response: 'Thanks, confirmed.' })).statusCode).toBe(200)
    expect((await post(admin, `/api/admin/appeals/${mine.id}/restore`, {})).statusCode).toBe(404) // already decided
    const after = (await db.select().from(assetLibraryItems).where(eq(assetLibraryItems.id, m.id)))[0]
    expect(after).toMatchObject({ takenDownAt: null, takedownReason: null, isPublic: false }) // back, but not re-shared by itself
    expect((await post(owner, `/api/assets/${m.id}/share`, { license: 'cc-by-4.0', rightsConfirmed: true })).statusCode).toBe(200)
    await settle()
    expect(emailsTo(owner.email).map(([, s]) => s)).toContain('Your model Chair <b> is back')

    const log = (await app.inject({ method: 'GET', url: '/api/admin/moderation', headers: as(admin) })).json().log
    expect(log.map((l: any) => l.action)).toEqual(['restored', 'taken_down'])
    expect(log[0]).toMatchObject({ reason: 'Thanks, confirmed.', actor: 'Test User' })
  })

  it('a rejected appeal keeps the takedown and tells the owner why', async () => {
    const owner = await createUser()
    const admin = await createUser({ role: 'admin' })
    const m = await model(owner)
    await post(admin, `/api/admin/assets/${m.id}/takedown`, { reason: 'Offensive' })
    const appeal = (await post(owner, `/api/assets/${m.id}/appeal`, { message: 'It is art' })).json().appeal
    expect((await post(admin, `/api/admin/appeals/${appeal.id}/reject`, { response: 'It breaks the content rules.' })).statusCode).toBe(200)
    expect((await db.select().from(assetLibraryItems).where(eq(assetLibraryItems.id, m.id)))[0].takenDownAt).not.toBeNull()
    await settle()
    const [, , html] = emailsTo(owner.email).find(([, s]) => s.startsWith('About your appeal'))!
    expect(html).toContain('It breaks the content rules.')
    // A new appeal can follow a decided one
    expect((await post(owner, `/api/assets/${m.id}/appeal`, { message: 'More context' })).statusCode).toBe(201)
  })

  it('dismissing a report and resolving a Spaces report are logged', async () => {
    const owner = await createUser()
    const reporter = await createUser()
    const admin = await createUser({ role: 'admin' })
    const m = await model(owner)
    const [r] = await db.insert(assetReports).values({ assetItemId: m.id, reporterId: reporter.id, reason: 'spam' }).returning()
    await post(admin, `/api/admin/asset-reports/${r.id}/dismiss`)
    const { scene } = await createScene(owner)
    const [space] = await db.insert(arSpaces).values({ sceneId: scene.id, name: 'Lobby' } as never).returning()
    const [ar] = await db.insert(arReports).values({ spaceId: space.id, reason: 'spam', platform: 'ar-quest' }).returning()
    await app.inject({ method: 'PATCH', url: `/api/admin/ar-reports/${ar.id}`, headers: as(admin), payload: { status: 'resolved' } })
    const log = await db.select().from(moderationActions)
    expect(log.map((l) => [l.targetType, l.action])).toEqual(expect.arrayContaining([['asset_report', 'dismissed'], ['ar_report', 'resolved']]))
    expect(log.find((l) => l.targetType === 'asset_report')).toMatchObject({ ownerId: owner.id, actorId: admin.id })
  })
})
