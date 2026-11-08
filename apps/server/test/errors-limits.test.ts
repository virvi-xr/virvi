import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ClientErrorEvent } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { errorSignatures, errorEvents, errorHourly, errorHourlyDims, errorReports } from '../src/db/schema.js'
import { buildApp } from '../src/app.js'
import { clientRecord, writeRecords, flushErrors, resetErrorBuffer, type ClientContext } from '../src/errors/record.js'
import { ERROR_BUDGETS, ipKey, resetErrorBudgets } from '../src/errors/limits.js'
import { runFilingPass } from '../src/errors/filing.js'
import { setLinearClient, type LinearClient } from '../src/errors/linear.js'
import { resetDb } from './helpers/db.js'
import { createUser, tokenFor } from './helpers/factories.js'

const crash = (message: string, over: Partial<ClientErrorEvent> = {}): ClientErrorEvent => ({
  kind: 'crash', t: Date.now(), route: '/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab/edit', errorType: 'TypeError', message, ...over,
})
const ctx = (ip: string, over: Partial<ClientContext> = {}): ClientContext => ({
  release: 'abc1234', browser: 'Chrome 131', os: 'macOS', userHash: null, orgId: null, ipKey: ipKey(ip), ipHash: `ip:${ipKey(ip)}`, ...over,
})
const words = (i: number) => `boom ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26) % 26]}`

