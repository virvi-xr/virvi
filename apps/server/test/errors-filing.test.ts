import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import type { ClientErrorEvent } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { errorSignatures, errorHourly } from '../src/db/schema.js'
import { clientRecord, writeRecords, recordServerResponse, flushErrors, resetErrorBuffer } from '../src/errors/record.js'
import { resetErrorBudgets } from '../src/errors/limits.js'
import { runFilingPass, setOnErrorIssueFiled } from '../src/errors/filing.js'
import { setLinearClient, getLinearClient, type LinearClient } from '../src/errors/linear.js'
import { saveThresholds } from '../src/errors/settings.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

class FakeLinear implements LinearClient {
  issues: Array<{ title: string; description: string }> = []
  comments: Array<{ issueId: string; body: string }> = []
  async createIssue(input: { title: string; description: string }) {
    this.issues.push(input)
    const n = this.issues.length
    return { id: `issue-${n}`, identifier: `LIV-${900 + n}`, url: `https://linear.app/x/issue/LIV-${900 + n}` }
  }
  async createComment(issueId: string, body: string) { this.comments.push({ issueId, body }) }
}

const crash = (over: Partial<ClientErrorEvent> = {}): ClientErrorEvent => ({
  kind: 'crash', t: Date.now(), route: '/scenes', errorType: 'TypeError', message: 'Cannot read item 4',
  stack: 'TypeError: x\n    at renderList (https://virvi.io/_next/static/chunks/page-3a9f0c2b1d4e5f60.js:1:2)',
  requestId: '0b1c2d3e-0000-4000-8000-0000000000ab', breadcrumbs: [{ t: Date.now(), type: 'click', label: 'Save scene' }, { t: Date.now(), type: 'api', method: 'PUT', path: '/api/scenes/x', status: 500, ms: 31, requestId: '0b1c2d3e-0000-4000-8000-0000000000ab' }],
  ...over,
})
const ctx = (user: string | null, release = config.release, ip = '198.51.100.1') => ({ release, browser: 'Chrome 131', os: 'macOS', userHash: user, orgId: null, ipKey: ip, ipHash: `ip:${ip}` })
const record = (e: ClientErrorEvent, user: string | null, at = new Date(), release?: string) => writeRecords([clientRecord(e, ctx(user, release), at)])

