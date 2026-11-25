/**
 * The scene visitor notice (GDPR notice), what the card shows: drawn from the visitor's decision (AnalyticsConsent in
 * @virvixr/core). No Decentraland SDK here, so it is tested on its own; ConsentOverlay.tsx draws it.
 */
import { ANALYTICS_CONSENT_TEXT, VISITOR_PRIVACY_URL, type PrivacyDecision } from '@virvixr/shared'
import type { ConsentState } from '@virvixr/core'

export interface ConsentLike {
  state: ConsentState
  open: boolean
  canClose: boolean
}

export type ConsentAction = 'accept' | 'decline' | 'close' | 'reopen' | 'privacy'

export interface ConsentCard {
  title: string
  body: string
  /** What the visitor chose before, when the notice was reopened from Privacy. */
  current: string | null
  link: string
  actions: Array<{ id: ConsentAction; label: string }>
}

const LINK = `Privacy: ${VISITOR_PRIVACY_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}`

/** The card while the notice is up; else, once a decision is made, the small Privacy entry that shows it again. */
export function consentCardView(c: ConsentLike | null): { card: ConsentCard | null; chip: boolean } {
  if (!c || c.state === 'loading') return { card: null, chip: false }
  if (!c.open) return { card: null, chip: c.state === 'accepted' || c.state === 'declined' }
  const current = !c.canClose ? null : c.state === 'accepted' ? 'You accepted.' : "You declined: Virvi isn't recording your visit."
  return {
    chip: false,
    card: {
      title: 'Privacy',
      body: ANALYTICS_CONSENT_TEXT,
      current,
      link: LINK,
      actions: [
        { id: 'accept', label: 'Accept' },
        { id: 'decline', label: 'Decline' },
        ...(c.canClose ? [{ id: 'close' as const, label: 'Close' }] : []),
      ],
    },
  }
}

/** A press on the card or the Privacy entry. */
export function consentAction(
  a: ConsentAction,
  consent: { decide(d: PrivacyDecision): Promise<void>; reopen(): void; close(): void },
  openUrl: (url: string) => void,
): void {
  if (a === 'accept' || a === 'decline') void consent.decide(a).catch(() => {})
  else if (a === 'reopen') consent.reopen()
  else if (a === 'close') consent.close()
  else openUrl(VISITOR_PRIVACY_URL)
}
