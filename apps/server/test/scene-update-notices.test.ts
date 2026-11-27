import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, notifications, scenes } from '../src/db/schema.js'
import { sweepHudUpdates } from '../src/scenes/hud-notices.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

vi.mock('../src/services/email.js', () => ({ sendEmail: vi.fn(async () => true) }))

/** LIV-30: scene owners hear in the bell when their scene is behind, and model owners about takedowns and appeals. */

const DAY = 24 * 3600_000
const now = new Date('2026-11-27T10:00:00Z')

async function sceneOn(owner: TestUser, version: string | null, seenDaysAgo = 1, name = 'Club') {
  const { scene } = await createScene(owner, name)
  await db.update(scenes).set({ dclHudVersion: version, dclHudSeenAt: new Date(now.getTime() - seenDaysAgo * DAY) }).where(eq(scenes.id, scene.id))
  return scene
}
const rowsOf = (userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId))

describe('scene update notices', () => {
  beforeEach(resetDb)

  it('tells the owner once per scene per release, even after they read it', async () => {
    const owner = await createUser()
    const behind = await sceneOn(owner, '2.21.1')
    await sceneOn(owner, '2.23.0', 1, 'Current') // up to date
    await sceneOn(owner, '2.20.0', 45, 'Dormant') // no HUD in 30 days
    const gone = await sceneOn(owner, '2.20.0', 1, 'Deleted')
    await db.update(scenes).set({ deletedAt: now }).where(eq(scenes.id, gone.id))

    expect(await sweepHudUpdates(now, '2.23.0')).toBe(1)
    const [n] = await rowsOf(owner.id)
    expect(n).toMatchObject({ kind: 'scene_update', data: { sceneId: behind.id, sceneName: 'Club', version: '2.21.1', latest: '2.23.0', virviDeploys: false } })

    await db.update(notifications).set({ readAt: now }).where(eq(notifications.id, n.id))
    expect(await sweepHudUpdates(now, '2.23.0')).toBe(0)
    expect(await rowsOf(owner.id)).toHaveLength(1)

    // The next release is news again
    expect(await sweepHudUpdates(now, '2.24.0')).toBe(2) // Club, and now Current too
    expect(await rowsOf(owner.id)).toHaveLength(3)
  })

  it('a scene that never sent a version is behind once the latest release sends one', async () => {
    const owner = await createUser()
    await sceneOn(owner, null)
    expect(await sweepHudUpdates(now, '2.23.0')).toBe(1)
  })
})

describe('the bell lists the new kinds', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())
  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

  it('scene updates and moderation notices show, and are never marked gone', async () => {
    const owner = await createUser()
    const admin = await createUser({ role: 'admin' })
    await sceneOn(owner, '2.21.1')
    await sweepHudUpdates(now, '2.23.0')
    const [m] = await db.insert(assetLibraryItems).values({ name: 'Chair', storageKey: 'k', cdnUrl: 'https://cdn.test/c.glb', uploadedBy: owner.id, isPublic: true, license: 'cc-by-4.0' } as never).returning()
    await app.inject({ method: 'POST', url: `/api/admin/assets/${m.id}/takedown`, headers: as(admin), payload: { reason: 'Copyright claim' } })
    const appeal = (await app.inject({ method: 'POST', url: `/api/assets/${m.id}/appeal`, headers: as(owner), payload: { message: 'Mine' } })).json().appeal
    await app.inject({ method: 'POST', url: `/api/admin/appeals/${appeal.id}/restore`, headers: as(admin), payload: { response: 'Confirmed.' } })

    expect((await app.inject({ method: 'GET', url: '/api/notifications/unread-count', headers: as(owner) })).json().count).toBe(3)
    const { items } = (await app.inject({ method: 'GET', url: '/api/notifications', headers: as(owner) })).json()
    expect(items.map((i: any) => i.kind).sort()).toEqual(['model_appeal', 'model_taken_down', 'scene_update'])
    expect(items.every((i: any) => i.gone === false)).toBe(true)
    expect(items.find((i: any) => i.kind === 'model_taken_down').data).toEqual({ assetId: m.id, assetName: 'Chair', reason: 'Copyright claim' })
    expect(items.find((i: any) => i.kind === 'model_appeal').data).toMatchObject({ decision: 'restored', response: 'Confirmed.' })
  })
})