describe('auto-filing to Linear (off by default)', () => {
  let linear: FakeLinear
  const filedHook: string[] = []
  beforeEach(async () => {
    await resetDb()
    resetErrorBuffer()
    resetErrorBudgets()
    linear = new FakeLinear()
    setLinearClient(linear)
    filedHook.length = 0
    setOnErrorIssueFiled((e) => { filedHook.push(e.issueKey) })
  })
  afterEach(() => { setLinearClient(undefined); setOnErrorIssueFiled(null) })

  it('is off without LINEAR_API_KEY and LINEAR_TEAM_ID: no client, nothing called', async () => {
    setLinearClient(undefined)
    expect(config.linearApiKey).toBeNull()
    expect(getLinearClient()).toBeNull()
    await record(crash(), 'u1')
    await record(crash(), 'u2')
    expect((await runFilingPass()).skipped).toBe('not_configured')
  })

  it('a new signature hitting 2 users after a deploy files exactly one issue, with counts, breadcrumbs and request IDs', async () => {
    await record(crash(), 'u1')
    expect((await runFilingPass()).filed).toBe(0)
    await record(crash({ message: 'Cannot read item 9' }), 'u2')
    const now = new Date()
    expect((await runFilingPass(now)).filed).toBe(1)
    expect(linear.issues).toHaveLength(1)
    const { title, description } = linear.issues[0]
    expect(title).toContain('crash TypeError: Cannot read item <n>')
    expect(description).toContain('2 in all')
    expect(description).toContain('2 users affected')
    expect(description).toContain('click: Save scene')
    expect(description).toContain('api: PUT /api/scenes/x → 500 (31ms)')
    expect(description).toContain('`0b1c2d3e-0000-4000-8000-0000000000ab`')
    expect(description).toContain(`release ${config.release}`)
    expect(filedHook).toEqual(['LIV-901']) // the LIV-51 hook point
    const [sig] = await db.select().from(errorSignatures)
    expect(sig).toMatchObject({ linearIssueKey: 'LIV-901', linearFiledReason: 'new' })
    // more events update that issue instead of making another
    await record(crash(), 'u3')
    await runFilingPass(new Date(now.getTime() + 60_000))
    expect(linear.issues).toHaveLength(1)
    // a daily update while it is active (seen in the last 24 hours)
    await record(crash(), 'u4', new Date(now.getTime() + DAY))
    await runFilingPass(new Date(now.getTime() + DAY + 60_000))
    expect(linear.comments.map((c) => c.body)).toEqual([expect.stringContaining('Daily update')])
    await runFilingPass(new Date(now.getTime() + DAY + 120_000))
    expect(linear.comments).toHaveLength(1)
  })

  it('a server 5xx happening 10 times in an hour is filed', async () => {
    for (let i = 0; i < 9; i++) recordServerResponse({ status: 502, method: 'GET', routeTemplate: '/api/scenes' })
    await flushErrors()
    expect((await runFilingPass()).filed).toBe(0)
    recordServerResponse({ status: 502, method: 'GET', routeTemplate: '/api/scenes' })
    await flushErrors()
    expect((await runFilingPass()).filed).toBe(1)
  })

  it('expected 4xx are never filed, however many users, but a spike files them', async () => {
    const e: ClientErrorEvent = { kind: 'api', t: Date.now(), method: 'GET', path: '/api/scenes', status: 401 }
    for (const u of ['a', 'b', 'c', 'd', 'e']) await record(e, u)
    await writeRecords([{ ...clientRecord(e, ctx(null)), count: 20 }])
    expect((await runFilingPass()).filed).toBe(0)
    // the same signature with four quiet weeks behind it: now it is a spike
    const [sig] = await db.select().from(errorSignatures)
    const now = new Date()
    await db.update(errorSignatures).set({ firstSeenAt: new Date(now.getTime() - 40 * DAY) }).where(eq(errorSignatures.id, sig.id))
    const h0 = Math.floor(now.getTime() / HOUR) * HOUR
    for (let w = 1; w <= 4; w++) await db.insert(errorHourly).values({ signatureId: sig.id, hour: new Date(h0 - w * 7 * DAY), count: 2 })
    const r = await runFilingPass(now)
    expect(r.filed).toBe(1)
    const [after] = await db.select().from(errorSignatures)
    expect(after.linearFiledReason).toBe('spike')
  })

  it('a spike is 3x the usual for that hour of the week, and not before', async () => {
    const now = new Date()
    const h0 = Math.floor(now.getTime() / HOUR) * HOUR
    const at = new Date(h0 + 60_000)
    // a console error (not a crash, so the severe rule stays out of it)
    const warn = crash({ kind: 'console', message: 'render took too long' })
    await writeRecords([{ ...clientRecord(warn, ctx(null), new Date(h0 - 40 * DAY)), count: 1 }])
    const [sig] = await db.select().from(errorSignatures)
    for (let w = 1; w <= 4; w++) await db.insert(errorHourly).values({ signatureId: sig.id, hour: new Date(h0 - w * 7 * DAY), count: 4 })
    await writeRecords([{ ...clientRecord(warn, ctx(null), at), count: 10 }, { ...clientRecord(warn, ctx(null, config.release, '198.51.100.2'), at), count: 1 }])
    expect((await runFilingPass(at)).filed).toBe(0)
    await writeRecords([{ ...clientRecord(warn, ctx(null), at), count: 1 }])
    expect((await runFilingPass(at)).filed).toBe(1)
    expect((await db.select().from(errorSignatures))[0].linearFiledReason).toBe('spike')
  })

  it('a regression after a fix notes the issue; a fix that stays quiet 7 days is noted as quiet', async () => {
    await record(crash(), 'u1')
    await record(crash(), 'u2')
    const t0 = new Date()
    await runFilingPass(t0)
    const [sig] = await db.select().from(errorSignatures)
    // marked fixed, then it happens again
    await db.update(errorSignatures).set({ resolvedAt: new Date(Date.now() - 1000) }).where(eq(errorSignatures.id, sig.id))
    await record(crash(), 'u3')
    await runFilingPass(new Date(t0.getTime() + 60_000))
    expect(linear.comments.map((c) => c.body)).toEqual([expect.stringContaining('came back')])
    await runFilingPass(new Date(t0.getTime() + 120_000))
    expect(linear.comments).toHaveLength(1)
    // marked fixed again; 8 days of nothing
    const fixed = new Date(t0.getTime() + 180_000)
    await db.update(errorSignatures).set({ resolvedAt: fixed, regressedAt: null }).where(eq(errorSignatures.id, sig.id))
    await runFilingPass(new Date(fixed.getTime() + 8 * DAY))
    expect(linear.comments.at(-1)!.body).toContain('Quiet')
    const n = linear.comments.length
    await runFilingPass(new Date(fixed.getTime() + 9 * DAY))
    expect(linear.comments.filter((c) => c.body.includes('Quiet'))).toHaveLength(1)
    expect(linear.comments.length).toBeGreaterThanOrEqual(n)
    expect(linear.issues).toHaveLength(1)
  })

  it('a regression with no issue yet files one', async () => {
    await record(crash(), 'u1')
    const [sig] = await db.select().from(errorSignatures)
    await db.update(errorSignatures).set({ firstSeenAt: new Date(Date.now() - 30 * DAY), resolvedAt: new Date(Date.now() - 1000) }).where(eq(errorSignatures.id, sig.id))
    await record(crash(), 'u1')
    expect((await runFilingPass()).filed).toBe(1)
    expect((await db.select().from(errorSignatures))[0].linearFiledReason).toBe('regression')
  })

  it('the Errors page can switch filing off', async () => {
    await saveThresholds({ filing: false }, '00000000-0000-4000-8000-000000000000')
    await record(crash(), 'u1')
    await record(crash(), 'u2')
    expect((await runFilingPass()).skipped).toBe('off')
    expect(linear.issues).toHaveLength(0)
  })
})
