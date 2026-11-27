import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { statusChecks } from '../src/db/schema.js'
import { checkDecentraland, purgeStatus, recordCheck, resetStatusChecks, runStatusChecks, statusPage, STATUS_DAYS } from '../src/status/checks.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

/** The public status page (LIV-40). */

const MIN = 60_000
const ok = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
const failing = (bad: string) => (async (url: string) => (url.includes(bad) ? new Response('', { status: 503 }) : new Response('{}', { status: 200 }))) as unknown as typeof fetch

describe('status checks', () => {
  beforeEach(async () => { await resetDb(); resetStatusChecks() })

  it('Decentraland is up, degraded with one content server down, down with both', async () => {
    expect((await checkDecentraland(ok)).state).toBe('up')
    expect(await checkDecentraland(failing('worlds'))).toEqual({ state: 'degraded', detail: 'Worlds content server unreachable' })
    expect((await checkDecentraland(failing('decentraland.org'))).state).toBe('down')
    const throws = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect((await checkDecentraland(throws)).state).toBe('down')
  })

  it('a pass records the API every minute and asks Decentraland every 5 minutes', async () => {
    let calls = 0
    const counting = (async () => { calls++; return new Response('{}') }) as unknown as typeof fetch
    const t0 = new Date('2026-11-26T10:00:10Z')
    for (let i = 0; i < 6; i++) await runStatusChecks(new Date(t0.getTime() + i * MIN), counting)
    expect(calls).toBe(4) // two servers at minute 0 and minute 5
    const rows = await db.select().from(statusChecks)
    expect(rows.filter((r) => r.component === 'api')).toHaveLength(6)
    expect(rows.filter((r) => r.component === 'decentraland').every((r) => r.state === 'up')).toBe(true)
  })

  it("counts a minute with no API check as down, from the first check on, and nothing before it", async () => {
    const now = new Date('2026-11-26T12:00:30Z')
    // Checks from 10:00 to 11:59, with 11:00–11:29 missing (the server was down)
    for (let m = 0; m < 120; m++) {
      if (m >= 60 && m < 90) continue
      await recordCheck('api', 'up', null, new Date(Date.UTC(2026, 10, 26, 10, m)))
    }
    const page = await statusPage(now)
    const api = page.components.find((c) => c.key === 'api')!
    expect(api.days).toHaveLength(STATUS_DAYS)
    const today = api.days[api.days.length - 1]
    expect(today).toEqual({ day: '2026-11-26', uptime: 0.75, worst: 'down' })
    expect(api.days[api.days.length - 2].uptime).toBeNull() // before tracking began: no data, not downtime
    expect(api.uptime).toBe(0.75)
    expect(api.state).toBe('up')
    expect(page.since).toBe('2026-11-26T10:00:00.000Z')
  })

  it("shows a component's latest state, and unknown once its checks go stale", async () => {
    const now = new Date('2026-11-26T12:00:30Z')
    await recordCheck('decentraland', 'up', null, new Date('2026-11-26T11:50:00Z'))
    await recordCheck('decentraland', 'degraded', 'Worlds content server unreachable', new Date('2026-11-26T11:59:00Z'))
    let dcl = (await statusPage(now)).components.find((c) => c.key === 'decentraland')!
    expect(dcl).toMatchObject({ state: 'degraded', detail: 'Worlds content server unreachable' })
    expect(dcl.days[dcl.days.length - 1]).toMatchObject({ uptime: 0.75, worst: 'degraded' }) // a degraded minute is half up
    dcl = (await statusPage(new Date('2026-11-26T12:10:00Z'))).components.find((c) => c.key === 'decentraland')!
    expect(dcl.state).toBe('unknown')
  })

  it('purges checks older than the window', async () => {
    const now = new Date('2026-11-26T12:00:00Z')
    await recordCheck('api', 'up', null, new Date(now.getTime() - (STATUS_DAYS + 2) * 24 * 60 * MIN))
    await recordCheck('api', 'up', null, new Date(now.getTime() - MIN))
    await purgeStatus(now)
    expect(await db.select().from(statusChecks)).toHaveLength(1)
  })
})

describe('status routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  it('the page is public; only site admins post, update and delete incidents', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ state: 'up', incidents: [] })
    expect(res.json().components.map((c: any) => c.key)).toEqual(['api', 'decentraland'])

    const admin = await createUser({ role: 'admin' })
    const creator = await createUser()
    const post = (token: string, url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as any, headers: { authorization: `Bearer ${token}` } })
    const body = { title: 'Deploys failing', body: 'We are looking into failed deploys to Worlds.', components: ['decentraland'] }
    expect((await post(tokenFor(creator), '/api/admin/status/incidents', body)).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/admin/status/incidents', payload: body })).statusCode).toBe(401)
    expect((await post(tokenFor(admin), '/api/admin/status/incidents', { ...body, components: ['nope'] })).statusCode).toBe(400)
    expect((await post(tokenFor(admin), '/api/admin/status/incidents', { ...body, title: '' })).statusCode).toBe(400)
    const created = await post(tokenFor(admin), '/api/admin/status/incidents', body)
    expect(created.statusCode).toBe(201)
    const id = created.json().incident.id

    // An open incident makes the page degraded at once (the cache is cleared on a post)
    let page = (await app.inject({ method: 'GET', url: '/api/status' })).json()
    expect(page.state).toBe('degraded')
    expect(page.incidents[0]).toMatchObject({ id, title: 'Deploys failing', status: 'investigating', resolvedAt: null, updates: [{ status: 'investigating' }] })

    expect((await post(tokenFor(admin), `/api/admin/status/incidents/${id}/updates`, { status: 'sideways', body: 'x' })).statusCode).toBe(400)
    expect((await post(tokenFor(admin), `/api/admin/status/incidents/${id}/updates`, { status: 'resolved', body: 'Fixed.' })).statusCode).toBe(201)
    page = (await app.inject({ method: 'GET', url: '/api/status' })).json()
    expect(page.state).toBe('up')
    expect(page.incidents[0].updates.map((u: any) => u.status)).toEqual(['resolved', 'investigating'])
    expect(page.incidents[0].resolvedAt).not.toBeNull()

    expect((await post(tokenFor(admin), `/api/admin/status/incidents/00000000-0000-0000-0000-000000000000/updates`, { status: 'resolved', body: 'x' })).statusCode).toBe(404)
    const del = (token: string) => app.inject({ method: 'DELETE', url: `/api/admin/status/incidents/${id}`, headers: { authorization: `Bearer ${token}` } })
    expect((await del(tokenFor(creator))).statusCode).toBe(403)
    expect((await del(tokenFor(admin))).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json().incidents).toEqual([])
  })

  it('a planned maintenance notice does not mark the page degraded', async () => {
    const admin = await createUser({ role: 'admin' })
    await app.inject({ method: 'POST', url: '/api/admin/status/incidents', headers: { authorization: `Bearer ${tokenFor(admin)}` }, payload: { title: 'Database upgrade', body: 'Short downtime at 02:00 UTC.', kind: 'maintenance', status: 'identified' } })
    const page = (await app.inject({ method: 'GET', url: '/api/status' })).json()
    expect(page.state).toBe('up')
    expect(page.incidents[0].kind).toBe('maintenance')
  })
})
