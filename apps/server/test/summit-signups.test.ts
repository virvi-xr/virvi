import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { summitSignups } from '../src/db/schema.js'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('Virvi Summit sign-ups', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(async () => { await app.close() })

  const submit = (payload: unknown, a = app, remoteAddress = '203.0.113.9') =>
    a.inject({ method: 'POST', url: '/api/summit/signups', payload: payload as any, remoteAddress })
  const rows = () => db.select().from(summitSignups)
  const base = { email: 'ana@example.com', name: 'Ana', consent: true }
  const asAdmin = async () => `Bearer ${tokenFor(await createUser({ role: 'admin' }))}`

  it('stores an online sign-up with its interests, ref and consent time', async () => {
    const res = await submit({ ...base, email: ' Ana@Example.COM ', name: '  Ana  ', joinAs: 'online', interests: ['beat', 'drops', 'studio', 'ar', 'drops'], ref: 'Discord_1' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ ok: true })
    const [row] = await rows()
    expect(row).toMatchObject({
      email: 'ana@example.com', name: 'Ana', joinAs: 'online', partySize: null, city: null, expectedGuests: null,
      interests: ['studio', 'ar', 'drops', 'beat'], source: 'discord_1', inPersonStatus: null,
    })
    expect(Math.abs(row.consentAt.getTime() - Date.now())).toBeLessThan(5000)
  })

  it('an in-person sign-up is a request for 1 by default, or the party size given', async () => {
    await submit({ ...base, joinAs: 'in_person' })
    await submit({ ...base, email: 'bo@example.com', joinAs: 'in_person', partySize: 3 })
    const all = await rows()
    expect(all.find((r) => r.email === 'ana@example.com')).toMatchObject({ partySize: 1, inPersonStatus: 'requested', city: null })
    expect(all.find((r) => r.email === 'bo@example.com')).toMatchObject({ partySize: 3, inPersonStatus: 'requested' })
  })

  it('a watch party keeps its city and expected guests, which are optional', async () => {
    await submit({ ...base, joinAs: 'watch_party', city: ' Lisbon ', expectedGuests: 40, partySize: 2 })
    await submit({ ...base, email: 'bo@example.com', joinAs: 'watch_party', city: 'Tokyo' })
    const all = await rows()
    expect(all.find((r) => r.email === 'ana@example.com')).toMatchObject({ city: 'Lisbon', expectedGuests: 40, partySize: null, inPersonStatus: null })
    expect(all.find((r) => r.email === 'bo@example.com')).toMatchObject({ city: 'Tokyo', expectedGuests: null })
  })

  it('ignores a ref outside [a-z0-9_-]{1,40}', async () => {
    await submit({ ...base, joinAs: 'online', ref: 'bad ref!' })
    await submit({ ...base, email: 'bo@example.com', joinAs: 'online', ref: 'x'.repeat(41) })
    expect((await rows()).map((r) => r.source)).toEqual([null, null])
  })

  it('rejects bad input with a code, storing nothing', async () => {
    const cases: [unknown, string][] = [
      [{ ...base, email: undefined, joinAs: 'online' }, 'invalid_email'],
      [{ ...base, email: 'nope', joinAs: 'online' }, 'invalid_email'],
      [{ ...base, email: `${'a'.repeat(243)}@example.com`, joinAs: 'online' }, 'invalid_email'],
      [{ ...base, name: '   ', joinAs: 'online' }, 'name_required'],
      [{ ...base, name: undefined, joinAs: 'online' }, 'name_required'],
      [{ ...base, name: 'n'.repeat(201), joinAs: 'online' }, 'too_long'],
      [{ ...base }, 'invalid_join_as'],
      [{ ...base, joinAs: 'carrier_pigeon' }, 'invalid_join_as'],
      [{ ...base, joinAs: 'in_person', partySize: 0 }, 'invalid_party_size'],
      [{ ...base, joinAs: 'in_person', partySize: 5 }, 'invalid_party_size'],
      [{ ...base, joinAs: 'in_person', partySize: 1.5 }, 'invalid_party_size'],
      [{ ...base, joinAs: 'in_person', partySize: '2' }, 'invalid_party_size'],
      [{ ...base, joinAs: 'watch_party' }, 'city_required'],
      [{ ...base, joinAs: 'watch_party', city: '  ' }, 'city_required'],
      [{ ...base, joinAs: 'watch_party', city: 'c'.repeat(201) }, 'too_long'],
      [{ ...base, joinAs: 'watch_party', city: 'Lisbon', expectedGuests: 0 }, 'invalid_guests'],
      [{ ...base, joinAs: 'watch_party', city: 'Lisbon', expectedGuests: 501 }, 'invalid_guests'],
      [{ ...base, joinAs: 'watch_party', city: 'Lisbon', expectedGuests: 12.5 }, 'invalid_guests'],
      [{ ...base, joinAs: 'online', interests: ['studio', 'karaoke'] }, 'invalid_interest'],
      [{ ...base, joinAs: 'online', interests: 'studio' }, 'invalid_interest'],
      [{ ...base, joinAs: 'online', interests: ['os'] }, 'invalid_interest'], // Virvi OS is not part of the Summit
      [{ ...base, joinAs: 'online', consent: false }, 'consent_required'],
      [{ ...base, joinAs: 'online', consent: undefined }, 'consent_required'],
    ]
    for (const [body, error] of cases) {
      const res = await submit(body)
      expect(res.statusCode, JSON.stringify(body).slice(0, 90)).toBe(400)
      expect(res.json().error, JSON.stringify(body).slice(0, 90)).toBe(error)
    }
    expect(await rows()).toHaveLength(0)
  })

  it('honeypot answers success and stores nothing', async () => {
    const res = await submit({ ...base, joinAs: 'online', nickname: 'bot' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ ok: true })
    expect(await rows()).toHaveLength(0)
  })

  it('a resubmit updates the same row, replacing the answers', async () => {
    await submit({ ...base, joinAs: 'watch_party', city: 'Lisbon', expectedGuests: 30, interests: ['ar'], ref: 'x' })
    const res = await submit({ ...base, email: 'ANA@example.com', name: 'Ana B', joinAs: 'online', interests: ['beat'] })
    expect(res.statusCode).toBe(201)
    const all = await rows()
    expect(all).toHaveLength(1)
    // No ref this time keeps where they first came from
    expect(all[0]).toMatchObject({ name: 'Ana B', joinAs: 'online', city: null, expectedGuests: null, interests: ['beat'], source: 'x' })
    expect(all[0].updatedAt.getTime()).toBeGreaterThan(all[0].createdAt.getTime())
  })

  it('in-person status: switching to in person requests, a confirmed place stays confirmed, switching away clears it', async () => {
    const status = async () => (await rows())[0].inPersonStatus
    await submit({ ...base, joinAs: 'online' })
    expect(await status()).toBeNull()
    await submit({ ...base, joinAs: 'in_person', partySize: 2 })
    expect(await status()).toBe('requested')
    await db.update(summitSignups).set({ inPersonStatus: 'confirmed' })
    await submit({ ...base, joinAs: 'in_person', partySize: 3 })
    expect(await status()).toBe('confirmed')
    expect((await rows())[0].partySize).toBe(3)
    await db.update(summitSignups).set({ inPersonStatus: 'declined' })
    await submit({ ...base, joinAs: 'in_person' })
    expect(await status()).toBe('requested')
    await submit({ ...base, joinAs: 'watch_party', city: 'Orlando' })
    expect(await status()).toBeNull()
    expect((await rows())[0].partySize).toBeNull()
  })

  it('rate limits a sixth sign-up per IP per hour', async () => {
    const limited = await buildApp({ logger: false, backfill: false })
    await limited.ready()
    try {
      for (let i = 0; i < 5; i++) expect((await submit({ ...base, email: `a${i}@example.com`, joinAs: 'online' }, limited)).statusCode).toBe(201)
      expect((await submit({ ...base, email: 'a5@example.com', joinAs: 'online' }, limited)).statusCode).toBe(429)
    } finally {
      await limited.close()
    }
  })

  it('admin lists sign-ups newest first, with totals', async () => {
    await submit({ ...base, email: 'a@example.com', joinAs: 'online', interests: ['studio', 'drops'], ref: 'discord' })
    await submit({ ...base, email: 'b@example.com', joinAs: 'in_person', partySize: 3, interests: ['drops'], ref: 'discord' })
    await submit({ ...base, email: 'c@example.com', joinAs: 'in_person', partySize: 2 })
    await submit({ ...base, email: 'd@example.com', joinAs: 'in_person', partySize: 4, ref: 'x' })
    await submit({ ...base, email: 'e@example.com', joinAs: 'watch_party', city: 'Lisbon', expectedGuests: 20 })
    await db.update(summitSignups).set({ inPersonStatus: 'confirmed' }).where(eq(summitSignups.email, 'c@example.com'))
    await db.update(summitSignups).set({ inPersonStatus: 'declined' }).where(eq(summitSignups.email, 'd@example.com'))

    const res = await app.inject({ method: 'GET', url: '/api/admin/summit/signups', headers: { authorization: await asAdmin() } })
    expect(res.statusCode).toBe(200)
    const { signups, totals } = res.json()
    expect(signups.map((s: { email: string }) => s.email)).toEqual(['e@example.com', 'd@example.com', 'c@example.com', 'b@example.com', 'a@example.com'])
    expect(Object.keys(signups[0]).sort()).toEqual([
      'city', 'consentAt', 'createdAt', 'email', 'expectedGuests', 'id', 'inPersonStatus', 'interests', 'joinAs', 'name', 'partySize', 'source', 'updatedAt',
    ])
    expect(signups[0]).toMatchObject({ joinAs: 'watch_party', city: 'Lisbon', expectedGuests: 20, source: null })
    expect(signups[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(totals).toEqual({
      byJoinAs: { online: 1, in_person: 3, watch_party: 1 },
      byInterest: { studio: 1, sync: 0, ar: 0, events: 0, drops: 2, beat: 0, cities: 0 },
      bySource: { discord: 2, x: 1, '(direct)': 2 },
      inPersonPeople: 5, // 3 requested + 2 confirmed; the declined 4 don't count
    })
  })

  it('admin sets an in-person place to confirmed, declined or back to requested', async () => {
    await submit({ ...base, joinAs: 'in_person', partySize: 2 })
    const [row] = await rows()
    const auth = await asAdmin()
    const put = (id: string, payload: unknown) =>
      app.inject({ method: 'PUT', url: `/api/admin/summit/signups/${id}/in-person`, headers: { authorization: auth }, payload: payload as any })

    for (const status of ['confirmed', 'declined', 'requested'] as const) {
      const res = await put(row.id, { status })
      expect(res.statusCode, status).toBe(200)
      expect(res.json().signup).toMatchObject({ id: row.id, inPersonStatus: status })
      expect((await rows())[0].inPersonStatus).toBe(status)
    }
    expect((await put(row.id, { status: 'maybe' })).json()).toEqual({ error: 'invalid_status' })
    expect((await put(row.id, {})).statusCode).toBe(400)
    expect((await put('00000000-0000-4000-8000-000000000009', { status: 'confirmed' })).statusCode).toBe(404)
    expect((await put('not-a-uuid', { status: 'confirmed' })).statusCode).toBe(404)

    await submit({ ...base, email: 'online@example.com', joinAs: 'online' })
    const online = (await rows()).find((r) => r.email === 'online@example.com')!
    const res = await put(online.id, { status: 'confirmed' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'not_in_person' })
    expect((await rows()).find((r) => r.id === online.id)!.inPersonStatus).toBeNull()
  })

  it('non-admins get 403, anonymous gets 401, on both admin routes', async () => {
    const creator = await createUser({ role: 'creator' })
    const headers = { authorization: `Bearer ${tokenFor(creator)}` }
    const id = '00000000-0000-4000-8000-000000000009'
    const routes = [
      { method: 'GET' as const, url: '/api/admin/summit/signups' },
      { method: 'PUT' as const, url: `/api/admin/summit/signups/${id}/in-person`, payload: { status: 'confirmed' } },
    ]
    for (const r of routes) {
      expect((await app.inject({ ...r, headers })).statusCode, r.url).toBe(403)
      expect((await app.inject(r)).statusCode, r.url).toBe(401)
    }
  })
})
