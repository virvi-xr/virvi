// Deleting a scene (LIV-83): what the delete dialog and the Recently deleted list show, and the wallet-signed removals.
// Pure, so the copy and the checkbox rules are tested without a browser.

export type RemovalKind = 'hosted_world' | 'hyperfy_world' | 'dcl_world' | 'dcl_parcels'

/** Something running for the scene that deleting it can shut down or remove (GET /api/scenes/:id/delete-plan). */
export interface RunningItem {
  id: string
  kind: RemovalKind
  label: string
  defaultChecked: boolean
  needsSignature: boolean
  ownContent?: boolean
  /** Why a Decentraland line starts unticked ("Your World now shows a scene Virvi didn't build."). */
  reason?: string
  /** The live entity the dialog showed: sent back with the delete, so nothing else is removed. */
  liveEntityId?: string | null
}

export interface UpcomingEvent {
  id: string
  name: string
  startsAt: string | null
  endsAt: string | null
  kind: 'event' | 'booking'
}

export interface DeletePlan {
  scene: { id: string; name: string }
  purgeAt: string
  running: RunningItem[]
  upcomingEvents: UpcomingEvent[]
}

export interface Removal {
  id: string
  kind: RemovalKind
  label: string
  status: 'pending' | 'awaiting_signature' | 'done' | 'failed' | 'needs_review'
  errorMessage: string | null
  finishedAt: string | null
}

export interface DeleteResult {
  scene: { id: string; name: string; deletedAt: string; purgeAt: string }
  removals: Removal[]
}

export interface DeletedScene {
  id: string
  name: string
  thumbnailUrl: string | null
  orgName: string | null
  orgDeleted: boolean
  deletedAt: string
  purgeAt: string
  removals: Removal[]
}

/** What the owner's wallet signs for a removal (GET .../removals/:id/sign). */
export type RemovalSignRequest =
  | { kind: 'request'; signer: string; request: { payload: string; timestamp: number } }
  | { kind: 'entity'; payload: string; expiresAt: string }

/** The checkboxes as the dialog opens: ticked, except a Decentraland scene that's the owner's own work. */
export function initialChecks(running: RunningItem[]): Record<string, boolean> {
  return Object.fromEntries(running.map((r) => [r.id, r.defaultChecked]))
}

/** The ids the delete asks to remove. */
export function chosenIds(checks: Record<string, boolean>): string[] {
  return Object.entries(checks).filter(([, on]) => on).map(([id]) => id)
}

/** What the dialog showed live on each ticked Decentraland line, for the delete's `seen`. */
export function seenEntities(running: RunningItem[], checks: Record<string, boolean>): Record<string, string | null> {
  return Object.fromEntries(running.filter((r) => checks[r.id] && r.liveEntityId !== undefined).map((r) => [r.id, r.liveEntityId ?? null]))
}

const isDcl = (k: RemovalKind) => k === 'dcl_world' || k === 'dcl_parcels'

/** The line under a checkbox: what ticking (or leaving it unticked) does. */
export function checkboxNote(item: RunningItem, checked: boolean): string {
  if (item.kind === 'hosted_world') {
    return checked
      ? "Shut down for good. It won't come back if you restore the scene."
      : 'Keeps running while the scene is deleted. It carries on if you restore the scene, and shuts down when the scene is deleted for good.'
  }
  if (item.kind === 'hyperfy_world') {
    return checked
      ? 'Virvi stops serving this world. Remove the Virvi app inside Hyperfy as well.'
      : 'Stays connected, but shows nothing from Virvi while the scene is deleted.'
  }
  if (!checked) {
    if (item.reason) return `${item.reason} So it's left as it is: it shows nothing from Virvi while this scene is deleted.`
    return item.ownContent
      ? "What's live there is your own scene, so it's left as it is. It shows nothing from Virvi while this scene is deleted."
      : 'Left up as it is. It shows nothing from Virvi while the scene is deleted.'
  }
  const own = item.ownContent ? `${item.reason ?? "What's live there is your own scene."} Ticking this removes it too. ` : ''
  const where = item.kind === 'dcl_parcels' ? 'An empty scene is published over the parcels' : 'The scene is taken off the World'
  const sign = item.needsSignature ? ', signed with your wallet' : ''
  return `${own}${where}${sign}, and it's disconnected from this scene so you can use it elsewhere. Restoring doesn't bring it back.`
}

const DAY_MS = 24 * 3600_000

