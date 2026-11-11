import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { ClientErrorEvent } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { errorSignatures, errorEvents, errorHourly, errorHourlyDims, errorHourlyUsers, errorIpKeys, errorBudget } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { clientRecord, writeRecords, resetErrorBuffer, recordServerResponse, recordJobFailure, flushErrors, type ClientContext } from '../src/errors/record.js'
import { ERROR_BUDGETS, ipKey, resetErrorBudgets, takeNewSignature, registerRelease } from '../src/errors/limits.js'
import { errorIpHash } from '../src/errors/user-hash.js'
import { purgeErrors } from '../src/errors/retention.js'
import { resetDb } from './helpers/db.js'

const DAY = 86_400_000
const exception = (message: string, over: Partial<ClientErrorEvent> = {}): ClientErrorEvent => ({ kind: 'exception', t: Date.now(), route: '/x', errorType: 'E', message, ...over })
const ctx = (ip: string, over: Partial<ClientContext> = {}): ClientContext => ({
  release: null, browser: 'Chrome 131', os: 'macOS', userHash: null, orgId: null, ipKey: ipKey(ip), ipHash: `ip:${ipKey(ip)}`, ...over,
})
const msgs = Array.from({ length: 20 }, (_, i) => `boom ${'abcdefghijklmnopqrst'[i]}`)
const count = async (table: string) => Number(((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))) as unknown as Array<{ n: number }>)[0].n)
/** A server restart: every in-memory budget and cache starts again. */
const restart = () => { resetErrorBuffer(); resetErrorBudgets() }

describe('database-backed daily budgets (C1b)', () => {
  const saved = JSON.parse(JSON.stringify(ERROR_BUDGETS))
  beforeEach(async () => { await resetDb(); restart() })
  afterEach(() => { Object.assign(ERROR_BUDGETS, JSON.parse(JSON.stringify(saved))); restart() })

  it('the probe: one address varying release, route and browser on known signatures stays small', async () => {
    await writeRecords(msgs.map((m) => clientRecord(exception(m), ctx('198.51.100.9'))))
    let k = 1
    for (let r = 0; r < 60; r++) {
      await writeRecords(msgs.map((m) => {
        k++
        return clientRecord(exception(m, { route: `/p${k}/a${k}`, repeat: true }), ctx('198.51.100.9', { release: (0x1000000 + k).toString(16), browser: `Chrome ${k}`, ipHash: `ip:x${k}` }))
      }))
    }
    const dims = await db.select().from(errorHourlyDims)
    // per signature-hour: one release value (unknown ones fold), at most 10 routes and 10 browsers (+ "other"), one OS
    expect(dims.length).toBeLessThanOrEqual(msgs.length * (1 + (ERROR_BUDGETS.maxDimValuesPerSignatureHour + 1) * 2 + 1))
    expect(new Set(dims.filter((d) => d.dim === 'release').map((d) => d.value))).toEqual(new Set(['unknown']))
    expect(dims.filter((d) => d.dim === 'browser').every((d) => /^(Chrome (\d{1,3}|other)|other)$/.test(d.value))).toBe(true)
    // and the address touched at most its signature-hours for the day
    const ipRows = (await db.select().from(errorHourlyUsers)).filter((u) => u.userHash.startsWith('ip:'))
    expect(ipRows.length).toBeLessThanOrEqual(msgs.length * 61)
  }, 60_000)

  it('the global daily row budgets hold across restarts and instances', async () => {
    ERROR_BUDGETS.db = { ...ERROR_BUDGETS.db, dims: 30, events: 2, hourly: 3 }
    for (let round = 0; round < 3; round++) {
      restart()
      await writeRecords(msgs.slice(0, 6).map((m, i) => clientRecord(exception(`${m} r${'xyz'[round]}`, { route: `/r${round}${i}` }), ctx(`198.51.100.${round * 10 + i}`))))
    }
    expect(await count('error_hourly_dims')).toBeLessThanOrEqual(30)
    expect(await count('error_events')).toBeLessThanOrEqual(2)
    // past the hourly budget, new signature-hours are counted in the overflow signature only
    const sigHours = (await db.execute(sql`SELECT count(*)::int AS n FROM error_hourly h JOIN error_signatures s ON s.id = h.signature_id WHERE s.expected IS DISTINCT FROM 'overflow'`)) as unknown as Array<{ n: number }>
    expect(Number(sigHours[0].n)).toBeLessThanOrEqual(3)
    const overflow = await db.select().from(errorSignatures).where(eq(errorSignatures.expected, 'overflow'))
    expect(overflow.reduce((n, s) => n + Number(s.totalCount), 0)).toBeGreaterThan(0)
    expect((await db.select().from(errorBudget)).map((b) => b.key).sort()).toEqual(expect.arrayContaining(['dims', 'events', 'hourly']))
  })

  it('caps the signature-hours one address touches a day, across restarts', async () => {
    ERROR_BUDGETS.signatureHoursPerIpDay = 3
    await writeRecords(msgs.slice(0, 5).map((m) => clientRecord(exception(m), ctx('198.51.100.50'))))
    restart()
    await writeRecords(msgs.slice(5, 10).map((m) => clientRecord(exception(m), ctx('198.51.100.50'))))
    const real = (await db.select().from(errorSignatures)).filter((s) => s.expected !== 'overflow')
    expect(real.length).toBe(3)
    expect((await db.select().from(errorSignatures)).find((s) => s.expected === 'overflow')?.totalCount).toBe(7)
    // another address is unaffected
    await writeRecords([clientRecord(exception(msgs[0]), ctx('198.51.100.51'))])
    expect((await db.select().from(errorHourlyUsers)).filter((u) => u.userHash === 'ip:198.51.100.51')).toHaveLength(1)
  })

  it('a browser release counts only if the server has run it; config.release always does, even if it is not hex (N5)', async () => {
    await registerRelease('abc1234')
    await writeRecords([
      clientRecord(exception('a'), ctx('198.51.100.1', { release: 'abc1234' })),
      clientRecord(exception('b'), ctx('198.51.100.1', { release: 'deadbee' })),
    ])
    const rel = (await db.select().from(errorHourlyDims)).filter((d) => d.dim === 'release').map((d) => d.value).sort()
    expect(rel).toEqual(['abc1234', 'unknown'])
    const prev = config.release
    ;(config as any).release = 'v2.1'
    try {
      restart()
      await writeRecords([clientRecord(exception('c'), ctx('198.51.100.1', { release: 'v2.1' }))])
      const [c] = await db.select().from(errorSignatures).where(eq(errorSignatures.message, 'c'))
      expect(c.firstRelease).toBe('v2.1')
    } finally {
      ;(config as any).release = prev
    }
  })

  it('bounds the in-memory map of breakdown values', async () => {
    ERROR_BUDGETS.maxDimKeysInMemory = 4
    await writeRecords(msgs.slice(0, 6).map((m) => clientRecord(exception(m, { route: '/only' }), ctx('198.51.100.1'))))
    const routes = (await db.select().from(errorHourlyDims)).filter((d) => d.dim === 'route')
    expect(routes.some((r) => r.value === 'other')).toBe(true)
  })
})

