/**
 * Privacy notices and the decisions people make on them (GDPR notice, 2026-11-24).
 *
 * Two notices, each with its own version: raise a version only when what the notice says changes enough that people
 * must decide again. Every decision is logged on the server with the version it was made on.
 */

/**
 * The scene visitor notice: Virvi records how visitors use a scene under a pseudonym. One decision covers every Virvi
 * scene; a visitor is asked again only when this goes up.
 */
export const ANALYTICS_CONSENT_VERSION = 1

/** A visitor's or an account's answer to a notice. */
export type PrivacyDecision = 'accept' | 'decline'

export const PRIVACY_DECISIONS: readonly PrivacyDecision[] = ['accept', 'decline']

export const isPrivacyDecision = (v: unknown): v is PrivacyDecision => v === 'accept' || v === 'decline'

/** Where the visitor notice's Privacy link goes. */
export const VISITOR_PRIVACY_URL = 'https://virvi.io/privacy/'

/** The visitor notice's words (the HUD card shows them above Accept and Decline). */
export const ANALYTICS_CONSENT_TEXT =
  'This scene uses Virvi, which records how visitors use it (where you walk, what you click, videos you play) under a ' +
  "pseudonym, to give the host statistics. No wallet address is stored unless the host turns that on, and you'll be " +
  'told if they do.'

/** GET/POST /api/analytics/consent: the visitor's decision on the notice in force, or null when they haven't made one. */
export interface AnalyticsConsentStatus {
  version: number
  decision: PrivacyDecision | null
}

/**
 * The dashboard notice: Virvi stores account details and what people build, and, with their OK, records browser errors
 * and the pages visited just before them. Each account is asked once per version.
 */
export const PRIVACY_NOTICE_VERSION = 1

/** How an account's privacy decision was made: the dashboard prompt, or the Settings row. */
export type PrivacyDecisionVia = 'prompt' | 'settings'

/** GET/POST /api/auth/privacy: the account's decision on the notice in force (null: not made yet), and when. */
export interface PrivacyStatus {
  version: number
  decision: PrivacyDecision | null
  decidedAt: string | null
}
