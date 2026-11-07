/**
 * What a trial (guest) gets on the scene, import and headset pages (LIV-91 phase 2). Anything not opened here is shown
 * locked and never fetched: each account-only call would answer `account_required` and pop the sign-up sheet on load.
 */
import type { SignUpRequest } from './trial'

/**
 * The scene editor's parts a trial may use: the name, presets and elements (of the trial element types). Every other
 * tab or section (roles, collaborators, destinations, hyperfy, streams, showings, schedules, ar, widgets, ad spaces,
 * moderation, settings, realtime, media names, room sets, …) is locked: unknown keys are locked too.
 */
export const TRIAL_SCENE_TABS: readonly string[] = ['name', 'presets', 'elements', 'model', 'image', 'video', 'sound']

export function sceneTabLocked(tab: string, trial: boolean): boolean {
  return trial && !TRIAL_SCENE_TABS.includes(tab)
}

/** What a locked upload or Media library button names in the sheet ("Create a free account to use <label>."). Both are
 *  account-only (`/api/media`, `/api/media/upload`, `POST /api/assets`) and, like every key not in TRIAL_SCENE_TABS, locked. */
export const TRIAL_LOCK_LABELS = { uploads: 'uploads', 'media-library': 'your Media library' } as const

/** The sign-up sheet a locked tab or section opens. */
export function sceneLockRequest(tab: string, label: string): SignUpRequest {
  return { action: `nav:scene/${tab}`, ctx: { label } }
}

/** A video screen's off types a trial can't pick: ads (4, 5) and scheduled showings (6) are account-only. */
const ACCOUNT_OFF_TYPES = new Set([4, 5, 6])
export function offTypeLocked(offType: number, trial: boolean): boolean {
  return trial && ACCOUNT_OFF_TYPES.has(offType)
}

/** How a headset can be approved: a trial pairs a personal headset only (shared headsets mint passes). */
export function pairChoices(trial: boolean): Array<'personal' | 'shared'> {
  return trial ? ['personal'] : ['personal', 'shared']
}

/** TRIAL_IMPORT_MAX_BYTES's default (the server's config). */
const TRIAL_IMPORT_MAX_BYTES = 26214400

export function importLimitNote(trial: boolean): string | null {
  return trial ? 'Guests can import 2 scenes of up to 25 MB. Create a free account for more.' : null
}

/** The largest zip the import page sends: a trial's cap, never above the account one. */
export function importMaxBytes(trial: boolean, accountMax: number): number {
  return trial ? Math.min(TRIAL_IMPORT_MAX_BYTES, accountMax) : accountMax
}

export const TRIAL_SCENE_NOTE = 'Held for your trial — create an account to keep it'

/** The Scenes page's header buttons. A trial has no blank scene (`POST /api/scenes` is account-only). */
export function sceneListActions(trial: boolean): Array<'blank' | 'import' | 'new'> {
  return trial ? ['import', 'new'] : ['blank', 'import', 'new']
}
