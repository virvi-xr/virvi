import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { checkErrorBatch, checkErrorReport, checkPromptRequest, parseUserAgent, ERROR_LIMITS } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { errorReports } from '../db/schema.js'
import { config } from '../config.js'
import { clientRecord, recordClientEvents, reportSignature } from '../errors/record.js'
import { errorIpHash, errorUserHash } from '../errors/user-hash.js'
import { ERROR_BUDGETS, ipKey, takeReport } from '../errors/limits.js'
import { getAskAboutErrors, promptFor, setAskAboutErrors } from '../errors/prompts.js'
import { authenticate } from '../middleware/auth.js'
import { forgetPromptFacts } from '../errors/prompts.js'
import { prepareScreenshot, reportAccount, ScreenshotError, sendReportAck, storeScreenshot, takeScreenshotBudget, type Screenshot } from '../errors/reports.js'

/**
 * Error reports from the web app (LIV-66). Public: guests, trials and signed-in users all report. An optional bearer
 * only says who to count (hashed); a client-sent user, org or browser is never read. Rate limited per address
 * (request.ip, which respects TRUST_PROXY_HOPS). Neither route reports its own failures.
 */

/** Per address (IPv4, or IPv6 by /64) per minute. */
const byAddress = (request: FastifyRequest) => ipKey(request.ip)
export const ERROR_INGEST_RATE_LIMIT = { max: 60, timeWindow: '1 minute', keyGenerator: byAddress }
export const ERROR_REPORT_RATE_LIMIT = { max: 10, timeWindow: '1 minute', keyGenerator: byAddress }
/** A report's body: the usual cap plus a 2 MB screenshot as base64. */
export const REPORT_BODY_LIMIT = ERROR_LIMITS.maxBodyBytes + Math.ceil(ERROR_LIMITS.maxScreenshotBytes / 3) * 4 + 1024
/** The prompt check is cheap (cached, reads one signature) and the browser asks at most once per signature a page. */
export const ERROR_PROMPT_RATE_LIMIT = { max: 30, timeWindow: '1 minute', keyGenerator: byAddress }

/**
 * Who sent this, from a valid account or trial token; never a claim in the body. Scene passes and API keys count as no
 * one. `trial` marks a guest trial, which is anonymous for the signed-in reserve (errors/limits.ts).
 */
export function reporterOf(request: FastifyRequest): { userId: string | null; orgId: string | null; trial?: boolean } {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ') || header.startsWith('Bearer virvi_')) return { userId: null, orgId: null }
  try {
    const decoded = request.server.jwt.verify<{ id?: string; kind?: string; refresh?: boolean; guest?: boolean; via?: string; orgId?: string | null }>(header.slice(7))
    if (decoded.refresh || decoded.guest || decoded.via || !decoded.id) return { userId: null, orgId: null }
    if (decoded.kind === 'account') return { userId: decoded.id, orgId: decoded.orgId ?? null }
    if (decoded.kind === 'trial') return { userId: decoded.id, orgId: null, trial: true }
  } catch { /* not a token of ours: no one */ }
  return { userId: null, orgId: null }
}

async function contextOf(request: FastifyRequest, release: string | null) {
  const who = reporterOf(request)
  const { browser, os } = parseUserAgent(request.headers['user-agent'])
  const ip = ipKey(request.ip)
  return { who, ctx: { release, browser, os, userHash: who.userId ? errorUserHash(who.userId) : null, trial: !!who.trial, orgId: who.orgId, ipKey: ip, ipHash: await errorIpHash(ip) } }
}

/** The stored copy of a report's event, cut like a stored event (oldest breadcrumbs, then the stack). */
function boundEvent<T extends { breadcrumbs?: unknown[]; stack?: string }>(e: T): T {
  const out = { ...e, breadcrumbs: e.breadcrumbs ? [...e.breadcrumbs] : undefined }
  const size = () => JSON.stringify(out).length
  while (out.breadcrumbs?.length && size() > ERROR_BUDGETS.maxStoredEventBytes) out.breadcrumbs.shift()
  if (out.stack && size() > ERROR_BUDGETS.maxStoredEventBytes) out.stack = out.stack.slice(0, 1500)
  return out
}