describe('the distinct-signature cap (N1)', () => {
  const saved = JSON.parse(JSON.stringify(ERROR_BUDGETS))
  beforeEach(async () => { await resetDb(); restart() })
  afterEach(() => { Object.assign(ERROR_BUDGETS, JSON.parse(JSON.stringify(saved))); restart() })

  it('counts only signatures seen in the last 30 days', async () => {
    ERROR_BUDGETS.maxSignatures = 4 // anonymous browsers may fill 2
    await writeRecords(msgs.slice(0, 2).map((m) => clientRecord(exception(m), ctx('198.51.100.1'))))
    await db.update(errorSignatures).set({ lastSeenAt: new Date(Date.now() - 40 * DAY) })
    restart()
    await writeRecords([clientRecord(exception(msgs[2]), ctx('198.51.100.2'))])
    expect((await db.select().from(errorSignatures)).filter((s) => s.expected === 'overflow')).toHaveLength(0)
  })

  it('never folds a server-side error into overflow', async () => {
    ERROR_BUDGETS.maxSignatures = 2 // anonymous browsers may fill 1, and do
    await writeRecords([clientRecord(exception(msgs[0]), ctx('198.51.100.1'))])
    recordServerResponse({ status: 500, method: 'GET', routeTemplate: '/api/a' }, new Error('x'))
    recordServerResponse({ status: 503, method: 'GET', routeTemplate: '/api/b' })
    await flushErrors()
    const sigs = (await db.select().from(errorSignatures)).map((s) => s.signature).sort()
    expect(sigs).toEqual(['exception E: boom a', 'server_5xx 500 GET /api/a', 'server_5xx 503 GET /api/b'])
  })

  it('anonymous-only, never-filed browser signatures go after 30 quiet days; ones with users, reports or issues stay', async () => {
    const now = new Date()
    const old = new Date(now.getTime() - 31 * DAY)
    await writeRecords(msgs.slice(0, 4).map((m) => clientRecord(exception(m), ctx('198.51.100.1'))))
    await writeRecords([clientRecord(exception(msgs[4]), ctx('198.51.100.1', { userHash: 'u'.repeat(32) }))])
    await db.update(errorSignatures).set({ lastSeenAt: old })
    const [a, b, c] = (await db.select().from(errorSignatures)).filter((s) => s.message !== msgs[4]).sort((x, y) => x.message!.localeCompare(y.message!))
    await db.update(errorSignatures).set({ userReports: 1 }).where(eq(errorSignatures.id, b.id))
    await db.update(errorSignatures).set({ linearIssueId: 'x' }).where(eq(errorSignatures.id, c.id))
    recordServerResponse({ status: 500, method: 'GET', routeTemplate: '/api/old' })
    await flushErrors()
    await db.update(errorSignatures).set({ lastSeenAt: old }).where(eq(errorSignatures.source, 'server'))
    await purgeErrors(now)
    const left = (await db.select().from(errorSignatures)).map((s) => s.id)
    expect(left).not.toContain(a.id)
    expect(left).toEqual(expect.arrayContaining([b.id, c.id]))
    expect((await db.select().from(errorSignatures)).some((s) => s.message === msgs[4])).toBe(true)
    expect((await db.select().from(errorSignatures)).some((s) => s.source === 'server')).toBe(true)
  })
})

