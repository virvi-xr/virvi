import { sql } from 'drizzle-orm'
import { promptDecision, KNOWN_MIN_REPORTS, PROMPT_INTERVAL_MS, type PromptFacts, type PromptKind } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { errorUserHash } from './user-hash.js'

/**
 * "Should I ask?" (LIV-66 §4). The browser asks after an error broke something the user was doing; the answer comes
 * from what the signature already has (descriptions since its last fix, an open Linear issue) and, for an account,
 * its prompt state here (asked in the last 24 hours, prompts turned off, "we know about this" already shown). Guests
 * and trials get the facts and keep their own state in the browser. Asking never makes a signature or counts an event.
 */

const rowsOf = <T>(r: unknown) => r as unknown as T[]

/** A signature's facts are cached this long per instance (a report clears its entry). */
export const FACTS_TTL_MS = 60_000
const MAX_CACHED = 5000
const cache = new Map<string, { at: number; id: string | null; facts: PromptFacts }>()

export function resetPromptFacts(): void {
  cache.clear()
}
export function forgetPromptFacts(hash: string): void {
  cache.delete(hash)
}

/** What the signature with this hash has, or nothing yet (it may not be written: then it lacks context). */
export async function signatureFacts(hash: string, expected: boolean, now = Date.now()): Promise<{ id: string | null; facts: PromptFacts }> {
  const hit = cache.get(hash)
  if (hit && now - hit.at < FACTS_TTL_MS) return { id: hit.id, facts: { ...hit.facts, expected: expected || hit.facts.expected } }
  const [row] = rowsOf<{ id: string; expected: string | null; open_issue: boolean; reports: number }>(await db.execute(sql`
    SELECT s.id, s.expected, (s.linear_issue_id IS NOT NULL AND s.resolved_at IS NULL) AS open_issue,
      (SELECT count(*) FROM (SELECT 1 FROM error_reports r WHERE r.signature_id = s.id
        AND r.created_at > coalesce(s.resolved_at, s.regressed_at, '-infinity'::timestamptz) LIMIT ${KNOWN_MIN_REPORTS}) x)::int AS reports
    FROM error_signatures s WHERE s.hash = ${hash}`))
  const facts: PromptFacts = row
    ? { expected: !!row.expected, reports: Number(row.reports), openIssue: !!row.open_issue }
    : { expected: false, reports: 0, openIssue: false }
  if (cache.size >= MAX_CACHED) cache.clear()
  cache.set(hash, { at: now, id: row?.id ?? null, facts })
  return { id: row?.id ?? null, facts: { ...facts, expected: expected || facts.expected } }
}

export interface PromptAnswer {
  prompt: PromptKind
  /** The account's state was applied (and updated) here; false for guests and trials, which apply their own. */
  saved: boolean
  signature: string
  facts: PromptFacts
}

/**
 * The answer for one error. For an account, "ask" is taken atomically (two tabs asking at once are asked once) and a
 * "known" is marked shown, both only while the account exists; a deleted account's token is answered like a guest's.
 */
export async function promptFor(
  e: { hash: string; expected: boolean; userFacing: boolean }, accountId: string | null, now = new Date(),
): Promise<PromptAnswer> {
  const { id, facts } = await signatureFacts(e.hash, e.expected, now.getTime())
  const base = { signature: e.hash, facts }
  const empty = { askedAt: null, optedOut: false, knownShown: false }
  if (!accountId) return { ...base, prompt: promptDecision(e.userFacing, facts, empty, now.getTime()), saved: false }

  const userHash = errorUserHash(accountId)
  const [st] = rowsOf<{ exists: boolean; asked_at: string | null; opted_out: boolean | null; known: boolean }>(await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM users WHERE id = ${accountId}::uuid) AS exists,
      (SELECT asked_at FROM error_prompt_state WHERE user_id = ${accountId}::uuid) AS asked_at,
      (SELECT opted_out FROM error_prompt_state WHERE user_id = ${accountId}::uuid) AS opted_out,
      ${id ? sql`EXISTS (SELECT 1 FROM error_prompt_known WHERE signature_id = ${id}::uuid AND user_hash = ${userHash})` : sql`false`} AS known`))
  if (!st?.exists) return { ...base, prompt: promptDecision(e.userFacing, facts, empty, now.getTime()), saved: false }
  const state = { askedAt: st.asked_at ? new Date(st.asked_at).getTime() : null, optedOut: !!st.opted_out, knownShown: !!st.known }
  let prompt = promptDecision(e.userFacing, facts, state, now.getTime())
  if (prompt === 'ask') {
    const since = new Date(now.getTime() - PROMPT_INTERVAL_MS).toISOString()
    const took = rowsOf<{ user_id: string }>(await db.execute(sql`
      INSERT INTO error_prompt_state (user_id, asked_at, updated_at)
      SELECT ${accountId}::uuid, ${now.toISOString()}::timestamptz, NOW() WHERE EXISTS (SELECT 1 FROM users WHERE id = ${accountId}::uuid)
      ON CONFLICT (user_id) DO UPDATE SET asked_at = excluded.asked_at, updated_at = NOW()
        WHERE NOT error_prompt_state.opted_out AND (error_prompt_state.asked_at IS NULL OR error_prompt_state.asked_at <= ${since}::timestamptz)
      RETURNING user_id`))
    // Another tab took it a moment ago: as if asked just now
    if (!took.length) prompt = promptDecision(e.userFacing, facts, { ...state, askedAt: now.getTime() }, now.getTime())
  }
  if (prompt === 'known') {
    const marked = id ? rowsOf<{ signature_id: string }>(await db.execute(sql`
      INSERT INTO error_prompt_known (signature_id, user_hash) VALUES (${id}::uuid, ${userHash})
      ON CONFLICT DO NOTHING RETURNING signature_id`)) : []
    if (!marked.length) prompt = 'none'
  }
  return { ...base, prompt, saved: true }
}

/** Whether this account is asked about errors (the settings toggle). */
export async function getAskAboutErrors(userId: string): Promise<boolean> {
  const [row] = rowsOf<{ opted_out: boolean }>(await db.execute(sql`SELECT opted_out FROM error_prompt_state WHERE user_id = ${userId}::uuid`))
  return !row?.opted_out
}

export async function setAskAboutErrors(userId: string, ask: boolean): Promise<void> {
  await db.execute(sql`
    INSERT INTO error_prompt_state (user_id, opted_out, updated_at)
    SELECT ${userId}::uuid, ${!ask}, NOW() WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId}::uuid)
    ON CONFLICT (user_id) DO UPDATE SET opted_out = excluded.opted_out, updated_at = NOW()`)
}
