import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import type { ClientErrorEvent } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { errorSignatures, errorReports, users } from '../src/db/schema.js'
import { clientRecord, writeRecords, resetErrorBuffer, reportSignature } from '../src/errors/record.js'
import { resetErrorBudgets } from '../src/errors/limits.js'
import { runFilingPass, resetPendingIssueSaves, setFilingDbHook } from '../src/errors/filing.js'
import { syncLinearDone, DONE_SYNC_EVERY_MS } from '../src/errors/linear-sync.js'
import { setLinearClient, httpLinearClient, LinearError, resetLinearBackoff, type LinearClient, type LinearIssueState } from '../src/errors/linear.js'
import { ERROR_BUDGETS } from '../src/errors/limits.js'
import { setOnErrorIssueFiled } from '../src/errors/filing.js'
import { withLock } from '../src/errors/jobs.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'

/** LIV-66 phase 2 with Linear (mocked): reports posted to issues, issues never made twice, and Done read back. */

const HOUR = 3_600_000
const DAY = 24 * HOUR

class FakeLinear implements LinearClient {
  issues: Array<{ id: string; title: string; description: string }> = []
  comments: Array<{ issueId: string; body: string }> = []
  states = new Map<string, LinearIssueState>()
  failComment: Error | null = null
  calls = 0
  stateCalls: string[][] = []
  async createIssue(input: { title: string; description: string }) {
    const n = this.issues.length + 1
    this.issues.push({ id: `issue-${n}`, ...input })
    return { id: `issue-${n}`, identifier: `LIV-${900 + n}`, url: `https://linear.app/x/issue/LIV-${900 + n}` }
  }
  async createComment(issueId: string, body: string) {
    this.calls++
    if (this.failComment) throw this.failComment
    this.comments.push({ issueId, body })
  }
  async issueStates(ids: string[]) {
    this.stateCalls.push(ids)
    return ids.map((id) => this.states.get(id)).filter((s): s is LinearIssueState => !!s)
  }
}

const crash = (over: Partial<ClientErrorEvent> = {}): ClientErrorEvent => ({
  kind: 'crash', t: Date.now(), route: '/scenes', errorType: 'TypeError', message: 'Cannot read item 4',
  stack: 'TypeError: x\n    at renderList (https://virvi.io/_next/static/chunks/page-3a9f0c2b1d4e5f60.js:1:2)', ...over,
})
const ctx = (user: string | null, ip = '198.51.100.1') => ({ release: config.release, browser: 'Chrome 131', os: 'macOS', userHash: user, orgId: null, ipKey: ip, ipHash: `ip:${ip}` })

let reportN = 0
async function reportOn(e: ClientErrorEvent, userId: string | null, description = 'I was saving my scene', createdAt = new Date()) {
  // each from its own address, so the per-address new-signature budget doesn't fold them into overflow
  reportN++
  const signatureId = (await reportSignature(clientRecord(e, ctx(null, `10.${(reportN >> 16) & 255}.${(reportN >> 8) & 255}.${reportN & 255}`))))!
  const [r] = await db.insert(errorReports).values({ signatureId, userId, description, payload: { v: 1, description, event: e }, createdAt }).returning()
  await db.update(errorSignatures).set({ userReports: 1 }).where(eq(errorSignatures.id, signatureId))
  return { signatureId, report: r }
}

