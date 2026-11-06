/**
 * Edit mode's state and wiring, free of Hyperfy nodes. It feeds pointer rays (world space, Hyperfy frame) into
 * @virvixr/core's TransformSession in Virvi coordinates, shows the draft through `preview`, and saves with VirviApi. Drafts
 * and saves stay in Virvi coordinates; only rays are mapped (rays.ts) and the app maps drafts back for display.
 */
import type { HyperfyClick } from '../plan.js'
import type { Vec3 } from '@virvixr/shared'
import type { Axis, Ray } from '@virvixr/core/transform/math'
import type { ElementKind, Handle, MoveLock, TransformMode, TransformSession } from '@virvixr/core/transform/session'
import type { RenderItem } from '../plan.js'
import type { ApiResult, VirviTransform } from '../virvi-api.js'
import { toVirviRay } from './rays.js'

/** A message for the HUD's alert stack (Task 8 draws it). */
export type HudAlert = { kind: 'info' | 'error'; text: string }

/** What edit mode needs from a shown item: its key (`elementId:instanceId`) and its transform in Virvi coordinates. */
export interface RenderedItem {
  key: string
  kind: RenderItem['kind']
  name: string
  transform: VirviTransform
}

/** A gizmo part: the session's handles, plus move arrows, which drag the body locked to their axis. */
export type GizmoHandle = Handle | { kind: 'arrow'; axis: Axis }

export interface EditState {
  selectedKey: string | null
  selectedName: string | null
  mode: TransformMode
  lock: MoveLock
  snap: boolean
  dirty: boolean
  dragging: boolean
  /** A Save is waiting for Virvi. */
  saving: boolean
  /** Unsaved changes blocked a selection or Done: the HUD asks Save or Revert. */
  prompt: boolean
  /** The draft's value for the current mode (position, rotation in degrees, or scale). */
  values: Vec3 | null
}

export interface EditControllerOptions {
  session: TransformSession
  api: { saveTransform(instanceId: string, t: VirviTransform): Promise<ApiResult<unknown>> }
  items: () => Map<string, RenderedItem>
  /** Shows a Virvi transform on the item's node without changing the plan. */
  preview: (key: string, t: VirviTransform) => void
  /** Puts the item's node back to its plan (feed) transform. */
  restore: (key: string) => void
  alert: (a: HudAlert) => void
  /** The inverse of the app root's world matrix, for taking world rays into the app frame. Default: identity. */
  rootInverse?: () => { elements: ArrayLike<number> }
  /** Called after any change the HUD or gizmo shows. */
  onChange?: () => void
  /** The sandbox's setTimeout (a script argument, not a global), for retrying a save after a lost connection. */
  setTimeout: (fn: () => void, ms: number) => unknown
}

export const ALERT_SAVED = 'Saved'
export const ALERT_NO_ACCESS = "You can't edit this right now"
export const ALERT_LOST = 'Lost connection to Virvi. Retrying…'
export const ALERT_RECONNECTED = 'Reconnected'
export const alertCouldntSave = (reason: string) => `Couldn't save: ${reason}`

const LOCKS: MoveLock[] = ['free', 'x', 'y', 'z']
const ELEMENT: Record<RenderItem['kind'], ElementKind> = { video: 'video', image: 'image', model: 'model', audio: 'sound' }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const RETRY_FIRST_MS = 2_000
const RETRY_MAX_MS = 30_000
const EPSILON = 1e-4
const closeVec = (a: Vec3, b: Vec3) => Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON && Math.abs(a.z - b.z) < EPSILON
/** Equal within float noise (a value that went through Virvi's API may not round-trip exactly). */
const closeTransform = (a: VirviTransform, b: VirviTransform) =>
  closeVec(a.position, b.position) && closeVec(a.rotation, b.rotation) && closeVec(a.scale, b.scale)

/** The instance id half of a RenderItem key. */
export const instanceIdOf = (key: string): string => key.slice(key.indexOf(':') + 1)

export function renderedItem(item: RenderItem): RenderedItem {
  return { key: item.key, kind: item.kind, name: item.name, transform: item.virvi }
}

/**
 * The `onPointerDown` for a Virvi node: while editing, every node selects itself; otherwise only a node with a link
 * gets one, which opens the link. Undefined means no handler (so Hyperfy shows no pointer for it).
 */
