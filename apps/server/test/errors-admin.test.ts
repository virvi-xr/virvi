import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import type { ClientErrorEvent } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { errorSignatures, errorHourly } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { clientRecord, writeRecords, recordServerResponse, flushErrors, resetErrorBuffer } from '../src/errors/record.js'
import { resetErrorBudgets } from '../src/errors/limits.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ORG = '11111111-2222-4333-8444-555555555555'
const ctx = (user: string | null, release = config.release, browser = 'Chrome 131') => ({ release, browser, os: 'macOS', userHash: user, orgId: ORG, ipKey: '198.51.100.1', ipHash: 'ip:198.51.100.1' })
const crash = (over: Partial<ClientErrorEvent> = {}): ClientErrorEvent => ({
  kind: 'crash', t: Date.now(), route: '/scenes', errorType: 'TypeError', message: 'Cannot read item 4', requestId: '0b1c2d3e-0000-4000-8000-0000000000a1',
  breadcrumbs: [{ t: Date.now(), type: 'nav', path: '/scenes' }], ...over,
})

describe('admin Errors page routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let admin: TestUser
  let creator: TestUser
  beforeEach(async () => {
    await resetDb()
    resetErrorBuffer()
    resetErrorBudgets()
    app = await testApp()
    admin = await createUser({ role: 'admin' })
    creator = await createUser()
  })
  afterEach(async () => { await app.close() })
  const get = (url: string, u = admin) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokenFor(u)}` } })

  it('are for site admins only', async () => {
    const [sig] = await db.insert(errorSignatures).values({ hash: 'h', signature: 's', source: 'web', kind: 'crash' }).returning()
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/admin/errors'], ['GET', `/api/admin/errors/${sig.id}`], ['PATCH', `/api/admin/errors/${sig.id}`, { resolved: true }],
      ['GET', '/api/admin/error-settings'], ['PUT', '/api/admin/error-settings', { newMinUsers: 3 }],
    ]
    for (const [method, url, payload] of routes) {
      const as = (u: TestUser) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tokenFor(u)}` } })
      expect((await as(creator)).statusCode, `${method} ${url}`).toBe(403)
      expect((await app.inject({ method: method as any, url, payload: payload as any })).statusCode, `${method} ${url}`).toBe(401)
      expect((await as(admin)).statusCode, `${method} ${url}`).toBe(200)
    }
  })

  it('shows top, new since this deploy, spiking, regressed and expected signatures', async () => {
    const now = new Date()
    // top: one signature with 3 users, another with many events but 1 user
    for (const u of ['a', 'b', 'c']) await writeRecords([clientRecord(crash(), ctx(u))])
    await writeRecords([{ ...clientRecord(crash({ errorType: 'RangeError', message: 'too deep' }), ctx('a', 'old111')), count: 40 }])
    // expected: charted apart, never in top
    await writeRecords([clientRecord({ kind: 'api', t: Date.now(), method: 'GET', path: '/api/scenes', status: 401 }, ctx('a'))])
    // a regression
    await writeRecords([clientRecord(crash({ errorType: 'SyntaxError', message: 'bad json' }), ctx('d'))])
    const [regressed] = await db.select().from(errorSignatures).where(eq(errorSignatures.errorType, 'SyntaxError'))
    await db.update(errorSignatures).set({ resolvedAt: new Date(Date.now() - 1000) }).where(eq(errorSignatures.id, regressed.id))
    await writeRecords([clientRecord(crash({ errorType: 'SyntaxError', message: 'bad json' }), ctx('d'))])
    // a spike: an old signature with quiet weeks behind it
    const h0 = Math.floor(now.getTime() / HOUR) * HOUR
    await writeRecords([{ ...clientRecord(crash({ kind: 'console', message: 'slow' }), ctx(null), new Date(h0 - 30 * DAY)), count: 1 }])
    const [spiky] = await db.select().from(errorSignatures).where(eq(errorSignatures.kind, 'console'))
    for (let w = 1; w <= 4; w++) await db.insert(errorHourly).values({ signatureId: spiky.id, hour: new Date(h0 - w * 7 * DAY), count: 1 })
    await writeRecords([{ ...clientRecord(crash({ kind: 'console', message: 'slow' }), ctx(null), now), count: 12 }])

    const res = await get('/api/admin/errors')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.release).toBe(config.release)
    expect(body.top.day.byUsers[0]).toMatchObject({ users: 3, count: 3 })
    expect(body.top.day.byUsers[0].signature).toContain('Cannot read item')
    expect(body.top.day.byCount[0].signature).toContain('RangeError')
    expect(body.top.week.byCount[0].count).toBe(40)
    expect(body.top.day.byCount.some((s: any) => s.expected)).toBe(false)
    const fresh = body.new.find((s: any) => s.signature.includes('Cannot read item'))
    expect(fresh.sinceDeploy).toBe(true)
    expect(body.new.find((s: any) => s.signature.includes('RangeError')).sinceDeploy).toBe(false)
    expect(body.spiking.map((s: any) => s.id)).toEqual([spiky.id])
    expect(body.spiking[0]).toMatchObject({ count: 12, usual: 1 })
    expect(body.regressions.map((s: any) => s.id)).toEqual([regressed.id])
    expect(body.expected).toHaveLength(1)
    expect(body.expected[0]).toMatchObject({ expected: 'session', count: 1 })
    expect(body.expected[0].hourly).toHaveLength(168)
    expect(body.expected[0].hourly.at(-1)).toBe(1)
  })

  it('shows a signature’s timeline, breakdowns, events, joined server events and reports; and marks it fixed', async () => {
    await writeRecords([clientRecord(crash(), ctx('a'))])
    await writeRecords([clientRecord(crash(), ctx('b', config.release, 'Firefox 132'))])
    recordServerResponse({ status: 500, method: 'PUT', routeTemplate: '/api/scenes/:sceneId', requestId: '0b1c2d3e-0000-4000-8000-0000000000a1' }, new Error('db down'))
    await flushErrors()
    const [sig] = await db.select().from(errorSignatures).where(eq(errorSignatures.kind, 'crash'))
    await app.inject({ method: 'POST', url: '/api/errors/reports', headers: { authorization: `Bearer ${tokenFor(creator)}` }, payload: { v: 1, description: 'Saving', event: crash() } })

    const res = await get(`/api/admin/errors/${sig.id}`)
    expect(res.statusCode).toBe(200)
    const d = res.json()
    // a report counts nothing: no event, no affected user
    expect(d.totals).toEqual({ day: 2, week: 2, usersWeek: 2 })
    expect(d.timeline).toHaveLength(1)
    expect(d.timeline[0]).toMatchObject({ count: 2, users: 2 })
    expect(d.hourOfDay.reduce((a: number, b: number) => a + b, 0)).toBe(2)
    expect(d.breakdowns.browser.map((b: any) => b.value).sort()).toEqual(['Chrome 131', 'Firefox 132'])
    expect(d.breakdowns.release).toEqual([{ value: config.release, count: 2 }])
    expect(d.breakdowns.route).toEqual([{ value: '/scenes', count: 2 }])
    expect(d.breakdowns.org).toEqual([{ value: ORG, count: 2 }])
    expect(d.events).toHaveLength(2)
    expect(d.events[0].breadcrumbs).toEqual([expect.objectContaining({ type: 'nav', path: '/scenes' })])
    expect(d.requestIds).toEqual(['0b1c2d3e-0000-4000-8000-0000000000a1'])
    expect(d.joined).toEqual([expect.objectContaining({ source: 'server', signature: 'server_5xx 500 PUT /api/scenes/:sceneId' })])
    expect(d.reports).toEqual([expect.objectContaining({ description: 'Saving', from: creator.email })])
    expect((await get('/api/admin/errors/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404)
    expect((await get('/api/admin/errors/nope')).statusCode).toBe(404)

    const patch = (resolved: unknown) => app.inject({ method: 'PATCH', url: `/api/admin/errors/${sig.id}`, headers: { authorization: `Bearer ${tokenFor(admin)}` }, payload: { resolved } })
    expect((await patch('yes')).statusCode).toBe(400)
    expect((await patch(true)).json().resolvedAt).not.toBeNull()
    const [row] = await db.select().from(errorSignatures).where(eq(errorSignatures.id, sig.id))
    expect(row.resolvedBy).toBe(admin.id)
    expect((await patch(false)).json().resolvedAt).toBeNull()
  })

  it('tunes the filing thresholds, and says whether Linear is set up', async () => {
    const s = await get('/api/admin/error-settings')
    expect(s.json()).toMatchObject({ thresholds: config.errorThresholds, linear: { configured: false } })
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/admin/error-settings', headers: { authorization: `Bearer ${tokenFor(admin)}` }, payload: payload as any })
    expect((await put({ newMinUsers: 0 })).statusCode).toBe(400)
    expect((await put({ newMinUsers: 4, filing: false })).json().thresholds).toMatchObject({ newMinUsers: 4, filing: false, spikeFactor: 3 })
    expect((await get('/api/admin/error-settings')).json().thresholds).toMatchObject({ newMinUsers: 4, filing: false })
  })
})