describe('address hashes use a random key per day, gone after 2 days (b)', () => {
  beforeEach(async () => { await resetDb(); restart() })

  it('same within a day, different across days, and the key is stored, then deleted', async () => {
    const d0 = new Date('2026-11-08T12:00:00Z')
    const d1 = new Date('2026-11-09T12:00:00Z')
    expect(await errorIpHash('198.51.100.1', d0)).toBe(await errorIpHash('198.51.100.1', d0))
    expect(await errorIpHash('198.51.100.1', d0)).not.toBe(await errorIpHash('198.51.100.1', d1))
    expect(await errorIpHash('198.51.100.1', d0)).toMatch(/^ip:[0-9a-f]{20}$/)
    expect((await db.select().from(errorIpKeys)).map((k) => k.day).sort()).toEqual(['2026-11-08', '2026-11-09'])
    restart() // another instance reads the same key
    const a = await errorIpHash('198.51.100.1', d0)
    restart()
    expect(await errorIpHash('198.51.100.1', d0)).toBe(a)
    await purgeErrors(new Date('2026-11-11T12:00:00Z'))
    expect(await db.select().from(errorIpKeys)).toHaveLength(0)
  })

  it('address rows go after 2 days, user rows after 30, breakdowns after 30', async () => {
    const now = new Date()
    await writeRecords([clientRecord(exception('a'), ctx('198.51.100.1', { userHash: 'u'.repeat(32) }), new Date(now.getTime() - 3 * DAY))])
    await writeRecords([clientRecord(exception('a'), ctx('198.51.100.2'), new Date(now.getTime() - 31 * DAY))])
    await purgeErrors(now)
    const rows = (await db.select().from(errorHourlyUsers)).map((u) => u.userHash)
    expect(rows).toEqual(['u'.repeat(32)])
    const dims = await db.select().from(errorHourlyDims)
    expect(dims.every((d) => d.hour.getTime() > now.getTime() - 30 * DAY)).toBe(true)
    expect(await db.select().from(errorHourly)).toHaveLength(2) // hourly counts are kept
    expect(await db.select().from(errorEvents)).toHaveLength(1)
  })
})

describe('rate-limit keys (N2)', () => {
  const saved = ERROR_BUDGETS.maxTrackedKeys
  afterEach(() => { ERROR_BUDGETS.maxTrackedKeys = saved; resetErrorBudgets() })
  it('a full key map lets a new address in (the oldest key goes), rather than refusing it', () => {
    ERROR_BUDGETS.maxTrackedKeys = 3
    resetErrorBudgets()
    for (const ip of ['a', 'b', 'c', 'd', 'e']) expect(takeNewSignature(ip), ip).toBe(true)
  })
})

