import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { db } from '../src/db/connection.js'
import { users, errorSignatures, errorReports, errorPromptState, errorPromptKnown } from '../src/db/schema.js'
import { buildApp } from '../src/app.js'
import { resetErrorBuffer, clientRecord, writeRecords } from '../src/errors/record.js'
import { registerRelease, resetErrorBudgets } from '../src/errors/limits.js'
import { resetPromptFacts } from '../src/errors/prompts.js'
import { ERROR_PROMPT_RATE_LIMIT } from '../src/routes/errors.js'
import { purgeErrors } from '../src/errors/retention.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { resetDb } from './helpers/db.js'
import { createUser, tokenFor } from './helpers/factories.js'

/** LIV-66 §4: the server answers "should I ask?" for an error that just broke something the user was doing. */

const HOUR = 3_600_000
const saveFailed = (over: Record<string, unknown> = {}) => ({
  kind: 'api', t: Date.now(), route: '/scenes/x', method: 'PUT', path: '/api/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab', status: 500, userFacing: true, ...over,
})
const ctx = { release: 'abc1234', browser: 'Chrome 131', os: 'macOS', userHash: 'u1', orgId: null, ipKey: '198.51.100.1', ipHash: 'ip:x' }

describe('report prompts (POST /api/errors/prompt)', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    await resetDb()
    resetErrorBuffer()
    resetErrorBudgets()
    resetPromptFacts()
    await registerRelease('abc1234')
    app = await buildApp({ rateLimit: false, logger: false, backfill: false })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  const ask = (event: unknown, bearer?: string) => app.inject({
    method: 'POST', url: '/api/errors/prompt', payload: { v: 1, event } as any,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
  /** The signature row of saveFailed(), as the flusher would write it. */
  async function signature(over: Record<string, unknown> = {}) {
    await writeRecords([clientRecord(saveFailed(over) as any, ctx)])
    const [s] = await db.select().from(errorSignatures)
    return s
  }
  async function addReports(signatureId: string, n: number, at = new Date()) {
    for (let i = 0; i < n; i++) await db.insert(errorReports).values({ signatureId, description: `r${i}`, payload: {}, createdAt: at })
  }

  it('asks a guest about a failed save it has no context for, and leaves the 24-hour rule to the browser', async () => {
    const res = await ask(saveFailed())
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ prompt: 'ask', saved: false, facts: { expected: false, reports: 0, openIssue: false } })
    expect(res.json().signature).toMatch(/^[0-9a-f]{32}$/)
    // nothing about the guest is kept, and no signature is made by asking
    expect(await db.select().from(errorSignatures)).toHaveLength(0)
  })

  it('never asks about a background error or an expected 4xx', async () => {
    expect((await ask(saveFailed({ userFacing: undefined }))).json().prompt).toBe('none')
    const expected = await ask(saveFailed({ status: 400 }))
    expect(expected.json()).toMatchObject({ prompt: 'none', facts: { expected: true } })
    expect((await ask(saveFailed({ status: 403 }))).json().prompt).toBe('none')
  })

  it('asks an account at most once in 24 hours, kept on the server', async () => {
    const u = await createUser()
    const t = tokenFor(u)
    expect((await ask(saveFailed(), t)).json()).toMatchObject({ prompt: 'ask', saved: true })
    const [st] = await db.select().from(errorPromptState).where(eq(errorPromptState.userId, u.id))
    expect(st.askedAt).toBeTruthy()
    // a different error the next minute: not asked again
    expect((await ask(saveFailed({ status: 502 }), t)).json().prompt).toBe('none')
    await db.update(errorPromptState).set({ askedAt: new Date(Date.now() - 25 * HOUR) }).where(eq(errorPromptState.userId, u.id))
    expect((await ask(saveFailed(), t)).json().prompt).toBe('ask')
  })

  it('two tabs asking at once are asked once', async () => {
    const u = await createUser()
    const t = tokenFor(u)
    const answers = await Promise.all([ask(saveFailed(), t), ask(saveFailed({ status: 502 }), t), ask(saveFailed({ status: 503 }), t)])
    expect(answers.map((a) => a.json().prompt).filter((p) => p === 'ask')).toHaveLength(1)
  })

  it('never asks an account that turned prompts off (account settings)', async () => {
    const u = await createUser()
    const t = tokenFor(u)
    const h = { authorization: `Bearer ${t}` }
    expect((await app.inject({ method: 'GET', url: '/api/errors/prompt-settings', headers: h })).json()).toEqual({ askAboutErrors: true })
    const put = await app.inject({ method: 'PUT', url: '/api/errors/prompt-settings', headers: h, payload: { askAboutErrors: false } })
    expect([put.statusCode, put.json()]).toEqual([200, { askAboutErrors: false }])
    expect((await ask(saveFailed(), t)).json().prompt).toBe('none')
    expect((await app.inject({ method: 'PUT', url: '/api/errors/prompt-settings', headers: h, payload: { askAboutErrors: 'no' } })).statusCode).toBe(400)
    await app.inject({ method: 'PUT', url: '/api/errors/prompt-settings', headers: h, payload: { askAboutErrors: true } })
    expect((await ask(saveFailed(), t)).json().prompt).toBe('ask')
  })

  it('prompt settings are for accounts: a guest is refused and a trial keeps its own in the browser', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/errors/prompt-settings' })).statusCode).toBe(401)
    const tr = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, tr.id))
    const { accessToken } = issueTrialSession(app, { id: tr.id, displayName: tr.displayName, role: 'creator', trialLastActiveAt: new Date() })
    const res = await app.inject({ method: 'GET', url: '/api/errors/prompt-settings', headers: { authorization: `Bearer ${accessToken}` } })
    expect([res.statusCode, res.json().error]).toEqual([403, 'account_required'])
    // its prompt check is answered like a guest's
    expect((await ask(saveFailed(), accessToken)).json()).toMatchObject({ prompt: 'ask', saved: false })
    expect(await db.select().from(errorPromptState)).toHaveLength(0)
  })

  it('a signature with 3 descriptions is never asked about: "we know about this", once per account', async () => {
    const s = await signature()
    await addReports(s.id, 3)
    const u = await createUser()
    const t = tokenFor(u)
    expect((await ask(saveFailed(), t)).json()).toMatchObject({ prompt: 'known', facts: { reports: 3 } })
    expect(await db.select().from(errorPromptKnown)).toHaveLength(1)
    resetPromptFacts()
    expect((await ask(saveFailed(), t)).json().prompt).toBe('none')
    // and no "asked" was used up
    expect(await db.select().from(errorPromptState)).toHaveLength(0)
    // a guest gets the facts to decide with
    expect((await ask(saveFailed())).json()).toMatchObject({ prompt: 'known', saved: false, facts: { reports: 3 } })
  })

  it('an open issue with few descriptions still asks; asked lately, they hear "we know" instead', async () => {
    const s = await signature()
    await db.update(errorSignatures).set({ linearIssueId: 'issue-1', linearIssueKey: 'LIV-1' }).where(eq(errorSignatures.id, s.id))
    const u = await createUser()
    const t = tokenFor(u)
    expect((await ask(saveFailed(), t)).json()).toMatchObject({ prompt: 'ask', facts: { openIssue: true } })
    expect((await ask(saveFailed(), t)).json().prompt).toBe('known')
    expect((await ask(saveFailed(), t)).json().prompt).toBe('none')
  })

  it('descriptions from before a fix do not count', async () => {
    const s = await signature()
    await addReports(s.id, 3, new Date(Date.now() - 48 * HOUR))
    await db.update(errorSignatures).set({ resolvedAt: new Date(Date.now() - 24 * HOUR) }).where(eq(errorSignatures.id, s.id))
    expect((await ask(saveFailed())).json()).toMatchObject({ prompt: 'ask', facts: { reports: 0, openIssue: false } })
  })

  it("a deleted account's token is answered like a guest's, never a 500", async () => {
    const u = await createUser()
    const t = tokenFor(u)
    await db.delete(users).where(eq(users.id, u.id))
    const res = await ask(saveFailed(), t)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ prompt: 'ask', saved: false })
  })

  it('validates the event and is rate limited per address', async () => {
    expect((await ask({ kind: 'nope' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/errors/prompt', payload: { v: 2 } })).statusCode).toBe(400)
    expect(ERROR_PROMPT_RATE_LIMIT.max).toBe(30)
  })

  it('"we know" marks (an account hash) are kept 30 days, as the privacy page says (I5)', async () => {
    const s = await signature()
    await db.insert(errorPromptKnown).values([
      { signatureId: s.id, userHash: 'old', shownAt: new Date(Date.now() - 31 * 24 * HOUR) },
      { signatureId: s.id, userHash: 'new', shownAt: new Date() },
    ])
    await purgeErrors(new Date())
    expect((await db.select().from(errorPromptKnown)).map((r) => r.userHash)).toEqual(['new'])
  })

  it('caches what it knows about a signature for a minute', async () => {
    const s = await signature()
    expect((await ask(saveFailed())).json().facts.reports).toBe(0)
    await addReports(s.id, 3)
    expect((await ask(saveFailed())).json().facts.reports).toBe(0)
    resetPromptFacts()
    expect((await ask(saveFailed())).json().facts.reports).toBe(3)
    await db.execute(sql`SELECT 1`)
  })
})