describe('Linear phase 2', () => {
  let linear: FakeLinear
  beforeEach(async () => {
    await resetDb()
    resetErrorBuffer()
    resetErrorBudgets()
    resetPendingIssueSaves()
    resetLinearBackoff()
    linear = new FakeLinear()
    setLinearClient(linear)
  })
  afterEach(() => { setLinearClient(undefined); setFilingDbHook(null) })

  describe('posting reports', () => {
    it("adds a report to the signature's issue as a comment with the real account", async () => {
      await writeRecords([clientRecord(crash(), ctx('u1'))])
      await writeRecords([clientRecord(crash(), ctx('u2', '198.51.100.2'))])
      await runFilingPass()
      expect(linear.issues).toHaveLength(1)
      const u = await createUser({ email: 'maker@example.com', name: 'Maker Jo' })
      const { report } = await reportOn(crash(), u.id, 'Saving my scene; token=abc123secretvalue')
      await runFilingPass(new Date(Date.now() + 60_000))
      expect(linear.issues).toHaveLength(1)
      expect(linear.comments).toHaveLength(1)
      const c = linear.comments[0]
      expect(c.issueId).toBe('issue-1')
      // the account id and the Errors page link; never the name or the email (I4)
      expect(c.body).toContain(u.id)
      expect(c.body).toContain(`/admin/errors?id=`)
      expect(c.body).not.toContain('Maker Jo')
      expect(c.body).not.toContain('maker@example.com')
      expect(c.body).toContain('Saving my scene')
      expect(c.body).not.toContain('abc123secretvalue') // typed secrets are still redacted
      const [r] = await db.select().from(errorReports).where(eq(errorReports.id, report.id))
      expect(r.linearPostedAt).toBeTruthy()
      // posted once
      await runFilingPass(new Date(Date.now() + 120_000))
      expect(linear.comments).toHaveLength(1)
    })

    it("an account's report on a signature with real events and no issue makes one, then comments on it (no LIV-51 run)", async () => {
      const hooked: string[] = []
      setOnErrorIssueFiled((e) => { hooked.push(e.issueKey) })
      await writeRecords([clientRecord(crash({ message: 'Only I saw this' }), ctx('u1'))])
      const u = await createUser()
      const { signatureId } = await reportOn(crash({ message: 'Only I saw this' }), u.id)
      await runFilingPass()
      expect(linear.issues).toHaveLength(1)
      expect(linear.comments.map((c) => c.issueId)).toEqual(['issue-1'])
      const [s] = await db.select().from(errorSignatures).where(eq(errorSignatures.id, signatureId))
      expect(s).toMatchObject({ linearIssueKey: 'LIV-901', linearFiledReason: 'report' })
      expect(hooked).toEqual([])
      setOnErrorIssueFiled(null)
    })

    it('a report alone (no real events) or a help-menu report never makes an issue (I2)', async () => {
      const u = await createUser()
      await reportOn(crash({ message: 'claimed only by the report' }), u.id)
      await reportOn({ kind: 'report', t: Date.now(), route: '/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab' }, u.id)
      await runFilingPass()
      expect(linear.issues).toHaveLength(0)
    })

    it('one account makes at most 1 issue a day from reports, and reports make at most 5 a day in all (I2)', async () => {
      expect([ERROR_BUDGETS.reportIssuesPerDay, ERROR_BUDGETS.reportIssuesPerAccountDay]).toEqual([5, 1])
      const spammer = await createUser()
      for (let i = 0; i < 4; i++) {
        await writeRecords([clientRecord(crash({ message: `spam ${'abcd'[i]}` }), ctx('u1'))])
        await reportOn(crash({ message: `spam ${'abcd'[i]}` }), spammer.id)
      }
      await runFilingPass()
      expect(linear.issues).toHaveLength(1)
      // the rest are marked skipped, so they leave the window
      expect((await db.select().from(errorReports)).filter((r) => r.linearSkipped === 'account_issue_budget')).toHaveLength(3)
      for (let i = 0; i < 6; i++) {
        const u = await createUser()
        await writeRecords([clientRecord(crash({ message: `other ${'abcdef'[i]}` }), ctx('u1'))])
        await reportOn(crash({ message: `other ${'abcdef'[i]}` }), u.id)
      }
      await runFilingPass(new Date(Date.now() + 60_000))
      expect(linear.issues).toHaveLength(5)
      // auto-filing's own budget is untouched: a real new error with 2 users still files
      await writeRecords([clientRecord(crash({ message: 'real' }), ctx('ua'))])
      await writeRecords([clientRecord(crash({ message: 'real' }), ctx('ub', '198.51.100.2'))])
      await runFilingPass(new Date(Date.now() + 120_000))
      expect(linear.issues).toHaveLength(6)
    })

    it('170 unpostable reports (more than a pass reads) never hold up a postable one (I1)', async () => {
      const old = new Date(Date.now() - 2 * DAY)
      for (let i = 0; i < 170; i++) await reportOn(crash({ message: `guest page ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}` }), null, 'x', old)
      const u = await createUser()
      const { signatureId } = await reportOn(crash({ message: 'has an issue' }), u.id)
      await db.update(errorSignatures).set({ linearIssueId: 'issue-x', linearFiledAt: new Date(Date.now() - HOUR) }).where(eq(errorSignatures.id, signatureId))
      await runFilingPass()
      expect(linear.comments.map((c) => c.issueId)).toEqual(['issue-x'])
    })

    it("a guest's report never makes an issue, and waits for one; a trial counts as a guest", async () => {
      const { signatureId } = await reportOn(crash({ message: 'guest only' }), null)
      const t = await createUser({ email: null })
      await db.update(users).set({ isTrial: true }).where(eq(users.id, t.id))
      await reportOn(crash({ message: 'guest only' }), t.id)
      await runFilingPass()
      expect(linear.issues).toHaveLength(0)
      expect(linear.comments).toHaveLength(0)
      // once the signature has an issue (filed by the data), the guest's report goes on it, as from a guest
      await db.update(errorSignatures).set({ linearIssueId: 'issue-x', linearIssueKey: 'LIV-1', linearFiledAt: new Date(Date.now() - HOUR) }).where(eq(errorSignatures.id, signatureId))
      await runFilingPass()
      expect(linear.comments).toHaveLength(2)
      expect(linear.comments[0].body).toContain('a guest')
    })

    it("a deleted account's report posts as no one", async () => {
      const u = await createUser({ email: 'gone@example.com' })
      const { signatureId } = await reportOn(crash(), u.id)
      await db.update(errorSignatures).set({ linearIssueId: 'issue-x', linearFiledAt: new Date(Date.now() - HOUR) }).where(eq(errorSignatures.id, signatureId))
      await db.delete(users).where(eq(users.id, u.id))
      await runFilingPass()
      expect(linear.comments).toHaveLength(1)
      expect(linear.comments[0].body).not.toContain('gone@example.com')
    })

    it('posts at most 5 reports a day per signature; the rest wait for tomorrow', async () => {
      const u = await createUser()
      let sig = ''
      for (let i = 0; i < 7; i++) sig = (await reportOn(crash(), u.id, `report ${i}`)).signatureId
      await db.update(errorSignatures).set({ linearIssueId: 'issue-x', linearFiledAt: new Date(Date.now() - HOUR) }).where(eq(errorSignatures.id, sig))
      await runFilingPass()
      expect(linear.comments).toHaveLength(5)
      await runFilingPass(new Date(Date.now() + 60_000))
      expect(linear.comments).toHaveLength(5)
      await runFilingPass(new Date(Date.now() + DAY + 60_000))
      expect(linear.comments).toHaveLength(7)
    })

    it('a rate limit or 5xx stops the pass at the first failure and backs off; the report is tried again later (I1)', async () => {
      const u = await createUser()
      let sig = ''
      for (let i = 0; i < 4; i++) sig = (await reportOn(crash(), u.id, `r${i}`)).signatureId
      await db.update(errorSignatures).set({ linearIssueId: 'issue-x', linearFiledAt: new Date(Date.now() - HOUR) }).where(eq(errorSignatures.id, sig))
      linear.failComment = new LinearError('Linear 429: rate limited', 429, true)
      expect((await runFilingPass()).failed).toBe(1)
      expect(linear.calls).toBe(1)
      linear.failComment = null
      expect((await runFilingPass()).skipped).toBe('backoff')
      expect(linear.calls).toBe(1)
      await runFilingPass(new Date(Date.now() + 6 * 60_000))
      expect(linear.comments).toHaveLength(4)
    })

    it('a revoked or wrong Linear key stops the pass and backs off; reports are never marked refused (N2)', async () => {
      const u = await createUser()
      const { signatureId, report } = await reportOn(crash(), u.id)
      await db.update(errorSignatures).set({ linearIssueId: 'issue-x', linearFiledAt: new Date(Date.now() - HOUR) }).where(eq(errorSignatures.id, signatureId))
      linear.failComment = new LinearError('Linear 401: Authentication required', 401, false)
      await runFilingPass()
      const [r] = await db.select().from(errorReports).where(eq(errorReports.id, report.id))
      expect([r.linearSkipped, r.linearPostedAt]).toEqual([null, null])
      expect((await runFilingPass()).skipped).toBe('backoff')
      linear.failComment = null
      await runFilingPass(new Date(Date.now() + 6 * 60_000))
      expect(linear.comments).toHaveLength(1)
    })

    it('the HTTP client treats 401, 403 and AUTHENTICATION_ERROR as stop-and-back-off', async () => {
      const { isTransientLinearError } = await import('../src/errors/linear.js')
      for (const [status, body] of [[401, {}], [403, {}], [200, { errors: [{ message: 'x', extensions: { code: 'AUTHENTICATION_ERROR' } }] }]] as const) {
        const client = httpLinearClient({ apiKey: 'k', teamId: 't', fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch })
        const err = await client.createComment('i', 'b').catch((e) => e)
        expect(isTransientLinearError(err), String(status)).toBe(true)
      }
    })

    it('a comment Linear refuses for good is marked skipped, and failures count toward the pass cap', async () => {
      const u = await createUser()
      const { signatureId, report } = await reportOn(crash(), u.id)
      await db.update(errorSignatures).set({ linearIssueId: 'issue-gone', linearFiledAt: new Date(Date.now() - HOUR) }).where(eq(errorSignatures.id, signatureId))
      linear.failComment = new LinearError('Linear 400: Entity not found', 400, false)
      expect((await runFilingPass()).failed).toBe(1)
      const [r] = await db.select().from(errorReports).where(eq(errorReports.id, report.id))
      expect([r.linearSkipped, r.linearPostedAt]).toEqual(['linear_refused', null])
      await runFilingPass()
      expect(linear.calls).toBe(1)
    })

    it('says on the comment when there is a screenshot, without sending it', async () => {
      const u = await createUser()
      const { signatureId, report } = await reportOn(crash(), u.id)
      await db.update(errorReports).set({ screenshotKey: `error-reports/${report.id}.png`, screenshotType: 'image/png', screenshotBytes: 10 }).where(eq(errorReports.id, report.id))
      await db.update(errorSignatures).set({ linearIssueId: 'issue-x', linearFiledAt: new Date(Date.now() - HOUR) }).where(eq(errorSignatures.id, signatureId))
      await runFilingPass()
      expect(linear.comments[0].body).toContain(`/admin/errors?id=${signatureId}`)
      expect(linear.comments[0].body).toMatch(/and the screenshot/i)
    })

    it('stays off with filing off: reports are only stored', async () => {
      setLinearClient(null)
      const u = await createUser()
      await reportOn(crash(), u.id)
      expect((await runFilingPass()).skipped).toBe('not_configured')
      const [r] = await db.select().from(errorReports)
      expect(r.linearPostedAt).toBeNull()
    })
  })

  describe('an issue is never made twice (M7b)', () => {
    it('if saving the new issue fails, the next pass saves it instead of making another', async () => {
      await writeRecords([clientRecord(crash(), ctx('u1'))])
      await writeRecords([clientRecord(crash(), ctx('u2', '198.51.100.2'))])
      let fail = 3
      setFilingDbHook(() => { if (fail-- > 0) throw new Error('db down') })
      const r1 = await runFilingPass()
      expect(r1.failed).toBe(1)
      expect(linear.issues).toHaveLength(1)
      const [mid] = await db.select().from(errorSignatures)
      expect(mid.linearIssueId).toBeNull()
      expect(mid.linearFilingAt).toBeTruthy() // claimed: no other pass or instance files it
      setFilingDbHook(null)
      await runFilingPass(new Date(Date.now() + 60_000))
      expect(linear.issues).toHaveLength(1)
      const [after] = await db.select().from(errorSignatures)
      expect(after).toMatchObject({ linearIssueId: 'issue-1', linearIssueKey: 'LIV-901', linearFilingAt: null })
    })

    it('a save that only fails once is retried at once', async () => {
      await writeRecords([clientRecord(crash(), ctx('u1'))])
      await writeRecords([clientRecord(crash(), ctx('u2', '198.51.100.2'))])
      let fail = 1
      setFilingDbHook(() => { if (fail-- > 0) throw new Error('blip') })
      expect((await runFilingPass()).filed).toBe(1)
      expect((await db.select().from(errorSignatures))[0].linearIssueId).toBe('issue-1')
    })

    it('a claimed signature (another instance filing it right now) is skipped', async () => {
      await writeRecords([clientRecord(crash(), ctx('u1'))])
      await writeRecords([clientRecord(crash(), ctx('u2', '198.51.100.2'))])
      await db.update(errorSignatures).set({ linearFilingAt: new Date() })
      expect((await runFilingPass()).filed).toBe(0)
      expect(linear.issues).toHaveLength(0)
    })

    it('when making the issue fails, the claim is let go so the next pass tries again', async () => {
      await writeRecords([clientRecord(crash(), ctx('u1'))])
      await writeRecords([clientRecord(crash(), ctx('u2', '198.51.100.2'))])
      const create = linear.createIssue.bind(linear)
      linear.createIssue = async () => { throw new Error('Linear 503') }
      expect((await runFilingPass()).failed).toBe(1)
      expect((await db.select().from(errorSignatures))[0].linearFilingAt).toBeNull()
      linear.createIssue = create
      expect((await runFilingPass()).filed).toBe(1)
    })
  })

  describe('reading Done from Linear', () => {
    async function filed() {
      await writeRecords([clientRecord(crash(), ctx('u1'))])
      await writeRecords([clientRecord(crash(), ctx('u2', '198.51.100.2'))])
      await runFilingPass()
      return (await db.select().from(errorSignatures))[0]
    }

    it('marks a signature fixed when its issue is completed, so a later event is a regression', async () => {
      const s = await filed()
      linear.states.set('issue-1', { id: 'issue-1', stateType: 'started', completedAt: null })
      expect((await syncLinearDone()).resolved).toBe(0)
      const done = new Date(Date.now() - 60_000).toISOString()
      linear.states.set('issue-1', { id: 'issue-1', stateType: 'completed', completedAt: done })
      expect((await syncLinearDone()).resolved).toBe(1)
      const [r] = await db.select().from(errorSignatures).where(eq(errorSignatures.id, s.id))
      expect(r.resolvedAt).toBeTruthy()
      expect(r.resolvedBy).toBeNull()
      expect(r.linearDoneAt!.toISOString()).toBe(done)
      // it happens again: a regression, and the still-Done issue does not mark it fixed again
      await writeRecords([clientRecord(crash({ t: Date.now() + 1000 }), ctx('u3', '198.51.100.3'), new Date(Date.now() + 1000))])
      const [back] = await db.select().from(errorSignatures).where(eq(errorSignatures.id, s.id))
      expect(back.resolvedAt).toBeNull()
      expect(back.regressedAt).toBeTruthy()
      expect((await syncLinearDone(new Date(Date.now() + 5000))).resolved).toBe(0)
      expect((await db.select().from(errorSignatures))[0].resolvedAt).toBeNull()
      // completed again after the regression: fixed again
      linear.states.set('issue-1', { id: 'issue-1', stateType: 'completed', completedAt: new Date(Date.now() + 10_000).toISOString() })
      expect((await syncLinearDone(new Date(Date.now() + 20_000))).resolved).toBe(1)
    })

    it('an issue reopened in Linear un-marks a signature Linear had marked fixed (not one an admin marked)', async () => {
      const s = await filed()
      linear.states.set('issue-1', { id: 'issue-1', stateType: 'completed', completedAt: new Date().toISOString() })
      await syncLinearDone()
      linear.states.set('issue-1', { id: 'issue-1', stateType: 'started', completedAt: null })
      expect((await syncLinearDone()).reopened).toBe(1)
      expect((await db.select().from(errorSignatures))[0]).toMatchObject({ resolvedAt: null, linearDoneAt: null })
      const admin = await createUser({ role: 'admin' })
      await db.update(errorSignatures).set({ resolvedAt: new Date(), resolvedBy: admin.id }).where(eq(errorSignatures.id, s.id))
      expect((await syncLinearDone()).reopened).toBe(0)
      expect((await db.select().from(errorSignatures))[0].resolvedAt).toBeTruthy()
    })

    it("an admin's Undo is not overridden by the same completion", async () => {
      const s = await filed()
      linear.states.set('issue-1', { id: 'issue-1', stateType: 'completed', completedAt: new Date().toISOString() })
      await syncLinearDone()
      await db.update(errorSignatures).set({ resolvedAt: null, resolvedBy: null }).where(eq(errorSignatures.id, s.id))
      expect((await syncLinearDone()).resolved).toBe(0)
      expect((await db.select().from(errorSignatures))[0].resolvedAt).toBeNull()
    })

    it("an issue closed as Canceled, Won't fix or Duplicate closes the link without marking it fixed (M3, N5)", async () => {
      await filed()
      linear.states.set('issue-1', { id: 'issue-1', stateType: 'canceled', completedAt: null, canceledAt: new Date().toISOString() })
      const r = await syncLinearDone()
      expect([r.resolved, r.unlinked]).toEqual([0, 1])
      const [s] = await db.select().from(errorSignatures)
      expect(s).toMatchObject({ resolvedAt: null, regressedAt: null, linearIssueId: null, linearIssueKey: null })
      // so it can be filed again later, as a new issue (here: a spike of new users)
      await writeRecords([clientRecord(crash(), ctx('u3', '198.51.100.3'))])
      await writeRecords([clientRecord(crash(), ctx('u4', '198.51.100.4'))])
      expect((await runFilingPass(new Date(Date.now() + 60_000))).filed).toBe(1)
      expect(linear.issues).toHaveLength(2)
    })

    it('the Done sync honours the backoff and starts it on a transient failure (N3)', async () => {
      await filed()
      const states = linear.issueStates.bind(linear)
      linear.issueStates = async () => { throw new LinearError('Linear 503', 503, true) }
      const r = await syncLinearDone()
      expect(r.checked).toBe(0)
      linear.issueStates = states
      expect((await syncLinearDone()).skipped).toBe('backoff')
      expect((await runFilingPass()).skipped).toBe('backoff')
      expect(linear.stateCalls).toHaveLength(0)
      expect((await syncLinearDone(new Date(Date.now() + 6 * 60_000))).skipped).toBeUndefined()
    })

    it('asks Linear in batches of 50, and does nothing with filing off or no key', async () => {
      for (let i = 0; i < 120; i++) {
        await db.insert(errorSignatures).values({ hash: `h${i}`, signature: `s${i}`, source: 'server', kind: 'job', linearIssueId: `issue-${i}` })
      }
      await syncLinearDone()
      expect(linear.stateCalls.map((c) => c.length)).toEqual([50, 50, 20])
      setLinearClient(null)
      expect((await syncLinearDone()).skipped).toBe('not_configured')
      expect(DONE_SYNC_EVERY_MS).toBe(10 * 60_000)
    })

    it('runs on one instance at a time', async () => {
      await filed()
      let runs = 0
      const job = () => withLock('errors:linear-done', async () => { runs++; await new Promise((r) => setTimeout(r, 100)); return syncLinearDone() })
      const [a, b] = await Promise.all([job(), job()])
      expect(runs).toBe(1)
      expect([a, b].filter((x) => x === null)).toHaveLength(1)
    })

    it('the HTTP client reads issue states with one GraphQL query per batch', async () => {
      const calls: Array<{ query: string; variables: { ids: string[] } }> = []
      const client = httpLinearClient({
        apiKey: 'lin_api_test', teamId: 'team',
        fetch: (async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body))
          calls.push(body)
          return new Response(JSON.stringify({ data: { issues: { nodes: [{ id: 'a', completedAt: '2026-11-08T00:00:00.000Z', state: { type: 'completed' } }] } } }), { status: 200 })
        }) as typeof fetch,
      })
      expect(await client.issueStates(['a', 'b'])).toEqual([{ id: 'a', stateType: 'completed', completedAt: '2026-11-08T00:00:00.000Z', canceledAt: null }])
      expect(calls[0].query).toContain('issues(')
      expect(calls[0].variables.ids).toEqual(['a', 'b'])
    })
  })
})
