import { sql } from 'drizzle-orm'
import { redactText } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { config } from '../config.js'
import { getLinearClient, isTransientLinearError, linearPaused, noteLinearOk, noteLinearTransient, type LinearClient } from './linear.js'
import { DayBudget, ERROR_BUDGETS } from './limits.js'
import { errorUserHash } from './user-hash.js'
import { getThresholds, type Thresholds } from './settings.js'
import { findSpikes } from './spikes.js'
import { signatureDetail, USER_ROW, type SignatureDetail } from './queries.js'

/**
 * Filing errors as Linear bugs (LIV-66 §3). Off unless LINEAR_API_KEY and LINEAR_TEAM_ID are set (linear.ts) and the
 * Errors page's `filing` threshold is on. One issue per signature: later passes add a daily update comment while it is
 * active, a note when it comes back after being marked fixed, and a note once it has been quiet for quietDays after
 * that. A person still closes the issue.
 */

export type FilingReason = 'new' | 'severe' | 'spike' | 'regression' | 'report'

export interface FilingStats {
  source: 'web' | 'server'
  expected: string | null
  kind: string
  status: number | null
  /** First seen in the last 7 days. */
  isNew: boolean
  usersSinceFirstSeen: number
  /** The most users, distinct addresses and events in the current or the last full hour. */
  hourUsers: number
  hourIps: number
  hourCount: number
  /** Distinct users and addresses in the last 24 hours. */
  dayUsers: number
  dayIps: number
  spiking: boolean
  /** Came back after being marked fixed, and not marked fixed again. */
  regressed: boolean
}

const SEVERE_KINDS = new Set(['crash', 'exception', 'rejection', 'server_exception', 'server_5xx'])

/**
 * Why a signature with no issue yet should get one, or null. Expected 4xx are filed only as a spike; overflow never.
 * What one browser alone can claim never files: a browser error needs a signed-in user or two addresses in the last
 * day, and it is severe by distinct users or addresses, never by the counts browsers send.
 */
export function filingReason(s: FilingStats, t: Thresholds): FilingReason | null {
  if (!t.filing || s.expected === 'overflow') return null
  const web = s.source === 'web'
  if (web && s.dayUsers < 1 && s.dayIps < 2) return null
  if (s.spiking) return 'spike'
  if (s.expected) return null
  if (s.regressed) return 'regression'
  if (s.isNew && s.usersSinceFirstSeen >= t.newMinUsers) return 'new'
  const severe = SEVERE_KINDS.has(s.kind) || (s.status ?? 0) >= 500
  if (!severe) return null
  if (web ? s.hourUsers >= t.severeMinUsers || s.hourIps >= t.severeMinUsers : s.hourUsers >= t.severeMinUsers || s.hourCount >= t.severeMinCount) return 'severe'
  return null
}

