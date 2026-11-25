import { createHmac } from 'node:crypto'
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm'
import { ANALYTICS_CONSENT_VERSION, type AnalyticsConsentStatus, type PrivacyDecision } from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { analyticsConsents } from '../db/schema.js'

/**
 * Scene visitors' decisions on the analytics notice (GDPR notice). One decision covers every Virvi scene, so it's kept
 * under a cross-scene key, deliberately apart from the per-scene analytics pseudonym (hash.ts): an HMAC of `w:<wallet>`
 * for a signed (verified) request, else `g:<visitor id>` for a guest or any unsigned request. The HMAC key is derived from
 * JWT_SECRET with a fixed label (never JWT_SECRET itself), as BEAT_NETWORK_HASH_SECRET's default is; rotating
 * JWT_SECRET forgets every decision, so visitors are asked again. No raw wallet or guest id is stored or logged here.
 */

const SUBJECT_KEY = createHmac('sha256', config.jwtSecret).update('virvi-analytics-consent-subject').digest()

const hmac = (key: string) => createHmac('sha256', SUBJECT_KEY).update(key).digest('hex')

/** The key a decision is recorded and looked up under: the signer when the request was signed, else the visitor id. */
export function consentSubject(signer: string | null, visitorId: string): string {
  return signer ? hmac(`w:${signer.toLowerCase()}`) : hmac(`g:${visitorId.toLowerCase()}`)
}

/**
 * Every key an ingest batch's visitor could have decided under. The decline of any of them stops the batch: an unsigned
 * batch claiming a wallet is dropped when that wallet declined (signed), and a guest's decline holds however the batch
 * came. Dropping more never reveals anything; it only records less.
 */
export function ingestSubjects(signer: string | null, visitorId: string): string[] {
  const ids = new Set([visitorId.toLowerCase(), ...(signer ? [signer.toLowerCase()] : [])])
  return [...ids].flatMap((id) => [hmac(`w:${id}`), hmac(`g:${id}`)])
}

/** The subjects a verified wallet's data-deletion request covers. */
export const walletSubject = (wallet: string) => hmac(`w:${wallet.toLowerCase()}`)

export class StaleConsentError extends Error {
  constructor() { super('This is not the current privacy notice. Update the scene to see it.') }
}

/** The subject's decision on the notice in force: its latest row for ANALYTICS_CONSENT_VERSION, or null. */
export async function consentStatus(subject: string): Promise<AnalyticsConsentStatus> {
  const [row] = await db.select({ decision: analyticsConsents.decision }).from(analyticsConsents)
    .where(and(eq(analyticsConsents.subjectHash, subject), eq(analyticsConsents.version, ANALYTICS_CONSENT_VERSION)))
    .orderBy(desc(analyticsConsents.createdAt), desc(analyticsConsents.id)).limit(1)
  return { version: ANALYTICS_CONSENT_VERSION, decision: (row?.decision as PrivacyDecision | undefined) ?? null }
}

/** Appends a decision; `version` must be the version in force (the notice the visitor was shown). */
export async function recordConsent(input: {
  subject: string; decision: PrivacyDecision; version: unknown; sceneId: string | null; platform: string; now?: Date
}): Promise<void> {
  if (input.version !== ANALYTICS_CONSENT_VERSION) throw new StaleConsentError()
  await db.insert(analyticsConsents).values({
    subjectHash: input.subject, decision: input.decision, version: ANALYTICS_CONSENT_VERSION, sceneId: input.sceneId,
    platform: input.platform, ...(input.now ? { createdAt: input.now } : {}),
  })
}

/** True when any of these subjects' latest decision on the notice in force is `decline` (ingest drops the batch). */
export async function anyDeclined(subjects: string[]): Promise<boolean> {
  if (!subjects.length) return false
  const latest = await db.selectDistinctOn([analyticsConsents.subjectHash], { decision: analyticsConsents.decision })
    .from(analyticsConsents)
    .where(and(inArray(analyticsConsents.subjectHash, subjects), eq(analyticsConsents.version, ANALYTICS_CONSENT_VERSION)))
    .orderBy(analyticsConsents.subjectHash, desc(analyticsConsents.createdAt), desc(analyticsConsents.id))
  return latest.some((r) => r.decision === 'decline')
}

/**
 * A data-deletion request: removes these subjects' decision rows, except one final `decline` per subject whose latest
 * decision (any version) is a decline, so the refusal keeps being honoured. Returns the rows removed.
 */
export async function deleteConsents(subjects: string[]): Promise<number> {
  if (!subjects.length) return 0
  return db.transaction(async (tx) => {
    const keep = await tx.selectDistinctOn([analyticsConsents.subjectHash], { id: analyticsConsents.id, decision: analyticsConsents.decision })
      .from(analyticsConsents)
      .where(inArray(analyticsConsents.subjectHash, subjects))
      .orderBy(analyticsConsents.subjectHash, desc(analyticsConsents.createdAt), desc(analyticsConsents.id))
    const kept = keep.filter((r) => r.decision === 'decline').map((r) => r.id)
    const gone = await tx.delete(analyticsConsents).where(and(
      inArray(analyticsConsents.subjectHash, subjects),
      kept.length ? notInArray(analyticsConsents.id, kept) : undefined,
    )).returning({ id: analyticsConsents.id })
    return gone.length
  })
}
