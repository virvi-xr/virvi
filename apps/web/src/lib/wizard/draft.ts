/**
 * A trial's wizard draft, kept in this browser only (the server keeps nothing until sign-up or deploy). It lasts 14 days,
 * like the trial. Every storage call is guarded: blocked or missing storage just means no draft.
 */
import type { WizardState } from './state'

export const DRAFT_KEY = 'virvi.wizard.draft'
/** Bump when `WizardState` changes shape: older drafts are then dropped instead of loaded. */
const DRAFT_VERSION = 1
const DRAFT_LIFE_MS = 14 * 86_400_000

export function saveDraft(state: WizardState, now: number): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: DRAFT_VERSION, at: now, state: { ...state, notice: null } }))
  } catch {}
}

/** The saved draft, or null when there is none, it can't be read, it is of another version, or it is older than 14 days. */
export function loadDraft(now: number): WizardState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (d?.v !== DRAFT_VERSION || typeof d.at !== 'number' || now - d.at > DRAFT_LIFE_MS) return null
    const s = d.state
    if (!s || typeof s !== 'object' || typeof s.step !== 'string' || !s.destinations || !Array.isArray(s.items)) return null
    return s as WizardState
  } catch {
    return null
  }
}

export function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY) } catch {}
}