/** LIV-51 hook: called with each newly filed issue (its agent run will start here). No-op until LIV-51 exists. */
export type IssueFiledHook = (e: { signatureId: string; issueId: string; issueKey: string; url: string; reason: FilingReason }) => void | Promise<void>
let onIssueFiled: IssueFiledHook = () => {}
export function setOnErrorIssueFiled(hook: IssueFiledHook | null): void {
  onIssueFiled = hook ?? (() => {})
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`
const rowsOf = <T>(r: unknown) => r as unknown as T[]

const REASON_TEXT: Record<FilingReason, string> = {
  new: 'a new error that has reached several users',
  severe: 'a server error or crash happening to several users, or many times, in an hour',
  spike: 'running at several times its usual rate for this hour of the week',
  regression: 'it came back after it was marked fixed',
  report: 'a signed-in user reported it (and it has real events)',
}

const fence = (s: string) => '```\n' + s.replace(/```/g, "'''") + '\n```'

/** The issue's title and description: counts, first and last seen, timeline, breakdowns, example events and request IDs. */
export function issueContent(d: SignatureDetail, reason: FilingReason, extra: { usual?: number } = {}): { title: string; description: string } {
  const s = d.signature
  // A report with no error (the help menu) is a bug report of its page
  const title = (s.kind === 'report' ? `Bug report: ${s.signature.replace(/^report /, '')}` : `Error: ${s.signature}`).slice(0, 200)
  const lines: string[] = []
  lines.push(`Filed automatically by Virvi error reporting: ${REASON_TEXT[reason]}${reason === 'spike' && extra.usual !== undefined ? ` (usually ${extra.usual.toFixed(1)} an hour)` : ''}.`, '')
  lines.push('**Signature**', fence(s.signature), '')
  lines.push(`**Counts:** ${s.totalCount} in all · ${d.totals.day} in the last 24 hours · ${d.totals.week} in the last 7 days · ${d.totals.usersWeek} users affected in the last 7 days`)
  lines.push(`**First seen:** ${s.firstSeenAt} (release ${s.firstRelease ?? 'unknown'}) · **Last seen:** ${s.lastSeenAt} (release ${s.lastRelease ?? 'unknown'})`)
  lines.push(`**Started in release:** ${s.firstRelease ?? 'unknown'}`, '')
  const last24 = d.timeline.filter((h) => new Date(h.hour).getTime() >= Date.now() - DAY)
  lines.push('### Timeline (last 24 hours, UTC)')
  lines.push(last24.length ? last24.map((h) => `- ${h.hour.slice(0, 13)}:00 — ${h.count} (${h.users} users)`).join('\n') : '- none in the last 24 hours', '')
  lines.push(`### Breakdowns (last ${d.days} days)`)
  for (const [dim, label] of [['release', 'Release'], ['route', 'Route'], ['browser', 'Browser'], ['os', 'OS'], ['org', 'Organization']] as const) {
    const b = (d.breakdowns as Record<string, Array<{ value: string; count: number }>>)[dim] ?? []
    lines.push(`- **${label}:** ${b.length ? b.slice(0, 5).map((x) => `${x.value} (${x.count})`).join(', ') : '—'}`)
  }
  lines.push(`- **Hour of day (UTC):** ${d.hourOfDay.map((n, h) => (n ? `${h}h ${n}` : null)).filter(Boolean).join(', ') || '—'}`, '')
  lines.push('### Example events')
  for (const [i, e] of d.events.slice(0, 3).entries()) {
    lines.push(`**${i + 1}.** ${e.occurredAt} · ${e.source} · ${e.route ?? ''} · ${[e.browser, e.os].filter(Boolean).join(' / ')} · release ${e.release ?? '?'}${e.requestId ? ` · request \`${e.requestId}\`` : ''}`)
    if (e.message) lines.push(fence(`${e.errorType ?? 'Error'}: ${e.message}${e.stack ? `\n${e.stack.split('\n').slice(0, 6).join('\n')}` : ''}`))
    const crumbs = (e.breadcrumbs as Array<{ type: string; path?: string; label?: string; method?: string; status?: number; ms?: number }>) ?? []
    if (crumbs.length) {
      lines.push('Breadcrumbs:')
      lines.push(crumbs.slice(-15).map((c) => `- ${c.type}: ${c.type === 'api' ? `${c.method} ${c.path} → ${c.status} (${c.ms}ms)` : c.type === 'click' ? c.label : c.path}`).join('\n'))
    }
    lines.push('')
  }
  lines.push('### Request IDs', d.requestIds.length ? d.requestIds.slice(0, 10).map((r) => `\`${r}\``).join(', ') : '—', '')
  // Each user report is added as its own comment, with the account that sent it (postReports)
  if (d.reports.length) lines.push(`### User reports`, `${d.signature.userReports} so far; each is added below as a comment.`)
  return { title, description: lines.join('\n') }
}

