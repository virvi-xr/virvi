import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sql } from 'drizzle-orm'
import { checkErrorBatch, checkErrorReport, parseUserAgent, ERROR_LIMITS } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { errorReports } from '../db/schema.js'
import { config } from '../config.js'
import { clientRecord, recordClientEvents, reportSignature } from '../errors/record.js'
import { errorIpHash, errorUserHash } from '../errors/user-hash.js'
import { ERROR_BUDGETS, ipKey, takeReport } from '../errors/limits.js'

/**
 * Error reports from the web app (LIV-66). Public: guests, trials and signed-in users all report. An optional bearer
 * only says who to count (hashed); a client-sent user, org or browser is never read. Rate limited per address
 * (request.ip, which respects TRUST_PROXY_HOPS). Neither route reports its own failures.
 */

/** Per address (IPv4, or IPv6 by /64) per minute. */
const byAddress = (request: FastifyRequest) => ipKey(request.ip)
export const ERROR_INGEST_RATE_LIMIT = { max: 60, timeWindow: '1 minute', keyGenerator: byAddress }
export const ERROR_REPORT_RATE_LIMIT = { max: 10, timeWindow: '1 minute', keyGenerator: byAddress }

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

  // A crash screen's Report: what the user was doing, attached to the error's signature with their account (they chose
  // to send it). The payload stored is exactly what the form's "What we'll send" preview showed.
  app.post('/api/errors/reports', {
    bodyLimit: ERROR_LIMITS.maxBodyBytes,
    logLevel: 'warn',
    config: { rateLimit: ERROR_REPORT_RATE_LIMIT },
  }, async (request, reply) => {
    const checked = checkErrorReport(request.body, Date.now())
    if (!checked.ok) return reply.status(400).send({ error: checked.error })
    const { who, ctx } = await contextOf(request, checked.release)
    if (!takeReport(ctx.ipKey)) return reply.status(429).send({ error: 'rate_limited', retryAfter: 3600 })
    // The report's signature, found or made without counting anything: no event, recurrence or affected user
    const record = clientRecord(checked.event, ctx)
    const signatureId = await reportSignature(record)
    if (!signatureId) return reply.status(503).send({ error: 'unavailable' })
    await db.insert(errorReports).values({
      signatureId,
      userId: who.userId,
      description: checked.description,
      payload: { v: 1, release: checked.release, description: checked.description, event: boundEvent(checked.event) },
      release: checked.release,
    })
    await db.execute(sql`UPDATE error_signatures SET user_reports = user_reports + 1 WHERE id = ${signatureId}`)
    return reply.status(201).send({ received: true })
  })
}
