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

/** A visitor id shaped like a wallet: only a signed request may decide for it. */
export const isWalletShaped = (visitorId: string) => /^0x[0-9a-f]{40}$/i.test(visitorId)

/**
 * The one key a request decides, looks up and is enforced under: `w:<signer>` when it was signed, else `g:<visitor id>`.
 * The two never cross, so the consent routes and ingest always read the same key for the same request. The consent
 * routes refuse an unsigned request for a wallet-shaped visitor id (no one may decide for someone else's wallet), so
 * no `g:` row for a wallet is ever written.
 */
export function consentSubject(signer: string | null, visitorId: string): string {
  return signer ? hmac(`w:${signer.toLowerCase()}`) : hmac(`g:${visitorId.toLowerCase()}`)
}

/** The keys a verified wallet's data-deletion request covers: its own, and any guest-keyed rows under its address. */
export const walletSubjects = (wallet: string) => [hmac(`w:${wallet.toLowerCase()}`), hmac(`g:${wallet.toLowerCase()}`)]

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
