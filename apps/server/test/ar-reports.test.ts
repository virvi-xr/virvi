import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/db/connection.js'
import { arReports } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { AR_REPORT_LIMIT, setArReportLimiter } from '../src/routes/ar-feed.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { sendEmail } from '../src/services/email.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'

vi.mock('../src/services/email.js', () => ({ sendEmail: vi.fn(async () => true) }))

const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const FAKE = '00000000-0000-4000-8000-000000000001'

describe('AR space reports', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let sceneId: string
  let spaceId: string

  const prevEmail = config.arReportsEmail
  beforeEach(async () => {
    await resetDb()
    ;(config as any).arReportsEmail = 'support@virvi.io'
    vi.mocked(sendEmail).mockReset()
    vi.mocked(sendEmail).mockResolvedValue(true)
    setArReportLimiter(new TokenBucketLimiter())
    app = await testApp()
    owner = await createUser()
    sceneId = (await createScene(owner)).scene.id
    spaceId = (await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/ar/spaces`, headers: as(owner), payload: { name: 'Arcade <b>' } })).json().id
  })
  afterEach(async () => {
    ;(config as any).arReportsEmail = prevEmail
    await app.close()
  })

  const publish = () => app.inject({ method: 'PUT', url: `/api/ar/spaces/${spaceId}`, headers: as(owner), payload: { published: true } })
  const report = (body: Record<string, unknown> = { reason: 'spam', platform: 'ar-quest' }, id = spaceId) =>
    app.inject({ method: 'POST', url: `/api/ar/spaces/${id}/report`, payload: body })

  it('stores a report on a published space and emails support', async () => {
    await publish()
    const res = await report({ reason: 'unsafe', platform: 'ar-quest' })
    expect([res.statusCode, res.json()]).toEqual([201, { ok: true }])
    const rows = await db.select().from(arReports)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ spaceId, reason: 'unsafe', platform: 'ar-quest', status: 'open' })
    // No identity is stored: the row holds only these columns.
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'id', 'platform', 'reason', 'spaceId', 'status'])
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
    const [to, subject, html] = vi.mocked(sendEmail).mock.calls[0]
    expect(to).toBe('support@virvi.io')
    expect(subject).toBe('Virvi Spaces report: unsafe — Arcade <b>')
    expect(html).toContain('Arcade &lt;b&gt;')
    expect(html).not.toContain('<b>Arcade <b>')
    expect(html).toContain(spaceId)
    expect(html).toContain(sceneId)
  })

  it('with no report address (a self-hosted install that set none) the report is kept and nobody is emailed', async () => {
    ;(config as any).arReportsEmail = ''
    await publish()
    expect((await report()).statusCode).toBe(201)
    expect(await db.select().from(arReports)).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('refuses an unpublished, unknown or malformed space id', async () => {
    expect((await report()).statusCode).toBe(404)
    expect((await report(undefined, FAKE)).statusCode).toBe(404)
    expect((await report(undefined, 'not-a-uuid')).statusCode).toBe(404)
    expect(await db.select().from(arReports)).toHaveLength(0)
  })

  it('refuses a bad reason or platform', async () => {
    await publish()
    for (const body of [{ platform: 'ar-quest' }, { reason: 'rude', platform: 'ar-quest' }, { reason: 5, platform: 'ar-quest' }]) {
      const res = await report(body)
      expect([res.statusCode, res.json().error]).toEqual([400, 'bad_reason'])
    }
    for (const body of [{ reason: 'spam' }, { reason: 'spam', platform: 'hyperfy' }]) {
      const res = await report(body)
      expect([res.statusCode, res.json().error]).toEqual([400, 'bad_platform'])
    }
    expect(await db.select().from(arReports)).toHaveLength(0)
  })

  it('limits one IP to 5 reports an hour', async () => {
    await publish()
    for (let i = 0; i < AR_REPORT_LIMIT.capacity; i++) expect((await report()).statusCode).toBe(201)
    const res = await report()
    expect(res.statusCode).toBe(429)
    expect(res.json().error).toBe('rate_limited')
    expect(await db.select().from(arReports)).toHaveLength(5)
  })

  it('still answers 201 when the email fails', async () => {
    await publish()
    vi.mocked(sendEmail).mockRejectedValue(new Error('smtp down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await report()).statusCode).toBe(201)
    await vi.waitFor(() => expect(err).toHaveBeenCalled())
    err.mockRestore()
    expect(await db.select().from(arReports)).toHaveLength(1)
  })
})

describe('admin AR reports', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let admin: TestUser
  let h: { authorization: string }
  let spaceId: string
  let sceneId: string

  beforeEach(async () => {
    await resetDb()
    setArReportLimiter(new TokenBucketLimiter())
    app = await testApp()
    admin = await createUser({ role: 'admin' })
    h = as(admin)
    const scene = (await createScene(admin)).scene
    sceneId = scene.id
    spaceId = (await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/ar/spaces`, headers: h, payload: { name: 'Arcade' } })).json().id
  })
  afterEach(async () => {
    await app.close()
  })

  const call = (method: string, url: string, payload?: unknown, headers = h) => app.inject({ method: method as any, url, headers, payload: payload as any })

  it('lists open reports newest first, filters by status, and resolves', async () => {
    const [older, newer] = await db
      .insert(arReports)
      .values([
        { spaceId, reason: 'spam', platform: 'ar-quest', createdAt: new Date(Date.now() - 60_000) },
        { spaceId, reason: 'unsafe', platform: 'ar-quest' },
      ])
      .returning()
    const open = (await call('GET', '/api/admin/ar-reports')).json().reports
    expect(open.map((r: any) => r.id)).toEqual([newer.id, older.id])
    expect(open[0]).toMatchObject({ spaceId, spaceName: 'Arcade', sceneId, reason: 'unsafe', platform: 'ar-quest', status: 'open' })
    expect(typeof open[0].sceneName).toBe('string')

    const patched = await call('PATCH', `/api/admin/ar-reports/${newer.id}`, { status: 'resolved' })
    expect([patched.statusCode, patched.json().report]).toEqual([200, { id: newer.id, status: 'resolved' }])
    expect((await call('GET', '/api/admin/ar-reports')).json().reports.map((r: any) => r.id)).toEqual([older.id])
    expect((await call('GET', '/api/admin/ar-reports?status=resolved')).json().reports.map((r: any) => r.id)).toEqual([newer.id])
    expect((await call('GET', '/api/admin/ar-reports?status=all')).json().reports).toHaveLength(2)
    expect((await call('GET', '/api/admin/ar-reports?status=bogus')).statusCode).toBe(400)

    await call('PATCH', `/api/admin/ar-reports/${newer.id}`, { status: 'open' })
    expect((await call('GET', '/api/admin/ar-reports')).json().reports).toHaveLength(2)
  })

  it('rejects a bad status and an unknown report', async () => {
    const [r] = await db.insert(arReports).values({ spaceId, reason: 'spam', platform: 'ar-quest' }).returning()
    expect((await call('PATCH', `/api/admin/ar-reports/${r.id}`, { status: 'closed' })).statusCode).toBe(400)
    expect((await call('PATCH', `/api/admin/ar-reports/${r.id}`, {})).statusCode).toBe(400)
    expect((await call('PATCH', `/api/admin/ar-reports/${FAKE}`, { status: 'resolved' })).statusCode).toBe(404)
    expect((await call('PATCH', '/api/admin/ar-reports/nope', { status: 'resolved' })).statusCode).toBe(404)
  })

  it('non-admins get 403', async () => {
    const headers = as(await createUser({ role: 'creator' }))
    expect((await call('GET', '/api/admin/ar-reports', undefined, headers)).statusCode).toBe(403)
    expect((await call('PATCH', `/api/admin/ar-reports/${FAKE}`, { status: 'resolved' }, headers)).statusCode).toBe(403)
  })
})