describe('anonymous traffic can only use part of each budget (R2-1)', () => {
  const saved = JSON.parse(JSON.stringify(ERROR_BUDGETS))
  beforeEach(async () => { await resetDb(); restart() })
  afterEach(() => { Object.assign(ERROR_BUDGETS, JSON.parse(JSON.stringify(saved))); restart() })
  const user = 'a'.repeat(32)

  it('the starve probe: anonymous traffic used its share; a signed-in user’s new crash still gets its signature, event and count', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const anon = (k: keyof typeof ERROR_BUDGETS.db) => Math.floor(ERROR_BUDGETS.db[k] * 0.6)
    for (const k of ['hourly', 'events', 'dims', 'users'] as const) {
      await db.execute(sql`INSERT INTO error_budget (day, key, n) VALUES (${day}::date, ${k}, ${anon(k)}), (${day}::date, ${`anon:${k}`}, ${anon(k)})`)
    }
    // anonymous: nothing more
    await writeRecords([clientRecord(exception('attacker noise'), ctx('203.0.113.9'))])
    expect((await db.select().from(errorSignatures)).map((s) => s.signature)).toEqual(['overflow exception'])
    // signed in: still recorded in full
    await writeRecords([clientRecord({ kind: 'crash', t: Date.now(), route: '/x', errorType: 'TypeError', message: 'real bug in save' }, ctx('203.0.113.5', { userHash: user }))])
    const [real] = await db.select().from(errorSignatures).where(eq(errorSignatures.kind, 'crash'))
    expect(real.signature).toBe('crash TypeError: real bug in save')
    expect(await db.select().from(errorEvents).where(eq(errorEvents.signatureId, real.id))).toHaveLength(1)
    const [hour] = await db.select().from(errorHourly).where(eq(errorHourly.signatureId, real.id))
    expect(Number(hour.users)).toBe(1)
    expect((await db.select().from(errorHourlyDims).where(eq(errorHourlyDims.signatureId, real.id))).length).toBeGreaterThan(0)
  })

  it('anonymous use stops at 60% of a budget', async () => {
    ERROR_BUDGETS.db = { ...ERROR_BUDGETS.db, hourly: 10 }
    ERROR_BUDGETS.signatureHoursPerIpDay = 100
    for (let i = 0; i < 4; i++) await writeRecords(msgs.slice(i * 4, i * 4 + 4).map((m) => clientRecord(exception(m), ctx(`198.51.100.${i + 1}`))))
    const real = (await db.select().from(errorSignatures)).filter((s) => s.expected !== 'overflow')
    expect(real).toHaveLength(6)
    // users can use the rest
    await writeRecords(msgs.slice(16, 20).map((m) => clientRecord(exception(m), ctx('198.51.100.9', { userHash: user }))))
    expect((await db.select().from(errorSignatures)).filter((s) => s.expected !== 'overflow')).toHaveLength(10)
  })

  it('anonymous browsers can fill only 60% of the distinct-signature cap', async () => {
    ERROR_BUDGETS.maxSignatures = 5
    await writeRecords(msgs.slice(0, 5).map((m, i) => clientRecord(exception(m), ctx(`198.51.100.${i + 1}`))))
    expect((await db.select().from(errorSignatures)).filter((s) => s.expected !== 'overflow')).toHaveLength(3)
    await writeRecords([clientRecord(exception(msgs[10]), ctx('198.51.100.9', { userHash: user }))])
    expect((await db.select().from(errorSignatures)).filter((s) => s.expected !== 'overflow')).toHaveLength(4)
  })

  it('server-side errors are never blocked by the browser budgets', async () => {
    const day = new Date().toISOString().slice(0, 10)
    for (const k of ['hourly', 'events', 'dims', 'users'] as const) {
      await db.execute(sql`INSERT INTO error_budget (day, key, n) VALUES (${day}::date, ${k}, ${ERROR_BUDGETS.db[k]}), (${day}::date, ${`anon:${k}`}, ${ERROR_BUDGETS.db[k]})`)
    }
    recordServerResponse({ status: 500, method: 'GET', routeTemplate: '/api/a' }, new Error('db down'))
    await flushErrors()
    const [s] = await db.select().from(errorSignatures)
    expect(s.signature).toBe('server_5xx 500 GET /api/a')
    expect(await db.select().from(errorEvents)).toHaveLength(1)
    expect(await db.select().from(errorHourly)).toHaveLength(1)
  })
})