async function candidateStats(now: Date, spikes: Set<string>): Promise<Array<FilingStats & { id: string }>> {
  const h0 = new Date(Math.floor(now.getTime() / HOUR) * HOUR)
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT s.id, s.source, s.expected, s.kind, s.status, s.first_seen_at, s.regressed_at, s.resolved_at,
      (SELECT count(DISTINCT user_hash) FROM error_hourly_users u WHERE u.signature_id = s.id AND ${USER_ROW})::int AS users_since,
      (SELECT count(DISTINCT user_hash) FILTER (WHERE ${USER_ROW}) FROM error_hourly_users u WHERE u.signature_id = s.id AND u.hour >= ${ts(new Date(now.getTime() - DAY))})::int AS day_users,
      (SELECT count(DISTINCT user_hash) FILTER (WHERE NOT ${USER_ROW}) FROM error_hourly_users u WHERE u.signature_id = s.id AND u.hour >= ${ts(new Date(now.getTime() - DAY))})::int AS day_ips,
      (SELECT coalesce(max(users), 0) FROM error_hourly h WHERE h.signature_id = s.id AND h.hour >= ${ts(new Date(h0.getTime() - HOUR))})::bigint AS hour_users,
      (SELECT coalesce(max(ips), 0) FROM error_hourly h WHERE h.signature_id = s.id AND h.hour >= ${ts(new Date(h0.getTime() - HOUR))})::bigint AS hour_ips,
      (SELECT coalesce(max(count), 0) FROM error_hourly h WHERE h.signature_id = s.id AND h.hour >= ${ts(new Date(h0.getTime() - HOUR))})::bigint AS hour_count
    FROM error_signatures s
    WHERE s.linear_issue_id IS NULL AND (s.linear_filing_at IS NULL OR s.linear_filing_at < ${ts(new Date(now.getTime() - CLAIM_MS))})
      AND (s.last_seen_at >= ${ts(new Date(now.getTime() - 2 * HOUR))} OR (s.regressed_at IS NOT NULL AND s.resolved_at IS NULL))`))
  return rows.map((r) => ({
    id: r.id as string,
    source: r.source === 'server' ? 'server' : 'web',
    expected: (r.expected as string | null) ?? null,
    kind: r.kind as string,
    status: (r.status as number | null) ?? null,
    isNew: new Date(r.first_seen_at as string).getTime() >= now.getTime() - 7 * DAY,
    usersSinceFirstSeen: Number(r.users_since),
    hourUsers: Number(r.hour_users),
    hourIps: Number(r.hour_ips),
    hourCount: Number(r.hour_count),
    dayUsers: Number(r.day_users),
    dayIps: Number(r.day_ips),
    spiking: spikes.has(r.id as string),
    regressed: !!r.regressed_at && !r.resolved_at,
  }))
}

/** A claim on a signature lasts this long: a pass that dies between making the issue and saving it can't make another sooner. */
const CLAIM_MS = DAY

type Issue = { id: string; identifier: string; url: string }
/** Issues made but not yet saved (the save failed): saved first by the next pass on this instance. */
const pendingSaves = new Map<string, { issue: Issue; reason: FilingReason; at: Date; regressed: boolean }>()
export function resetPendingIssueSaves(): void { pendingSaves.clear() }

let dbHook: (() => void) | null = null
/** Test hook: runs before each save of a new issue (throw to make it fail). */
export function setFilingDbHook(fn: (() => void) | null): void { dbHook = fn }

async function saveIssue(signatureId: string, p: { issue: Issue; reason: FilingReason; at: Date; regressed: boolean }): Promise<void> {
  dbHook?.()
  await db.execute(sql`
    UPDATE error_signatures SET linear_issue_id = ${p.issue.id}, linear_issue_key = ${p.issue.identifier}, linear_issue_url = ${p.issue.url},
      linear_filed_at = ${ts(p.at)}, linear_filed_reason = ${p.reason}, linear_commented_at = ${ts(p.at)},
      linear_regression_at = ${p.regressed ? ts(p.at) : null}, linear_filing_at = NULL
    WHERE id = ${signatureId}::uuid`)
}

/**
 * Makes the signature's issue, once (M7b). The signature is claimed first (only if it has no issue and no live claim),
 * so no other pass or instance files it meanwhile. If Linear refuses, the claim is let go; if saving the new issue
 * fails three times, it is kept in memory and saved first by the next pass, and the claim keeps it from being filed
 * again for a day. Null when another pass holds the claim.
 */
async function fileIssue(client: LinearClient, signatureId: string, reason: FilingReason, now: Date, extra: { usual?: number; regressed?: boolean } = {}): Promise<Issue | null> {
  const claimed = rowsOf<{ id: string }>(await db.execute(sql`
    UPDATE error_signatures SET linear_filing_at = ${ts(now)}
    WHERE id = ${signatureId}::uuid AND linear_issue_id IS NULL AND (linear_filing_at IS NULL OR linear_filing_at < ${ts(new Date(now.getTime() - CLAIM_MS))})
    RETURNING id`))
  if (!claimed.length) return null
  let issue: Issue
  try {
    const detail = await signatureDetail(signatureId, now)
    if (!detail) throw new Error('signature is gone')
    issue = await client.createIssue(issueContent(detail, reason, { usual: extra.usual }))
  } catch (err) {
    await db.execute(sql`UPDATE error_signatures SET linear_filing_at = NULL WHERE id = ${signatureId}::uuid`).catch(() => {})
    throw err
  }
  const pending = { issue, reason, at: now, regressed: !!extra.regressed }
  for (let attempt = 0; ; attempt++) {
    try {
      await saveIssue(signatureId, pending)
      break
    } catch (err) {
      if (attempt >= 2) {
        pendingSaves.set(signatureId, pending)
        throw new Error(`made ${issue.identifier} but could not save it (${err instanceof Error ? err.message : err}); the next pass saves it`)
      }
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt))
    }
  }
  // The LIV-51 agent runs on issues the data filed, not on ones a user's report made
  if (reason !== 'report') await Promise.resolve(onIssueFiled({ signatureId, issueId: issue.id, issueKey: issue.identifier, url: issue.url, reason }))
    .catch((err) => console.error('[errors] issue-filed hook failed:', err instanceof Error ? err.message : err))
  return issue
}

/** Report comments per signature a day, and Linear calls for reports per pass (failed ones count). */
export const REPORT_COMMENTS_PER_SIGNATURE_DAY = 5
export const REPORT_COMMENTS_PER_PASS = 50
/** A report not posted within this long (a guest's on a signature that never got an issue) is left stored only. */
const REPORT_POST_DAYS = 30

const mdCode = (s: string) => '`' + s.replace(/[`\n\r]/g, ' ').slice(0, 300) + '`'

/**
 * A report as a Linear comment: the account id that sent it (they chose to send it; the Errors page, for site admins,
 * has the rest), what they said (redacted, quoted) and the page. No name or email goes to Linear.
 */
export function reportComment(r: { description: string; createdAt: string; accountId: string | null; route: string | null; release: string | null; screenshot: boolean; signatureId: string }): string {
  const who = r.accountId ? `account ${mdCode(r.accountId)}` : 'a guest (not signed in)'
  const quoted = redactText(r.description).replace(/\r/g, '').split('\n').map((l) => `> ${l.replace(/^[#>]+/, '')}`).join('\n')
  const lines = [`**User report** from ${who} · ${r.createdAt}${r.release ? ` · release ${r.release}` : ''}`, '', quoted]
  if (r.route) lines.push('', `Page: ${mdCode(r.route)}`)
  lines.push('', `Details${r.screenshot ? ' and the screenshot' : ''} on the Errors page: ${config.publicUrl}/admin/errors?id=${r.signatureId}`)
  return lines.join('\n')
}

type ReportRow = Record<string, unknown>

/**
 * Adds stored reports to their signature's issue as comments (filing on). Only postable reports are read, newest
 * first, so unpostable ones never hold up the rest:
 * - a report on a signature with an issue (at most 5 a day per signature);
 * - an account's report on a signature with no issue that has real events (never a help-menu report with no error,
 *   never an expected or overflow one): it makes the issue, within its own budget of 5 a day in all and 1 a day per
 *   account (ERROR_BUDGETS.reportIssues*), apart from auto-filing's. Past the account's 1 the report is marked skipped.
 * A guest's or trial's report waits for an issue the data files. A report is claimed before it is posted, so it is
 * never posted twice; one Linear refuses for good is marked skipped. At most 50 Linear calls a pass, failed ones
 * included; a transient failure (rate limit, 5xx, network) stops the pass (the caller backs off).
 */
async function postReports(client: LinearClient, now: Date, result: FilingResult): Promise<'ok' | 'stop'> {
  const B = ERROR_BUDGETS
  const issueBudget = await DayBudget.load(['ri:*'], now)
  const canCreate = issueBudget.has('ri:*', B.reportIssuesPerDay)
  const rows = rowsOf<ReportRow>(await db.execute(sql`
    SELECT r.id, r.signature_id, r.description, r.created_at, r.release, r.payload, r.screenshot_key, u.id AS user_id, u.is_trial, s.linear_issue_id
    FROM error_reports r JOIN error_signatures s ON s.id = r.signature_id LEFT JOIN users u ON u.id = r.user_id
    WHERE r.linear_posted_at IS NULL AND r.linear_skipped IS NULL AND r.created_at >= ${ts(new Date(now.getTime() - REPORT_POST_DAYS * DAY))}
      AND (s.linear_issue_id IS NOT NULL OR (${canCreate}::boolean AND u.id IS NOT NULL AND NOT u.is_trial AND s.kind <> 'report'
        AND s.expected IS NULL AND s.total_count > 0 AND (s.linear_filing_at IS NULL OR s.linear_filing_at < ${ts(new Date(now.getTime() - CLAIM_MS))})))
      AND (SELECT count(*) FROM error_reports p WHERE p.signature_id = r.signature_id AND p.linear_posted_at > ${ts(new Date(now.getTime() - DAY))}) < ${REPORT_COMMENTS_PER_SIGNATURE_DAY}
    ORDER BY r.created_at DESC LIMIT 100`))
  const postedToday = new Map<string, number>()
  const issueOf = new Map<string, string>()
  const skip = (id: string, why: string) => db.execute(sql`UPDATE error_reports SET linear_skipped = ${why} WHERE id = ${id}::uuid`)
  let calls = 0
  for (const r of rows) {
    if (calls >= REPORT_COMMENTS_PER_PASS) break
    const sigId = r.signature_id as string
    if ((postedToday.get(sigId) ?? 0) >= REPORT_COMMENTS_PER_SIGNATURE_DAY) continue
    const accountId = r.user_id && !r.is_trial ? (r.user_id as string) : null
    try {
      let issueId = issueOf.get(sigId) ?? ((r.linear_issue_id as string | null) ?? null)
      if (!issueId) {
        if (!accountId) continue
        // The report's own issue budget: 5 a day in all and 1 per account, across instances
        const budget = await DayBudget.load(['ri:*', `ri:u:${errorUserHash(accountId)}`], now)
        if (!budget.has('ri:*', B.reportIssuesPerDay)) continue
        if (!budget.takeAll([['ri:*', B.reportIssuesPerDay], [`ri:u:${errorUserHash(accountId)}`, B.reportIssuesPerAccountDay]])) {
          await skip(r.id as string, 'account_issue_budget')
          continue
        }
        await budget.save()
        calls++
        const issue = await fileIssue(client, sigId, 'report', now)
        if (!issue) continue
        result.filed++
        issueId = issue.id
      }
      issueOf.set(sigId, issueId)
      const claimed = rowsOf<{ id: string }>(await db.execute(sql`
        UPDATE error_reports SET linear_posted_at = ${ts(now)} WHERE id = ${r.id as string}::uuid AND linear_posted_at IS NULL RETURNING id`))
      if (!claimed.length) continue
      const event = ((r.payload as { event?: { route?: string } } | null)?.event) ?? {}
      calls++
      try {
        await client.createComment(issueId, reportComment({
          description: r.description as string, createdAt: new Date(r.created_at as string).toISOString(), accountId,
          route: typeof event.route === 'string' ? event.route : null, release: (r.release as string | null) ?? null, screenshot: !!r.screenshot_key, signatureId: sigId,
        }))
      } catch (err) {
        await db.execute(sql`UPDATE error_reports SET linear_posted_at = NULL WHERE id = ${r.id as string}::uuid`).catch(() => {})
        if (!isTransientLinearError(err)) await skip(r.id as string, 'linear_refused').catch(() => {})
        throw err
      }
      result.comments++
      postedToday.set(sigId, (postedToday.get(sigId) ?? 0) + 1)
    } catch (err) {
      result.failed++
      console.error('[errors] posting a report to Linear failed:', err instanceof Error ? err.message : err)
      if (isTransientLinearError(err)) return 'stop'
    }
  }
  return 'ok'
}

export interface FilingResult { filed: number; comments: number; failed: number; skipped?: 'not_configured' | 'off' | 'backoff' }

/** One pass (jobs.ts runs it every few minutes under a lock). Each signature's failure is logged and skipped. */
export async function runFilingPass(now = new Date(), client: LinearClient | null = getLinearClient()): Promise<FilingResult> {
  if (!client) return { filed: 0, comments: 0, failed: 0, skipped: 'not_configured' }
  const t = await getThresholds()
  if (!t.filing) return { filed: 0, comments: 0, failed: 0, skipped: 'off' }
  // Linear rate-limited us, was down or refused the key: wait before calling again (the Done sync checks it too)
  if (linearPaused(now.getTime())) return { filed: 0, comments: 0, failed: 0, skipped: 'backoff' }
  const result: FilingResult = { filed: 0, comments: 0, failed: 0 }
  /** A transient Linear failure ends the pass and starts the backoff. */
  const stop = (err: unknown) => {
    if (!isTransientLinearError(err)) return false
    noteLinearTransient(now.getTime())
    return true
  }
  // Issues made by an earlier pass whose save failed: saved now, never made again
  for (const [signatureId, p] of [...pendingSaves]) {
    try {
      await saveIssue(signatureId, p)
      pendingSaves.delete(signatureId)
    } catch (err) {
      result.failed++
      console.error('[errors] saving a filed Linear issue failed again:', err instanceof Error ? err.message : err)
    }
  }
  const spikes = await findSpikes(now, t)
  const spikeSet = new Set(spikes.map((s) => s.signatureId))

  const [today] = rowsOf<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM error_signatures WHERE linear_filed_at >= ${ts(new Date(now.getTime() - DAY))} AND linear_filed_reason IS DISTINCT FROM 'report'`))
  let budget = Math.min(t.maxIssuesPerPass, t.maxIssuesPerDay - Number(today.n))
  for (const c of await candidateStats(now, spikeSet)) {
    const reason = filingReason(c, t)
    if (!reason) continue
    if (budget <= 0) break
    budget--
    try {
      const issue = await fileIssue(client, c.id, reason, now, { usual: spikes.find((s) => s.signatureId === c.id)?.usual, regressed: c.regressed })
      if (issue) result.filed++
    } catch (err) {
      result.failed++
      console.error('[errors] filing a Linear issue failed:', err instanceof Error ? err.message : err)
      if (stop(err)) return result
    }
  }

  if ((await postReports(client, now, result)) === 'stop') {
    noteLinearTransient(now.getTime())
    return result
  }

  // Issues already filed: regression notes, a daily update while active, and the quiet note
  const filed = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT id, linear_issue_id, last_seen_at, resolved_at, regressed_at, linear_filed_at, linear_commented_at, linear_quiet_at, linear_regression_at
    FROM error_signatures WHERE linear_issue_id IS NOT NULL AND linear_filed_at < ${ts(now)}`))
  for (const s of filed) {
    const id = s.id as string
    const issueId = s.linear_issue_id as string
    const at = (k: string) => (s[k] ? new Date(s[k] as string).getTime() : null)
    try {
      const regressed = at('regressed_at')
      if (regressed && !s.resolved_at && regressed > (at('linear_regression_at') ?? at('linear_filed_at') ?? 0)) {
        await client.createComment(issueId, `This error came back at ${new Date(regressed).toISOString()}, after it was marked fixed.`)
        await db.execute(sql`UPDATE error_signatures SET linear_regression_at = ${ts(now)} WHERE id = ${id}::uuid`)
        result.comments++
      }
      const lastComment = at('linear_commented_at') ?? at('linear_filed_at') ?? 0
      if ((at('last_seen_at') ?? 0) >= now.getTime() - DAY && lastComment <= now.getTime() - DAY) {
        const d = await signatureDetail(id, now)
        if (d) {
          await client.createComment(issueId, `Daily update: ${d.totals.day} in the last 24 hours (${d.totals.week} in 7 days, ${d.totals.usersWeek} users). Last seen ${d.signature.lastSeenAt} in release ${d.signature.lastRelease ?? 'unknown'}.`)
          await db.execute(sql`UPDATE error_signatures SET linear_commented_at = ${ts(now)} WHERE id = ${id}::uuid`)
          result.comments++
        }
      }
      const resolved = at('resolved_at')
      if (resolved && resolved <= now.getTime() - t.quietDays * DAY && (at('linear_quiet_at') ?? 0) < resolved) {
        await client.createComment(issueId, `Quiet: no events for ${t.quietDays} days since it was marked fixed. A person can close this issue.`)
        await db.execute(sql`UPDATE error_signatures SET linear_quiet_at = ${ts(now)} WHERE id = ${id}::uuid`)
        result.comments++
      }
    } catch (err) {
      result.failed++
      console.error('[errors] updating a Linear issue failed:', err instanceof Error ? err.message : err)
      if (stop(err)) return result
    }
  }
  noteLinearOk()
  return result
}
