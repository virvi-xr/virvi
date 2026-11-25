import { and, desc, eq, inArray } from 'drizzle-orm'
import { TERMS_VERSION } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { termsAcceptances } from '../db/schema.js'

/** Whether an account has agreed to the Terms in force, and the last version it agreed to. */
export interface TermsStatus {
  version: string
  accepted: boolean
  acceptedVersion: string | null
}

export class StaleTermsError extends Error {
  constructor() { super('These are not the current Terms of Service. Reload the page to see them.') }
}

export async function termsStatus(userId: string): Promise<TermsStatus> {
  const [last] = await db.select({ version: termsAcceptances.version }).from(termsAcceptances)
    .where(eq(termsAcceptances.userId, userId)).orderBy(desc(termsAcceptances.acceptedAt)).limit(1)
  const [current] = await db.select({ id: termsAcceptances.id }).from(termsAcceptances)
    .where(and(eq(termsAcceptances.userId, userId), eq(termsAcceptances.version, TERMS_VERSION))).limit(1)
  return { version: TERMS_VERSION, accepted: !!current, acceptedVersion: current ? TERMS_VERSION : last?.version ?? null }
}

/** Records that the account agreed to `version`, which must be the version in force (the one the person was shown). */
export async function acceptTerms(userId: string, version: unknown, via: 'sign-up' | 'prompt'): Promise<void> {
  if (version !== TERMS_VERSION) throw new StaleTermsError()
  await db.insert(termsAcceptances).values({ userId, version, via }).onConflictDoNothing()
}

/** termsStatus for many accounts at once (the admin user list), keyed by user id, with when the current Terms were agreed. */
export async function termsStatusesFor(userIds: string[]): Promise<Map<string, TermsStatus & { acceptedAt: string | null }>> {
  const out = new Map<string, TermsStatus & { acceptedAt: string | null }>(
    userIds.map((id) => [id, { version: TERMS_VERSION, accepted: false, acceptedVersion: null, acceptedAt: null }]),
  )
  if (!userIds.length) return out
  const rows = await db.select({ userId: termsAcceptances.userId, version: termsAcceptances.version, at: termsAcceptances.acceptedAt })
    .from(termsAcceptances).where(inArray(termsAcceptances.userId, userIds)).orderBy(termsAcceptances.acceptedAt)
  for (const r of rows) {
    const cur = out.get(r.userId)!
    if (cur.accepted) continue
    out.set(r.userId, r.version === TERMS_VERSION
      ? { version: TERMS_VERSION, accepted: true, acceptedVersion: TERMS_VERSION, acceptedAt: r.at.toISOString() }
      : { ...cur, acceptedVersion: r.version })
  }
  return out
}