describe('per-user limits (R3-1)', () => {
  const saved = JSON.parse(JSON.stringify(ERROR_BUDGETS))
  beforeEach(async () => { await resetDb(); restart() })
  afterEach(() => { Object.assign(ERROR_BUDGETS, JSON.parse(JSON.stringify(saved))); restart() })
  const real = async () => (await db.select().from(errorSignatures)).filter((s) => s.expected !== 'overflow')
  const junk = (r: number, i: number) => `junk ${String.fromCharCode(97 + (r % 26))}${String.fromCharCode(97 + i)} q${'abcdefghijklmnop'[r]}`

  it('the trial probe: one signed-in user floods new errors; another user’s new crash still gets its signature, event and count', async () => {
    for (const trial of [true, false]) {
      await resetDb(); restart()
      const atk = ctx('198.51.100.66', { userHash: 'attackertrial'.padEnd(32, '0'), trial })
      for (let r = 0; r < 16; r++) await writeRecords(Array.from({ length: 20 }, (_, i) => clientRecord(exception(junk(r, i)), atk)))
      // the flooder got only a user's share
      expect((await real()).length).toBeLessThanOrEqual(ERROR_BUDGETS.perUser.newSignaturesPerHour)
      await writeRecords([clientRecord({ kind: 'crash', t: Date.now(), route: '/y', errorType: 'TypeError', message: 'real bug in save' }, ctx('203.0.113.9', { userHash: 'b'.repeat(32) }))])
      const [legit] = await db.select().from(errorSignatures).where(eq(errorSignatures.kind, 'crash'))
      expect(legit?.signature).toBe('crash TypeError: real bug in save')
      expect(await db.select().from(errorEvents).where(eq(errorEvents.signatureId, legit.id))).toHaveLength(1)
      const [hour] = await db.select().from(errorHourly).where(eq(errorHourly.signatureId, legit.id))
      expect(Number(hour.users)).toBe(1)
    }
  })

  it('a user’s new signatures are capped an hour in memory and a day in the database, whatever address they use', async () => {
    ERROR_BUDGETS.perUser = { ...ERROR_BUDGETS.perUser, newSignaturesPerHour: 3, newSignaturesPerDay: 5 }
    const u = { userHash: 'c'.repeat(32) }
    await writeRecords(msgs.slice(0, 4).map((m, i) => clientRecord(exception(m), ctx(`198.51.100.${i + 1}`, u))))
    expect(await real()).toHaveLength(3)
    restart() // a new instance: its hourly memory is empty, the day's count is in the database
    await writeRecords(msgs.slice(4, 8).map((m, i) => clientRecord(exception(m), ctx(`198.51.101.${i + 1}`, u))))
    expect(await real()).toHaveLength(5)
    // someone else is unaffected
    await writeRecords([clientRecord(exception(msgs[9]), ctx('198.51.102.1', { userHash: 'd'.repeat(32) }))])
    expect(await real()).toHaveLength(6)
  })

  it('an address’s caps hold for signed-in users too: many accounts on one address share them', async () => {
    ERROR_BUDGETS.newSignaturesPerIpHour = 3
    await writeRecords(msgs.slice(0, 6).map((m, i) => clientRecord(exception(m), ctx('198.51.100.7', { userHash: String(i).repeat(32) }))))
    expect(await real()).toHaveLength(3)
    ERROR_BUDGETS.newSignaturesPerIpHour = 100
    ERROR_BUDGETS.signatureHoursPerIpDay = 4
    await writeRecords(msgs.slice(6, 12).map((m, i) => clientRecord(exception(m), ctx('198.51.100.8', { userHash: String(i).repeat(32) }))))
    expect(await real()).toHaveLength(7)
  })

  it('caps the signature-hours and stored events one user makes a day, across restarts', async () => {
    ERROR_BUDGETS.perUser = { ...ERROR_BUDGETS.perUser, signatureHoursPerDay: 4, storedEventsPerDay: 2 }
    const u = (ip: string) => ctx(ip, { userHash: 'e'.repeat(32) })
    await writeRecords(msgs.slice(0, 3).map((m, i) => clientRecord(exception(m), u(`198.51.100.${i + 1}`))))
    expect(await count('error_events')).toBe(2)
    restart()
    await writeRecords(msgs.slice(3, 6).map((m, i) => clientRecord(exception(m), u(`198.51.101.${i + 1}`))))
    expect(await real()).toHaveLength(4)
    expect(await count('error_events')).toBe(2)
    // known signature-hours it already touched still count
    await writeRecords([clientRecord(exception(msgs[0]), u('198.51.102.1'))])
    const [s] = (await real()).filter((x) => x.signature.endsWith(msgs[0]))
    expect(Number(s.totalCount)).toBe(2)
  })

  it('a trial counts as anonymous for the reserve; only an account reaches the last 40%', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const anon = (k: keyof typeof ERROR_BUDGETS.db) => Math.floor(ERROR_BUDGETS.db[k] * 0.6)
    for (const k of ['hourly', 'events', 'dims', 'users'] as const) {
      await db.execute(sql`INSERT INTO error_budget (day, key, n) VALUES (${day}::date, ${k}, ${anon(k)}), (${day}::date, ${`anon:${k}`}, ${anon(k)})`)
    }
    await writeRecords([clientRecord(exception('trial bug'), ctx('203.0.113.9', { userHash: 'f'.repeat(32), trial: true }))])
    expect((await db.select().from(errorSignatures)).map((s) => s.signature)).toEqual(['overflow exception'])
    await writeRecords([clientRecord(exception('account bug'), ctx('203.0.113.10', { userHash: 'a'.repeat(32) }))])
    expect((await real()).map((s) => s.signature)).toEqual(['exception E: account bug'])
  })

  it('a trial’s signatures stay in the anonymous share of the signature cap', async () => {
    ERROR_BUDGETS.maxSignatures = 5
    await writeRecords(msgs.slice(0, 5).map((m, i) => clientRecord(exception(m), ctx(`198.51.100.${i + 1}`, { userHash: String(i).repeat(32), trial: true }))))
    expect(await real()).toHaveLength(3)
    restart() // the count is read again from the database
    await writeRecords([clientRecord(exception(msgs[6]), ctx('198.51.100.9', { userHash: '9'.repeat(32), trial: true }))])
    expect(await real()).toHaveLength(3)
    await writeRecords([clientRecord(exception(msgs[7]), ctx('198.51.100.10', { userHash: 'a'.repeat(32) }))])
    expect(await real()).toHaveLength(4)
  })

  it('one user failing jobs with varied text makes few job signatures, and at most a user’s share', async () => {
    // varied names in the message are one signature
    for (let i = 0; i < 30; i++) recordJobFailure('import_start', Object.assign(new Error(`bad_zip: The zip file "scene ${i} by me" is broken`), { name: 'ImportError' }), { owner: 'user-0' })
    await flushErrors()
    expect((await real()).map((s) => s.signature)).toEqual(['job import_start ImportError bad_zip: The zip file <s>'])
    // past the per-user cap, new job signatures from that user fold into overflow; another user's still count
    ERROR_BUDGETS.perUser = { ...ERROR_BUDGETS.perUser, jobSignaturesPerHour: 3, jobSignaturesPerDay: 4 }
    for (let i = 0; i < 6; i++) recordJobFailure('deploy', new Error(`${'abcdef'[i]}word failed here`), { owner: 'user-1' })
    await flushErrors()
    expect((await real()).filter((s) => s.kind === 'job')).toHaveLength(1 + 3)
    restart()
    for (let i = 0; i < 6; i++) recordJobFailure('deploy', new Error(`${'ghijkl'[i]}word failed here`), { owner: 'user-1' })
    await flushErrors()
    expect((await real()).filter((s) => s.kind === 'job')).toHaveLength(1 + 4)
    const [over] = (await db.select().from(errorSignatures)).filter((s) => s.signature === 'overflow job')
    expect(Number(over.totalCount)).toBe(12 - 4)
    recordJobFailure('deploy', new Error('other user failed'), { owner: 'user-2' })
    recordJobFailure('deploy', new Error('no owner failed'))
    await flushErrors()
    expect((await real()).filter((s) => s.kind === 'job')).toHaveLength(1 + 4 + 2)
  })
})

describe('flusher (pile-up)', () => {
  beforeEach(async () => { await resetDb(); restart() })
  it('a tick while a flush runs is skipped, not queued', async () => {
    const { flushTick } = await import('../src/errors/record.js')
    recordServerResponse({ status: 500, method: 'GET', routeTemplate: '/api/a' })
    const running = flushErrors()
    recordServerResponse({ status: 500, method: 'GET', routeTemplate: '/api/a' })
    expect(flushTick()).toBe(false)
    expect(flushTick()).toBe(false)
    await running
    expect(flushTick()).toBe(true)
    await flushErrors()
    const [s] = await db.select().from(errorSignatures)
    expect(Number(s.totalCount)).toBe(2)
  })
})