export function clickHandler(
  item: { key: string; clickUrl: string | null; click?: HyperfyClick | null },
  editing: boolean,
  on: { select: (key: string) => void; open: (url: string) => void; sound?: (src: string) => void; move?: (position: [number, number, number]) => void },
): (() => void) | undefined {
  if (editing) return () => on.select(item.key)
  const c = item.click
  // Click actions (LIV-126); a plan without `click` still opens its link
  if (c?.kind === 'sound' && on.sound) return () => on.sound!(c.src)
  if (c?.kind === 'move' && on.move) return () => on.move!(c.position)
  const url = c?.kind === 'link' ? c.url : item.clickUrl
  return url ? () => on.open(url) : undefined
}

export class EditController {
  private selectedKey: string | null = null
  private dragging = false
  /** The lock to go back to after an arrow drag (arrows lock the session to their axis while held). */
  private lockAfterDrag: MoveLock | null = null
  private snap = false
  private saving = false
  private prompt = false
  /** Item to select once the prompt is answered (null: none). */
  private pending: string | null = null
  /** Done was pressed while dirty: deselect once the prompt is answered. */
  private doneAfterPrompt = false
  /**
   * Saves the feed hasn't brought back yet, by key: `before` is the feed's value when the save landed. Until a
   * snapshot moves the item off `before` (or onto the saved value), the saved transform stands in for the feed's:
   * it stays previewed and is the baseline for the next drag.
   */
  private readonly saved = new Map<string, { transform: VirviTransform; before: VirviTransform }>()
  /** Bumped to cancel a scheduled save retry (the sandbox has no clearTimeout). */
  private retryToken = 0
  private retryDelay = 0
  /** A save failed with 'lost' and no save has gone through since. */
  private lost = false
  private readonly timeout: (fn: () => void, ms: number) => unknown

  constructor(private readonly opts: EditControllerOptions) {
    this.timeout = opts.setTimeout
  }

  get state(): EditState {
    const s = this.opts.session
    const draft = s.draft
    const values = draft ? (s.mode === 'move' ? draft.position : s.mode === 'rotate' ? draft.rotation : draft.scale) : null
    return {
      selectedKey: this.selectedKey,
      selectedName: s.selected ? s.selected.name : null,
      mode: s.mode,
      lock: this.lockAfterDrag ?? s.lock,
      snap: this.snap,
      dirty: s.dirty,
      dragging: this.dragging,
      saving: this.saving,
      prompt: this.prompt,
      values,
    }
  }

  /** 'dirty' when unsaved changes block it (the HUD asks Save or Revert); 'missing' when the item isn't shown. */
  select(key: string): 'ok' | 'dirty' | 'missing' {
    if (key === this.selectedKey) return 'ok'
    if (this.opts.session.dirty) {
      this.prompt = true
      this.pending = key
      this.doneAfterPrompt = false
      this.changed()
      return 'dirty'
    }
    const item = this.feedValue(key)
    if (!item) return 'missing'
    this.deselect()
    this.take(item)
    this.prompt = false
    this.pending = null
    this.changed()
    return 'ok'
  }

  /** A press on a gizmo handle, or `null` for the selected item itself (a body drag in move mode). */
  pointerDown(handle: GizmoHandle | null, ray: Ray): void {
    const s = this.opts.session
    if (!this.selectedKey || this.saving) return
    this.endDrag()
    const h: GizmoHandle = handle ?? { kind: 'body' }
    if (!this.fits(h)) return
    this.cancelRetry()
    // A clean selection may be stale (the feed moved it since): start from the feed's value.
    if (!s.dirty) this.refresh()
    if (h.kind === 'arrow') {
      this.lockAfterDrag = s.lock
      while (s.lock !== h.axis) s.cycleLock()
      s.beginDrag({ kind: 'body' }, this.virviRay(ray), null)
    } else {
      s.beginDrag(h, this.virviRay(ray), null)
    }
    this.dragging = true
    this.changed()
  }

  pointerMove(ray: Ray): void {
    if (!this.dragging) return
    const before = this.opts.session.draft
    this.opts.session.drag(this.virviRay(ray), null)
    if (!same(before, this.opts.session.draft)) this.show()
  }

  pointerUp(): void {
    if (!this.dragging) return
    this.endDrag()
    this.changed()
  }

  setMode(mode: TransformMode): void {
    this.endDrag()
    this.opts.session.setMode(mode)
    this.changed()
  }

