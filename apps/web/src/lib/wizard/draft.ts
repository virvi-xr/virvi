/**
 * A trial's wizard draft, kept in this browser only (the server keeps nothing until sign-up or deploy). It belongs to the
 * trial that made it: only that trial, or the account it became, loads it; anyone else signing in on this browser drops it.
 * It lasts 14 days from when it was started (saving again doesn't extend it), like the trial. Every storage call is
 * guarded: blocked or missing storage just means no draft.
 */
import type { WizardState } from './state'

export const DRAFT_KEY = 'virvi.wizard.draft'
/** Bump when `WizardState` or the stored shape changes: older drafts are then dropped instead of loaded. */
const DRAFT_VERSION = 2
const DRAFT_LIFE_MS = 14 * 86_400_000

interface Stored { v: number; at: number; owner: string; state: WizardState }

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (d?.v !== DRAFT_VERSION || typeof d.at !== 'number' || typeof d.owner !== 'string' || !d.owner) return null
    const s = d.state
    if (!s || typeof s !== 'object' || typeof s.step !== 'string' || !s.destinations || !Array.isArray(s.items)) return null
    return d as Stored
  } catch {
    return null
  }
}

function write(d: Stored): void {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)) } catch {}
}

/**
 * Keeps `owner`'s draft; its start time stays as it was. Another owner's draft is never overwritten (a late save from a
 * trial whose draft was just handed to its account would take it back); loading drops a draft that isn't yours first.
 */
export function saveDraft(state: WizardState, now: number, owner: string): void {
  const prev = read()
  if (prev && prev.owner !== owner) return
  write({ v: DRAFT_VERSION, at: prev ? prev.at : now, owner, state: { ...state, notice: null } })
}

/**
 * `userId`'s draft, or null when there is none, it can't be read, it is of another version, or it is older than 14 days.
 * A draft of someone else is dropped.
 */
export function loadDraft(now: number, userId: string): WizardState | null {
  const d = read()
  if (!d || d.owner !== userId || now - d.at > DRAFT_LIFE_MS) {
    clearDraft()
    return null
  }
  return d.state
}

/** Hands `fromId`'s draft to `toId` (the account a trial became). Any other draft is left alone. */
export function adoptDraft(fromId: string, toId: string): void {
  const d = read()
  if (d && d.owner === fromId) write({ ...d, owner: toId })
}

/**
 * After a sign-up or sign-in: when it carried a trial into the account (`trialCarried`), the trial's draft goes with it.
 * A plain sign-in leaves it with the trial, so the account never sees it.
 */
export function adoptDraftOnSignIn(prev: { id: string; trial?: boolean } | null, next: { id: string; trial?: boolean }, trialCarried: boolean): void {
  if (prev?.trial && !next.trial && trialCarried) adoptDraft(prev.id, next.id)
}

export function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY) } catch {}
}
