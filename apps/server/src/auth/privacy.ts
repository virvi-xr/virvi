import { and, desc, eq, inArray } from 'drizzle-orm'
import { PRIVACY_NOTICE_VERSION, isPrivacyDecision, type PrivacyDecision, type PrivacyDecisionVia, type PrivacyStatus } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { privacyDecisions } from '../db/schema.js'

/**
 * The dashboard privacy notice (GDPR notice): each account's decision on optional processing (browser error reporting and
 * its page-visit breadcrumbs), once per PRIVACY_NOTICE_VERSION. Append-only, like the Terms' history: every decision is a
 * new row, and the latest row for the version in force is the account's choice.
 */

export class StalePrivacyError extends Error {
  constructor() { super('This is not the current privacy notice. Reload the page to see it.') }
}

export class BadPrivacyDecisionError extends Error {
  constructor() { super('decision must be accept or decline') }
}

export async function privacyStatus(userId: string): Promise<PrivacyStatus> {
  const [row] = await db.select({ decision: privacyDecisions.decision, at: privacyDecisions.createdAt }).from(privacyDecisions)
    .where(and(eq(privacyDecisions.userId, userId), eq(privacyDecisions.version, PRIVACY_NOTICE_VERSION)))
    .orderBy(desc(privacyDecisions.createdAt), desc(privacyDecisions.id)).limit(1)
  return { version: PRIVACY_NOTICE_VERSION, decision: (row?.decision as PrivacyDecision | undefined) ?? null, decidedAt: row?.at.toISOString() ?? null }
}

/** Records the account's decision on `version`, which must be the notice in force (the one the person was shown). */
export async function recordPrivacyDecision(userId: string, decision: unknown, version: unknown, via: PrivacyDecisionVia): Promise<void> {
  if (!isPrivacyDecision(decision)) throw new BadPrivacyDecisionError()
  if (version !== PRIVACY_NOTICE_VERSION) throw new StalePrivacyError()
  await db.insert(privacyDecisions).values({ userId, decision, version, via })
}

/** privacyStatus for many accounts at once (the admin user list), keyed by user id. */
export async function privacyStatusesFor(userIds: string[]): Promise<Map<string, PrivacyStatus>> {
  const out = new Map<string, PrivacyStatus>(userIds.map((id) => [id, { version: PRIVACY_NOTICE_VERSION, decision: null, decidedAt: null }]))
  if (!userIds.length) return out
  const rows = await db.selectDistinctOn([privacyDecisions.userId], { userId: privacyDecisions.userId, decision: privacyDecisions.decision, at: privacyDecisions.createdAt })
    .from(privacyDecisions)
    .where(and(inArray(privacyDecisions.userId, userIds), eq(privacyDecisions.version, PRIVACY_NOTICE_VERSION)))
    .orderBy(privacyDecisions.userId, desc(privacyDecisions.createdAt), desc(privacyDecisions.id))
  for (const r of rows) out.set(r.userId, { version: PRIVACY_NOTICE_VERSION, decision: r.decision as PrivacyDecision, decidedAt: r.at.toISOString() })
  return out
}
