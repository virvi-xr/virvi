import { sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { getLinearClient, type LinearClient } from './linear.js'
import { getThresholds, type Thresholds } from './settings.js'
import { findSpikes } from './spikes.js'
import { signatureDetail, type SignatureDetail } from './queries.js'

/**
 * Filing errors as Linear bugs (LIV-66 §3). Off unless LINEAR_API_KEY and LINEAR_TEAM_ID are set (linear.ts) and the
 * Errors page's `filing` threshold is on. One issue per signature: later passes add a daily update comment while it is
 * active, a note when it comes back after being marked fixed, and a note once it has been quiet for quietDays after
 * that. A person still closes the issue.
 */

export type FilingReason = 'new' | 'severe' | 'spike' | 'regression'

export interface FilingStats {
  expected: string | null
  kind: string
  status: number | null
  /** First seen in the last 7 days. */
  isNew: boolean
  usersSinceFirstSeen: number
  /** The most users / events in the current or the last full hour. */
  hourUsers: number
  hourCount: number
  spiking: boolean
  /** Came back after being marked fixed, and not marked fixed again. */
  regressed: boolean
}

const SEVERE_KINDS = new Set(['crash', 'exception', 'rejection', 'server_exception', 'server_5xx'])

/** Why a signature with no issue yet should get one, or null. Expected 4xx are filed only as a spike. */
export function filingReason(s: FilingStats, t: Thresholds): FilingReason | null {
  if (!t.filing) return null
  if (s.spiking) return 'spike'
  if (s.expected) return null
  if (s.regressed) return 'regression'
  if (s.isNew && s.usersSinceFirstSeen >= t.newMinUsers) return 'new'
  const severe = SEVERE_KINDS.has(s.kind) || (s.status ?? 0) >= 500
  if (severe && (s.hourUsers >= t.severeMinUsers || s.hourCount >= t.severeMinCount)) return 'severe'
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
}

const fence = (s: string) => '```\n' + s.replace(/```/g, "'''") + '\n```'

/** The issue's title and description: counts, first and last seen, timeline, breakdowns, example events and request IDs. */
export function issueContent(d: SignatureDetail, reason: FilingReason, extra: { usual?: number } = {}): { title: string; description: string } {
  const s = d.signature
  const title = `Error: ${s.signature}`.slice(0, 200)
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
  if (d.reports.length) lines.push(`### What users said (${d.reports.length})`, d.reports.slice(0, 5).map((r) => `- ${r.description.replace(/\n/g, ' ')}`).join('\n'))
  return { title, description: lines.join('\n') }
}

async function candidateStats(now: Date, spikes: Set<string>): Promise<Array<FilingStats & { id: string }>> {
  const h0 = new Date(Math.floor(now.getTime() / HOUR) * HOUR)
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT s.id, s.expected, s.kind, s.status, s.first_seen_at, s.regressed_at, s.resolved_at,
      (SELECT count(DISTINCT user_hash) FROM error_hourly_users u WHERE u.signature_id = s.id)::int AS users_since,
      (SELECT coalesce(max(users), 0) FROM error_hourly h WHERE h.signature_id = s.id AND h.hour >= ${ts(new Date(h0.getTime() - HOUR))})::int AS hour_users,
      (SELECT coalesce(max(count), 0) FROM error_hourly h WHERE h.signature_id = s.id AND h.hour >= ${ts(new Date(h0.getTime() - HOUR))})::int AS hour_count
    FROM error_signatures s
    WHERE s.linear_issue_id IS NULL AND (s.last_seen_at >= ${ts(new Date(now.getTime() - 2 * HOUR))} OR (s.regressed_at IS NOT NULL AND s.resolved_at IS NULL))`))
  return rows.map((r) => ({
    id: r.id as string,
    expected: (r.expected as string | null) ?? null,
    kind: r.kind as string,
    status: (r.status as number | null) ?? null,
    isNew: new Date(r.first_seen_at as string).getTime() >= now.getTime() - 7 * DAY,
    usersSinceFirstSeen: Number(r.users_since),
    hourUsers: Number(r.hour_users),
    hourCount: Number(r.hour_count),
    spiking: spikes.has(r.id as string),
    regressed: !!r.regressed_at && !r.resolved_at,
  }))
}

export interface FilingResult { filed: number; comments: number; failed: number; skipped?: 'not_configured' | 'off' }

/** One pass (jobs.ts runs it every few minutes under a lock). Each signature's failure is logged and skipped. */
export async function runFilingPass(now = new Date(), client: LinearClient | null = getLinearClient()): Promise<FilingResult> {
  if (!client) return { filed: 0, comments: 0, failed: 0, skipped: 'not_configured' }
  const t = await getThresholds()
  if (!t.filing) return { filed: 0, comments: 0, failed: 0, skipped: 'off' }
  const result: FilingResult = { filed: 0, comments: 0, failed: 0 }
  const spikes = await findSpikes(now, t)
  const spikeSet = new Set(spikes.map((s) => s.signatureId))

  for (const c of await candidateStats(now, spikeSet)) {
    const reason = filingReason(c, t)
    if (!reason) continue
    try {
      const detail = await signatureDetail(c.id, now)
      if (!detail) continue
      const content = issueContent(detail, reason, { usual: spikes.find((s) => s.signatureId === c.id)?.usual })
      const issue = await client.createIssue(content)
      await db.execute(sql`
        UPDATE error_signatures SET linear_issue_id = ${issue.id}, linear_issue_key = ${issue.identifier}, linear_issue_url = ${issue.url},
          linear_filed_at = ${ts(now)}, linear_filed_reason = ${reason}, linear_commented_at = ${ts(now)},
          linear_regression_at = ${c.regressed ? ts(now) : null}
        WHERE id = ${c.id}::uuid`)
      result.filed++
      await Promise.resolve(onIssueFiled({ signatureId: c.id, issueId: issue.id, issueKey: issue.identifier, url: issue.url, reason }))
        .catch((err) => console.error('[errors] issue-filed hook failed:', err instanceof Error ? err.message : err))
    } catch (err) {
      result.failed++
      console.error('[errors] filing a Linear issue failed:', err instanceof Error ? err.message : err)
    }
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
    }
  }
  return result
}