/** "8 December 2026". */
export function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** "Deleted for good on 8 December 2026 (in 30 days)"; "today" or "tomorrow" close to it. */
export function purgeDateText(purgeAt: string, now: Date = new Date()): string {
  const days = Math.max(0, Math.ceil((new Date(purgeAt).getTime() - now.getTime()) / DAY_MS))
  const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`
  return `Deleted for good on ${longDate(purgeAt)} (${when})`
}

/** The dialog's warning about upcoming events, or null when there are none. */
export function upcomingWarning(events: UpcomingEvent[]): string | null {
  if (!events.length) return null
  const n = events.length
  return `This scene has ${n === 1 ? 'an upcoming event' : `${n} upcoming events`}. While it's deleted, ${n === 1 ? 'it is' : 'they are'} suspended: bookings don't go live and their crews can't get in.`
}

/** "Opening night, 12 November 2026" (an event with no date: just its name). */
export function eventLine(e: UpcomingEvent): string {
  return e.startsAt ? `${e.name}, ${longDate(e.startsAt)}` : e.name
}

/** The Delete button works only once the scene's name is typed exactly (spaces around it don't count). */
export function nameMatches(typed: string, name: string): boolean {
  return typed.trim() === name.trim() && name.trim() !== ''
}

/** A removal's state, in the dialog's results and the Recently deleted list. */
export function removalStatusText(r: Removal): string {
  switch (r.status) {
    case 'done': return 'Done'
    case 'awaiting_signature': return r.errorMessage ?? 'Waiting for your wallet to sign'
    case 'failed': return r.errorMessage ? `Didn't work: ${r.errorMessage}` : "Didn't work"
    case 'needs_review': return r.errorMessage ?? "What's live there changed, so Virvi left it as it is"
    default: return 'Working…'
  }
}

/** Removals still to do: they get Sign or Retry. */
export const unfinished = (removals: Removal[]) => removals.filter((r) => r.status === 'failed' || r.status === 'awaiting_signature' || r.status === 'needs_review')

/** The toast after a delete: "Deleted Gallery." (Restore is its action). */
export function deletedToast(name: string): string {
  return `Deleted ${name}.`
}

/** The restore confirmation, saying what didn't come back. */
export function restoredNote(name: string, notRestored: Removal[]): string {
  if (!notRestored.length) return `Restored ${name}.`
  const what = notRestored.map((r) => r.kind === 'hosted_world' ? r.label.replace(/^Shut down /, '') : r.label.replace(/^Remove the scene from /, '')).join(', ')
  return `Restored ${name}. What was shut down or removed when you deleted it doesn't come back: ${what}.`
}

/** The restore dialog's line about removals. */
export const RESTORE_NOTE = "Restoring brings the scene back as it was, but not hosted worlds that were shut down or deployments that were removed."

/** The delete dialog's opening line. */
export function deleteIntro(purgeAt: string): string {
  return `The scene, its presets, media placements, events and analytics are kept for 30 days: you can restore it from Recently deleted until ${longDate(purgeAt)}. Your media and assets stay in your libraries.`
}

export interface RemovalSignApi {
  getRemovalSign(sceneId: string, removalId: string): Promise<RemovalSignRequest>
  submitRemovalSignature(sceneId: string, removalId: string, body: { chain: unknown; timestamp?: number }): Promise<{ removal: Removal }>
}

const errorCodeOf = (err: unknown) => (err as { body?: { error?: unknown } } | null)?.body?.error

/**
 * Signs a removal waiting for the owner's wallet and sends it: a World's undeploy (a signed fetch) or the parcels'
 * empty scene. Too slow (expired) asks for a fresh one and signs again once.
 */
export async function signRemoval(sceneId: string, removalId: string, signer: { sign(payload: string): unknown }, api: RemovalSignApi): Promise<Removal> {
  for (let attempt = 0; ; attempt++) {
    const req = await api.getRemovalSign(sceneId, removalId)
    const body = req.kind === 'request'
      ? { chain: signer.sign(req.request.payload), timestamp: req.request.timestamp }
      : { chain: signer.sign(req.payload) }
    try {
      return (await api.submitRemovalSignature(sceneId, removalId, body)).removal
    } catch (err) {
      if (errorCodeOf(err) === 'expired' && attempt < 1) continue
      throw err
    }
  }
}

/** The wallet that must sign a removal, when one must (a World's owner); null: any wallet that controls the parcels. */
export const expectedSigner = (req: RemovalSignRequest): string | null => (req.kind === 'request' ? req.signer : null)

export { isDcl }