export default async function errorRoutes(app: FastifyInstance) {
  app.post('/api/errors', {
    bodyLimit: ERROR_LIMITS.maxBodyBytes,
    logLevel: 'warn', // per-request logs carry the client IP
    config: { rateLimit: ERROR_INGEST_RATE_LIMIT },
  }, async (request, reply) => {
    const checked = checkErrorBatch(request.body, Date.now())
    if (!checked.ok) return reply.status(400).send({ error: checked.error })
    if (config.errorReportingEnabled) recordClientEvents(checked.events, (await contextOf(request, checked.release)).ctx)
    return reply.status(202).send({ accepted: checked.events.length })
  })

  // "Should I ask?" after an error broke something the user was doing (§4). Never makes a signature or counts anything;
  // an account's 24-hour and opt-out state is applied here, a guest's or trial's in its browser (it gets the facts).
  app.post('/api/errors/prompt', {
    bodyLimit: 16 * 1024,
    logLevel: 'warn',
    config: { rateLimit: ERROR_PROMPT_RATE_LIMIT },
  }, async (request, reply) => {
    const checked = checkPromptRequest(request.body, Date.now())
    if (!checked.ok) return reply.status(400).send({ error: checked.error })
    const { who, ctx } = await contextOf(request, null)
    const record = clientRecord(checked.event, ctx)
    const account = who.userId && !who.trial ? who.userId : null
    return reply.send(await promptFor({ hash: record.hash, expected: !!record.expected, userFacing: record.userFacing }, account))
  })

  // "Don't ask me about errors" for an account (guests and trials keep theirs in the browser)
  const accountOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user.guest || request.user.via || request.user.viaApiKey) return reply.status(403).send({ error: 'account_required' })
  }
  app.get('/api/errors/prompt-settings', { preHandler: [authenticate, accountOnly] }, async (request) => {
    return { askAboutErrors: await getAskAboutErrors(request.user.id) }
  })
  app.put<{ Body: { askAboutErrors?: unknown } }>('/api/errors/prompt-settings', { preHandler: [authenticate, accountOnly] }, async (request, reply) => {
    const ask = request.body?.askAboutErrors
    if (typeof ask !== 'boolean') return reply.status(400).send({ error: 'askAboutErrors must be true or false' })
    await setAskAboutErrors(request.user.id, ask)
    return { askAboutErrors: ask }
  })

  // A user's report (a crash screen's Report, the prompt toast or the help menu): what they were doing, attached to the
  // error's signature (or the page's, with no error) with their account if signed in (they chose to send it). The
  // payload stored is exactly what the form's "What we'll send" preview showed; a screenshot is stored on its own.
  app.post('/api/errors/reports', {
    bodyLimit: REPORT_BODY_LIMIT,
    logLevel: 'warn',
    config: { rateLimit: ERROR_REPORT_RATE_LIMIT },
  }, async (request, reply) => {
    const checked = checkErrorReport(request.body, Date.now())
    if (!checked.ok) return reply.status(400).send({ error: checked.error })
    const { who, ctx } = await contextOf(request, checked.release)
    // Checked (and re-encoded) before anything is kept, so a bad picture can be fixed and sent again
    let shot: Screenshot | null = null
    if (checked.screenshot) {
      try {
        shot = await prepareScreenshot(checked.screenshot)
      } catch (err) {
        if (err instanceof ScreenshotError) return reply.status(err.status).send({ error: err.code })
        throw err
      }
    }
    if (!takeReport(ctx.ipKey)) return reply.status(429).send({ error: 'rate_limited', retryAfter: 3600 })
    // The report's signature, found or made without counting anything: no event, recurrence or affected user
    const record = clientRecord(checked.event, ctx)
    const signatureId = await reportSignature(record)
    if (!signatureId) return reply.status(503).send({ error: 'unavailable' })
    const account = await reportAccount(who.userId)
    const [row] = await db.insert(errorReports).values({
      signatureId,
      userId: account?.id ?? null,
      description: checked.description,
      payload: { v: 1, release: checked.release, description: checked.description, event: boundEvent(checked.event), ...(shot ? { screenshot: { type: shot.contentType } } : {}) },
      release: checked.release,
    }).returning({ id: errorReports.id })
    await db.execute(sql`UPDATE error_signatures SET user_reports = user_reports + 1 WHERE id = ${signatureId}`)
    forgetPromptFacts(record.hash)
    let screenshot: 'kept' | 'not_kept' | null = null
    if (shot) {
      const trust = account && !account.trial ? 'user' : 'anon'
      screenshot = 'not_kept'
      if (await takeScreenshotBudget({ ipHash: ctx.ipHash, userHash: account ? errorUserHash(account.id) : null, trust }, shot.data.length)) {
        try {
          const key = await storeScreenshot(row.id, shot)
          await db.update(errorReports).set({ screenshotKey: key, screenshotType: shot.contentType, screenshotBytes: shot.data.length }).where(eq(errorReports.id, row.id))
          screenshot = 'kept'
        } catch (err) {
          console.error('[errors] storing a report screenshot failed:', err instanceof Error ? err.message : err)
        }
      }
    }
    const emailed = await sendReportAck(account).catch(() => false)
    return reply.status(201).send({ received: true, emailed, screenshot })
  })
}