  cycleLock(): MoveLock {
    if (this.lockAfterDrag !== null) {
      // An arrow holds the session's lock: change what the drag goes back to.
      this.lockAfterDrag = LOCKS[(LOCKS.indexOf(this.lockAfterDrag) + 1) % LOCKS.length]
      this.changed()
      return this.lockAfterDrag
    }
    const lock = this.opts.session.cycleLock()
    this.changed()
    return lock
  }

  setSnap(on: boolean): void {
    this.snap = on
    this.opts.session.setSnap(on)
    this.changed()
  }

  /** One axis of the current mode's value, as typed into the HUD. False when nothing is selected or it's refused. */
  setValue(axis: Axis, value: number): boolean {
    if (!this.selectedKey || this.saving) return false
    this.endDrag()
    if (!this.opts.session.setValue(axis, value)) return false
    this.cancelRetry()
    this.show()
    return true
  }

  /**
   * Saves the draft with PUT /api/instances/:id.
   * - Success: the saved value stands in for the feed's until the feed brings it (see `saved`).
   * - 'no_access': alerts and reverts.
   * - 'auth' (Virvi refused the pass): VirviApi has already renewed and retried once, so this means the pass couldn't be
   *   renewed. Keeps the draft quietly; the pairing shows "Link expired. Pair again." and Save works once re-linked.
   * - 'lost': keeps the draft, alerts once, and retries with back-off (2 s doubling to 30 s) while the draft is
   *   unchanged; a later success alerts "Reconnected" then "Saved".
   * - Anything else: keeps the draft with "Couldn't save: <reason>".
   */
  async save(): Promise<void> {
    const key = this.selectedKey
    if (!key || this.saving || !this.opts.session.dirty) return
    this.retryToken++ // this attempt replaces any scheduled retry
    await this.send(key)
  }

  private async send(key: string): Promise<void> {
    const s = this.opts.session
    this.endDrag()
    const draft = s.draft!
    const before = this.opts.items().get(key)?.transform
    this.saving = true
    this.changed()
    let r: ApiResult<unknown>
    try {
      r = await this.opts.api.saveTransform(instanceIdOf(key), draft)
    } catch {
      r = { ok: false, reason: 'lost' }
    }
    this.saving = false
    const current = this.selectedKey === key
    if (!r.ok && r.reason === 'lost') {
      if (!this.lost) this.opts.alert({ kind: 'error', text: ALERT_LOST })
      this.lost = true
      this.scheduleRetry(key, draft)
      return this.changed()
    }
    const wasLost = this.lost
    this.lost = false
    this.retryDelay = 0
    if (r.ok) {
      // Committed only if the draft is still what was sent (no edit landed while saving).
      if (current && same(s.draft, draft)) {
        s.takeSave()
        if (before && !closeTransform(before, draft)) this.saved.set(key, { transform: draft, before })
      }
      if (wasLost) this.opts.alert({ kind: 'info', text: ALERT_RECONNECTED })
      this.opts.alert({ kind: 'info', text: ALERT_SAVED })
      if (current && !s.dirty) return this.answerPrompt()
    } else if (r.reason === 'no_access') {
      this.opts.alert({ kind: 'error', text: ALERT_NO_ACCESS })
      if (current) return this.revert()
    } else if (r.reason !== 'auth') {
      this.opts.alert({ kind: 'error', text: alertCouldntSave(r.reason) })
    }
    this.changed()
  }

  private scheduleRetry(key: string, draft: VirviTransform): void {
    this.retryDelay = this.retryDelay ? Math.min(this.retryDelay * 2, RETRY_MAX_MS) : RETRY_FIRST_MS
    const token = ++this.retryToken
    this.timeout(() => {
      const s = this.opts.session
      if (token !== this.retryToken || this.saving || this.selectedKey !== key || !s.dirty || !same(s.draft, draft)) return
      void this.send(key)
    }, this.retryDelay)
  }

  /** A new edit, revert or deselect: a scheduled retry would send a stale draft. */
  private cancelRetry(): void {
    this.retryToken++
    this.retryDelay = 0
    this.lost = false
  }

  /** Drops the draft: the item goes back to the feed's newest value. Also answers a pending prompt. */
  revert(): void {
    const key = this.selectedKey
    if (!key || this.saving) return
    this.endDrag()
    this.cancelRetry()
    this.opts.session.revert()
    this.refresh()
    this.showFeed(key)
    this.answerPrompt()
  }

