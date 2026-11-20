import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { errorEvents, errorSignatures } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'

const DAY = 86_400_000

describe('GET /api/scenes/:sceneId/errors', () => {
  beforeEach(async () => { await resetDb() })

  async function sig(n: string, message: string) {
    const [s] = await db.insert(errorSignatures).values({ hash: n.padEnd(32, '0'), signature: `server GET /x ${n}`, source: 'server', kind: 'server_5xx', status: 500, message }).returning()
    return s
  }
  async function setup() {
    const app = await testApp()
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const s1 = await sig('a', 'First problem')
    const s2 = await sig('b', 'x'.repeat(300))
    const s3 = await sig('c', 'Old problem')
    const ev = (signatureId: string, ago: number, extra: Partial<typeof errorEvents.$inferInsert> = {}) => ({
      signatureId, occurredAt: new Date(Date.now() - ago), source: 'server', kind: 'server_5xx', sceneId: scene.id,
      userHash: 'secret-hash', requestId: 'req-1', stack: 'Error: boom\n at x', ...extra,
    })
    await db.insert(errorEvents).values([
      ev(s1.id, 3_600_000, { count: 2, status: 500 }),
      ev(s1.id, 7_200_000, { count: 3, status: 502 }),
      ev(s2.id, 2 * DAY, { count: 1, status: 404 }),
      ev(s3.id, 8 * DAY, { count: 9 }),
      ev(s1.id, 3_600_000, { sceneId: null, count: 50 }),
    ])
    return { app, owner, scene, s1, s2 }
  }
  const get = (app: Awaited<ReturnType<typeof testApp>>, id: string, u: Parameters<typeof tokenFor>[0]) =>
    app.inject({ method: 'GET', url: `/api/scenes/${id}/errors`, headers: { authorization: `Bearer ${tokenFor(u)}` } })

  it('shows the owner their recent signatures, newest first, with counts', async () => {
    const { app, owner, scene, s1, s2 } = await setup()
    const res = await get(app, scene.id, owner)
    expect(res.statusCode).toBe(200)
    const { errors } = res.json()
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({ signature: s1.id, title: 'First problem', count: 5, status: 500 })
    expect(errors[1]).toMatchObject({ signature: s2.id, count: 1, status: 404 })
    expect(errors[1].title).toHaveLength(200)
    expect(new Date(errors[0].lastSeenAt).getTime()).toBeGreaterThan(Date.now() - 2 * 3_600_000)
  })

  it('excludes events older than 7 days', async () => {
    const { app, owner, scene } = await setup()
    const { errors } = (await get(app, scene.id, owner)).json()
    expect(errors.map((e: { title: string }) => e.title)).not.toContain('Old problem')
  })

  it('never returns userHash, request ids or stacks', async () => {
    const { app, owner, scene } = await setup()
    const res = await get(app, scene.id, owner)
    expect(res.body).not.toMatch(/userHash|user_hash|secret-hash|requestId|req-1|stack|boom/)
  })

  it("refuses an unrelated user like the scene route does", async () => {
    const { app, scene } = await setup()
    const other = await createUser()
    const mine = await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}`, headers: { authorization: `Bearer ${tokenFor(other)}` } })
    const res = await get(app, scene.id, other)
    expect(res.statusCode).toBe(mine.statusCode)
    expect(res.statusCode).toBe(403)
  })

  it('gives 404 for an unknown scene and for an id that is not a UUID', async () => {
    const { app, owner } = await setup()
    expect((await get(app, '00000000-0000-4000-8000-000000000999', owner)).statusCode).toBe(404)
    expect((await get(app, 'not-a-uuid', owner)).statusCode).toBe(404)
  })
})
