/**
 * The dashboard privacy notice (GDPR notice) in the web app: the account's decision, shared by the prompt
 * (<PrivacyGate/>), the Settings row and error reporting (<ErrorReporting/>), so a decision made in one place reaches
 * the others at once. Mirrors GET /api/auth/privacy.
 */
import { useEffect, useState } from 'react'
import type { PrivacyDecision, PrivacyStatus } from '@virvixr/shared'

/** Whether the notice should be up: the status has loaded and holds no decision on the notice in force. */
export function privacyPromptOpen(status: PrivacyStatus | null): boolean {
  return !!status && status.decision === null
}

/** How the Settings row describes the choice. */
export function privacyChoiceLabel(status: PrivacyStatus | null): string {
  if (!status) return 'Loading…'
  if (!status.decision) return "You haven't chosen yet. Error reporting is paused until you do."
  const when = status.decidedAt ? ` on ${new Date(status.decidedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : ''
  return status.decision === 'accept'
    ? `On: you allowed browser error reporting${when}.`
    : `Off: you declined browser error reporting${when}.`
}

/** The other choice, for the Settings row's button. */
export const otherDecision = (d: PrivacyDecision | null): PrivacyDecision => (d === 'accept' ? 'decline' : 'accept')

/** The admin user list's Terms cell: agreed to the Terms in force (and when), an older version, or never. */
export function adminTermsLabel(t: { accepted: boolean; acceptedVersion: string | null; acceptedAt?: string | null } | undefined): string {
  if (!t) return 'Terms: -'
  if (t.accepted) return `Terms: agreed${t.acceptedAt ? ` ${new Date(t.acceptedAt).toLocaleDateString()}` : ''}`
  return t.acceptedVersion ? `Terms: agreed to ${t.acceptedVersion} only` : 'Terms: not agreed'
}

/** The admin user list's privacy cell (GDPR notice): the account's current choice and when it was made. */
export function adminPrivacyLabel(p: PrivacyStatus | undefined): string {
  if (!p || !p.decision) return 'Privacy: not chosen'
  return `Privacy: ${p.decision === 'accept' ? 'accepted' : 'declined'}${p.decidedAt ? ` ${new Date(p.decidedAt).toLocaleString()}` : ''}`
}

// ── The shared status ──────────────────────────────────────────────────────

type Entry = { userId: string; status: PrivacyStatus }
let current: Entry | null = null
let loading: { userId: string; p: Promise<void> } | null = null
const listeners = new Set<() => void>()

/** Record a status fetched or returned by a decision, for everyone showing this account's choice. */
export function setPrivacyStatus(userId: string, status: PrivacyStatus): void {
  current = { userId, status }
  for (const fn of listeners) fn()
}

/** Test hook. */
export function resetPrivacyStatus(): void {
  current = null
  loading = null
}

/**
 * The account's privacy status: null until it loads (or for no account). Fetched once per account per page; a failed
 * fetch stays null, so error reporting keeps holding and the prompt doesn't show.
 */
export function usePrivacyStatus(userId: string | null, load: () => Promise<PrivacyStatus>): PrivacyStatus | null {
  const read = () => (userId && current?.userId === userId ? current.status : null)
  const [status, setStatus] = useState<PrivacyStatus | null>(read)
  useEffect(() => {
    const update = () => setStatus(read())
    listeners.add(update)
    update()
    if (userId && current?.userId !== userId && loading?.userId !== userId) {
      const p = load().then((s) => setPrivacyStatus(userId, s), () => {}).finally(() => { if (loading?.p === p) loading = null })
      loading = { userId, p }
    }
    return () => { listeners.delete(update) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])
  return status
}