  /** Leaves the selection; 'dirty' when unsaved changes block it (the HUD asks Save or Revert). */
  done(): 'ok' | 'dirty' {
    if (this.opts.session.dirty) {
      this.prompt = true
      this.pending = null
      this.doneAfterPrompt = true
      this.changed()
      return 'dirty'
    }
    this.deselect()
    this.changed()
    return 'ok'
  }

  /**
   * Called after the app applies a new feed snapshot (its nodes now show the feed, or a pending save's preview).
   * - A pending save ends once the feed moves the item off its pre-save value (or onto the saved one).
   * - A selection that is gone is dropped.
   * - A clean, idle selection takes the new value.
   * - A draft (or a drag) is kept and shown again; Revert then goes to the newest feed value.
   */
  onSnapshot(prevPlan: readonly RenderItem[], nextPlan: readonly RenderItem[]): void {
    const nextByKey = new Map(nextPlan.map((i) => [i.key, i]))
    for (const [k, p] of [...this.saved]) {
      const item = nextByKey.get(k)
      if (item && closeTransform(item.virvi, p.before) && !closeTransform(item.virvi, p.transform)) continue
      this.saved.delete(k)
      // The feed is the truth again; the selected item is handled below.
      if (k !== this.selectedKey && item) this.opts.restore(k)
    }
    const key = this.selectedKey
    if (!key) return
    const next = nextByKey.get(key)
    if (!next || !this.opts.items().has(key)) {
      this.deselect()
      this.changed()
      return
    }
    const prev = prevPlan.find((i) => i.key === key)
    if (prev && same(prev, next)) return
    if (this.opts.session.dirty || this.dragging) this.show()
    else {
      this.refresh()
      this.showFeed(key)
      this.changed()
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  private fits(h: GizmoHandle): boolean {
    switch (this.opts.session.mode) {
      case 'move':
        return h.kind === 'body' || h.kind === 'arrow'
      case 'rotate':
        return h.kind === 'ring'
      case 'resize':
        return h.kind === 'uniform' || h.kind === 'stretch'
    }
  }

  private virviRay(ray: Ray): Ray {
    return toVirviRay(ray, this.opts.rootInverse?.())
  }

  /** Selects the item in the session afresh (the session must be clean). */
  private take(item: RenderedItem): void {
    const s = this.opts.session
    s.clear()
    s.select({ element: ELEMENT[item.kind], sk: item.key, name: item.name, transform: item.transform })
    this.selectedKey = item.key
  }

  /** The item as the feed has it, or with a pending save's transform until the feed brings it. */
  private feedValue(key: string): RenderedItem | undefined {
    const item = this.opts.items().get(key)
    const pending = this.saved.get(key)
    return item && pending ? { ...item, transform: pending.transform } : item
  }

  /** Shows the feed's value on the item's node: a pending save stays previewed, anything else is restored. */
  private showFeed(key: string): void {
    const pending = this.saved.get(key)
    if (pending) this.opts.preview(key, pending.transform)
    else this.opts.restore(key)
  }

  /** Re-takes the selected item's feed value as the baseline, keeping mode, lock and snap. */
  private refresh(): void {
    const item = this.selectedKey ? this.feedValue(this.selectedKey) : undefined
    if (item && !this.opts.session.dirty) this.take(item)
  }

  private endDrag(): void {
    if (!this.dragging) return
    const s = this.opts.session
    s.endDrag()
    this.dragging = false
    const lock = this.lockAfterDrag
    this.lockAfterDrag = null
    if (lock !== null) while (s.lock !== lock) s.cycleLock()
    // A drag that changed nothing may have started from a stale value: take the feed's.
    if (!s.dirty) this.refresh()
  }

  /** Drops the selection; its node goes back to the feed's value, except a pending save, which stays shown. */
  private deselect(): void {
    this.endDrag()
    this.cancelRetry()
    if (this.selectedKey && !this.saved.has(this.selectedKey)) this.opts.restore(this.selectedKey)
    this.opts.session.clear()
    this.selectedKey = null
    this.prompt = false
    this.pending = null
    this.doneAfterPrompt = false
  }

  private answerPrompt(): void {
    const next = this.pending
    const leave = this.doneAfterPrompt
    this.prompt = false
    this.pending = null
    this.doneAfterPrompt = false
    if (next) this.select(next)
    else if (leave) this.deselect()
    this.changed()
  }

  private show(): void {
    const draft = this.opts.session.draft
    if (this.selectedKey && draft) this.opts.preview(this.selectedKey, draft)
    this.changed()
  }

  private changed(): void {
    this.opts.onChange?.()
  }
}