describe('ipKey', () => {
  it('keys IPv4 by address and IPv6 by its /64', () => {
    expect(ipKey('198.51.100.7')).toBe('198.51.100.7')
    expect(ipKey('::ffff:198.51.100.7')).toBe('198.51.100.7')
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(ipKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64')
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
  })
})

describe('error budgets (C1)', () => {
  const saved = { ...ERROR_BUDGETS }
  beforeEach(async () => { await resetDb(); resetErrorBuffer(); resetErrorBudgets() })
  afterEach(() => { Object.assign(ERROR_BUDGETS, saved); resetErrorBudgets() })

  it('one address gets a few new signatures an hour; the rest fold into a counted overflow signature', async () => {
    const n = ERROR_BUDGETS.newSignaturesPerIpHour + 5
    await writeRecords(Array.from({ length: n }, (_, i) => clientRecord(crash(words(i)), ctx('198.51.100.7'))))
    const sigs = await db.select().from(errorSignatures)
    const overflow = sigs.filter((s) => s.expected === 'overflow')
    expect(sigs.length - overflow.length).toBe(ERROR_BUDGETS.newSignaturesPerIpHour)
    expect(overflow).toHaveLength(1)
    expect(overflow[0]).toMatchObject({ signature: 'overflow crash', totalCount: 5 })
    expect(await db.select().from(errorEvents).where(eq(errorEvents.signatureId, overflow[0].id))).toHaveLength(0)
    // a different address has its own budget; the same /64 shares one
    await writeRecords([clientRecord(crash('other place'), ctx('198.51.100.8'))])
    await writeRecords([clientRecord(crash('same block'), ctx('2001:db8:1:2::1'))])
    await writeRecords([clientRecord(crash('same block too'), ctx('2001:db8:1:2::2'))])
    expect((await db.select().from(errorSignatures)).filter((s) => s.expected !== 'overflow')).toHaveLength(ERROR_BUDGETS.newSignaturesPerIpHour + 3)
  })

  it('past the global cap on distinct signatures, new ones are counted as overflow only', async () => {
    ERROR_BUDGETS.maxSignatures = 5 // anonymous browsers may fill 3 (anonymousShare)
    for (let i = 0; i < 5; i++) await writeRecords([clientRecord(crash(words(i)), ctx(`198.51.100.${i + 1}`))])
    const sigs = await db.select().from(errorSignatures)
    expect(sigs.filter((s) => s.expected !== 'overflow')).toHaveLength(3)
    expect(sigs.find((s) => s.expected === 'overflow')?.totalCount).toBe(2)
    // a known signature still counts and samples
    await writeRecords([clientRecord(crash(words(0)), ctx('198.51.100.9'))])
    expect((await db.select().from(errorSignatures)).find((s) => s.message?.startsWith('boom'))).toBeTruthy()
  })

  it('stores the first occurrence and at most a few full events per signature per day, and per address per day', async () => {
    await writeRecords(Array.from({ length: 12 }, () => clientRecord(crash('same thing'), ctx('198.51.100.7'))))
    await writeRecords(Array.from({ length: 12 }, () => clientRecord(crash('same thing'), ctx('198.51.100.8'))))
    const [sig] = await db.select().from(errorSignatures)
    expect(sig.totalCount).toBe(24)
    expect(await db.select().from(errorEvents)).toHaveLength(ERROR_BUDGETS.storedPerSignatureDay)
    ERROR_BUDGETS.storedEventsPerIpDay = 3
    resetErrorBudgets()
    await writeRecords(Array.from({ length: 6 }, (_, i) => clientRecord(crash(words(i + 40)), ctx('198.51.100.20'))))
    const fromIp = await db.execute(sql`SELECT count(*)::int AS n FROM error_events e JOIN error_signatures s ON s.id = e.signature_id WHERE s.message LIKE 'boom%'`)
    expect((fromIp as unknown as Array<{ n: number }>)[0].n).toBe(3)
  })

  it('keeps each stored event small: long breadcrumbs and stacks are cut to the byte cap', async () => {
    const crumbs = Array.from({ length: 30 }, () => ({ t: 1, type: 'api' as const, method: 'GET', path: '/api/' + 'x'.repeat(290), status: 500, ms: 1 }))
    await writeRecords([clientRecord(crash('big', { stack: 'Error\n' + '    at f (https://virvi.io/a.js:1:1)\n'.repeat(100), breadcrumbs: crumbs }), ctx('198.51.100.7'))])
    const [e] = await db.select().from(errorEvents)
    expect(JSON.stringify(e).length).toBeLessThanOrEqual(ERROR_BUDGETS.maxStoredEventBytes + 1000)
    expect((e.breadcrumbs as unknown[]).length).toBeGreaterThan(0)
  })

  it('templates the route breakdown and caps distinct breakdown values per signature-hour', async () => {
    const recs = Array.from({ length: ERROR_BUDGETS.maxDimValuesPerSignatureHour + 10 }, (_, i) =>
      clientRecord(crash('same', { route: `/x${words(i).replace(' ', '')}` }), ctx('198.51.100.7')))
    recs.push(clientRecord(crash('same', { route: '/scenes/11111111-1d2a-4b3c-9d8e-0123456789ab/edit' }), ctx('198.51.100.7')))
    await writeRecords(recs)
    const routes = (await db.select().from(errorHourlyDims)).filter((d) => d.dim === 'route')
    expect(routes.length).toBeLessThanOrEqual(ERROR_BUDGETS.maxDimValuesPerSignatureHour + 1)
    expect(routes.some((r) => r.value === 'other')).toBe(true)
    expect(routes.some((r) => r.value.includes('11111111'))).toBe(false)
  })

  it('counters are 64-bit, and one bad record never drops the rest of the batch (I3)', async () => {
    const big = { ...clientRecord(crash('huge'), ctx('198.51.100.7')), count: 2_000_000_000 }
    await writeRecords([big])
    await writeRecords([{ ...big }])
    const [hour] = await db.select().from(errorHourly)
    expect(Number(hour.count)).toBe(4_000_000_000)
    const bad = { ...clientRecord(crash('bad one'), ctx('198.51.100.7')), status: 99_999_999_999 } // overflows an integer column
    const badEvent = { ...clientRecord(crash('bad event'), ctx('198.51.100.7')), errorBody: { n: 1n } as unknown } // can't be serialised
    const good = clientRecord(crash('good one'), ctx('198.51.100.7'))
    await writeRecords([bad, badEvent, good])
    const sigs = (await db.select().from(errorSignatures)).map((s) => s.message)
    expect(sigs).toContain('good one')
    expect(sigs).toContain('bad event')
    expect((await db.select().from(errorEvents)).some((e) => e.message === 'good one')).toBe(true)
  })
})

describe('ingest limits by address', () => {
  let app: FastifyInstance
  beforeEach(async () => { resetErrorBuffer(); resetErrorBudgets(); app = await buildApp({ logger: false, backfill: false }); await app.ready() })
  afterEach(async () => { await app.close() })

  it('an IPv6 /64 shares one rate limit', async () => {
    const hit = (ip: string) => app.inject({ method: 'POST', url: '/api/errors', remoteAddress: ip, payload: { v: 1, events: [crash('x')] } })
    let last = 0
    for (let i = 0; i < 61; i++) last = (await hit(`2001:db8:5:6::${(i + 1).toString(16)}`)).statusCode
    expect(last).toBe(429)
    expect((await hit('2001:db8:5:7::1')).statusCode).toBe(202)
  })
})

describe('reports (M2) and client claims (M4)', () => {
  let app: FastifyInstance
  beforeEach(async () => { await resetDb(); resetErrorBuffer(); resetErrorBudgets(); app = await buildApp({ rateLimit: false, logger: false, backfill: false }); await app.ready() })
  afterEach(async () => { await app.close() })

  it('a report never clears "Mark fixed", never counts as a recurrence or an affected user', async () => {
    await writeRecords([clientRecord(crash('fixed bug'), ctx('198.51.100.7'))])
    const resolvedAt = new Date(Date.now() - 1000)
    await db.update(errorSignatures).set({ resolvedAt })
    const [before] = await db.select().from(errorSignatures)
    const u = await createUser()
    const res = await app.inject({ method: 'POST', url: '/api/errors/reports', headers: { authorization: `Bearer ${tokenFor(u)}` }, payload: { v: 1, description: 'it broke', event: crash('fixed bug') } })
    expect(res.statusCode).toBe(201)
    const [after] = await db.select().from(errorSignatures)
    expect(after.resolvedAt?.getTime()).toBe(resolvedAt.getTime())
    expect(after.regressedAt).toBeNull()
    expect(after.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime())
    expect(after.userReports).toBe(1)
    const [hour] = await db.select().from(errorHourly)
    expect(Number(hour.users)).toBe(0)
    expect(await db.select().from(errorReports)).toHaveLength(1)
  })

  it('takes a client release or request ID only in the right format', async () => {
    await app.inject({ method: 'POST', url: '/api/errors', payload: { v: 1, release: 'v9-fake', events: [crash('x', { requestId: 'stolen' } as any)] } })
    await flushErrors()
    const [e] = await db.select().from(errorEvents)
    expect(e.release).toBe('unknown')
    expect(e.requestId).toBeNull()
  })
})

describe('filing ignores what a client alone can claim (I2)', () => {
  class Fake implements LinearClient {
    issues: string[] = []
    async createIssue(i: { title: string }) { this.issues.push(i.title); return { id: `i${this.issues.length}`, identifier: `LIV-${this.issues.length}`, url: 'u' } }
    async createComment() {}
  }
  let linear: Fake
  beforeEach(async () => { await resetDb(); resetErrorBudgets(); linear = new Fake(); setLinearClient(linear) })
  afterEach(() => setLinearClient(undefined))

  it('one anonymous address sending big counts files nothing; three addresses or users do', async () => {
    await writeRecords(Array.from({ length: 20 }, () => ({ ...clientRecord(crash('noisy'), ctx('198.51.100.7')), count: 20 })))
    expect((await runFilingPass()).filed).toBe(0)
    await writeRecords([clientRecord(crash('noisy'), ctx('198.51.100.8')), clientRecord(crash('noisy'), ctx('198.51.100.9'))])
    expect((await runFilingPass()).filed).toBe(1)
  })

  it('files at most a few issues per pass', async () => {
    for (let i = 0; i < 8; i++) {
      await writeRecords(['198.51.100.1', '198.51.100.2', '198.51.100.3'].map((ip) => clientRecord(crash(words(i)), ctx(ip))))
    }
    const r = await runFilingPass()
    expect(r.filed).toBe(5)
    expect(linear.issues).toHaveLength(5)
  })
})
