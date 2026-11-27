// In-world edit mode for editors: click areas on every editable item (picks.ts), remote-draft labels, the transform
// session and its gizmo. Everything here exists only on an editor's client and only while active; every collider
// is on CL_POINTER (never CL_PHYSICS) and exit() removes all of it.
import { engine, Entity, Transform, TextShape, Billboard } from '@dcl/sdk/ecs'
import { Color3, Color4 } from '@dcl/sdk/math'
import { TransformSession } from '@virvixr/core'
import type { Axis, Virvi, DraftPayload, Handle, MoveLock, Ray, Selected, TransformMode } from '@virvixr/core'
import type { TransformData, Vec3 } from '@virvixr/shared'
import type { DclAdapter } from '../DclAdapter'
import { Gizmo } from './gizmo.js'
import { EditInput, type EditHost } from './input.js'
import { Outline } from './outline.js'
import { MARKER_SIZE, Picks, entityPosition, follow, type Pick } from './picks.js'
import { OUTSIDE_AREA } from '../edit-errors.js'

export interface DclEditModeState {
  active: boolean
  mode: TransformMode
  lock: MoveLock
  selectedName: string | null
  dirty: boolean
  message: string | null
  /** Unsaved changes block the request (select another item, Done): the HUD asks Save or Revert. */
  prompt: boolean
  /** A Save is waiting for the server: Save / Revert are off and the item can't be dragged. */
  saving: boolean
  /** The selected item's draft value for the current mode (position, rotation in degrees, or scale), for exact input. */
  values: Vec3 | null
}

const NOT_CONNECTED = 'Not connected — your change is still a draft'
const SAVING = 'Saving…'
const CHANGED_ELSEWHERE = 'Item changed elsewhere — draft discarded'
const NO_EDIT_ACCESS = 'You no longer have edit access'
/** How long a remote save's transform beats stored data that hasn't caught up yet. */
const REMOTE_SAVE_WINDOW_MS = 3000
const RESCAN_SECONDS = 1
const LABEL_GAP = 0.3

const keyOf = (t: TransformData) => JSON.stringify(t)
const round3 = (n: number) => Math.round(n * 1000) / 1000

function modeValues(mode: TransformMode, t: TransformData | null): Vec3 | null {
  if (!t) return null
  const v = mode === 'move' ? t.position : mode === 'rotate' ? t.rotation : t.scale
  return { x: round3(v.x), y: round3(v.y), z: round3(v.z) }
}

export class DclEditMode implements EditHost {
  /** Called after any change the HUD shows (see `state`). */
  onChange: () => void = () => {}
  readonly session: TransformSession

  private readonly gizmo = new Gizmo()
  private readonly outline = new Outline()
  private readonly picks = new Picks()
  private readonly input: EditInput
  private _active = false
  private remote = new Map<string, { holderName: string; transform: TransformData | null }>()
  /**
   * Transforms another editor saved, until our stored data changes (draft_end can beat the preset update). `stored`
   * is the stored transform's key when the entry was recorded (null if the item had no click area then).
   */
  private remoteSaves = new Map<string, { transform: TransformData; at: number; stored: string | null }>()
  private labels = new Map<string, Entity>()
  private selectedEntity: Entity | null = null
  /** The sk this client holds on the server (sent a draft, no end yet). */
  private sentDraftFor: string | null = null
  /** Item to select once the save-or-revert prompt is answered. */
  private pending: string | null = null
  private message: string | null = null
  private prompt = false
  /** Done was pressed while dirty: leave edit mode once the prompt is answered. */
  private exitAfterPrompt = false
  /** The sk of a Save waiting for the server's ack, or null. */
  private savingSk: string | null = null
  /** The server refused a draft as forbidden: stop sending them (Save will report the same). */
  private draftsForbidden = false
  private lastDirty = false
  /** The values the HUD last saw, so drags re-render the exact-input fields only when they change. */
  private lastValuesKey = ''
  private appliedKey = ''
  private rescanIn = 0

  constructor(private readonly virvi: Virvi, adapter: DclAdapter) {
    this.session = new TransformSession({ now: () => Date.now(), onDraft: (d) => this.onDraft(d) })
    this.input = new EditInput(this, (fn) => adapter.registerSystem(fn), (fn) => adapter.unregisterSystem(fn))
    virvi.events.on('transform_draft', (d: any) => this.onRemoteDraft(d))
    virvi.events.on('transform_draft_end', (d: any) => this.onRemoteEnd(d))
    virvi.events.on('transform_held', (d: any) => this.onHeld(d))
    virvi.events.on('virvi_error', (e: any) => this.onError(e))
    virvi.events.on('connection_lost', () => this.onConnectionLost())
  }

  get active(): boolean {
    return this._active
  }

  get mode(): TransformMode {
    return this.session.mode
  }

  get state(): DclEditModeState {
    const sel = this.session.selected
    return {
      active: this._active,
      mode: this.session.mode,
      lock: this.session.lock,
      selectedName: sel ? sel.name || sel.element : null,
      dirty: this.session.dirty,
      message: this.message,
      prompt: this.prompt,
      saving: this.savingSk !== null,
      values: sel ? modeValues(this.session.mode, this.session.draft) : null,
    }
  }

  enter(): void {
    if (this._active) return
    this._active = true
    this.message = null
    this.draftsForbidden = false
    this.scan()
    this.input.start()
    this.changed()
  }

  /** Refused while there are unsaved changes (sets `prompt`). */
  exit(): void {
    if (!this._active) return
    if (this.session.dirty) {
      this.prompt = true
      this.pending = null
      this.exitAfterPrompt = true
      this.changed()
      return
    }
    this.input.stop()
    this.releaseHold()
    this.session.clear()
    this.selectedEntity = null
    this.pending = null
    this.prompt = false
    this.message = null
    this.gizmo.clear()
    this.outline.clear()
    this.picks.clear()
    for (const e of this.labels.values()) engine.removeEntity(e)
    this.labels.clear()
    this._active = false
    this.changed()
  }

  setMode(m: TransformMode): void {
    this.input.cancelDrag()
    this.session.setMode(m)
    this.session.setSnap(false)
    this.applyDraft()
    this.changed()
  }

  /** Exact input from the HUD: one axis of the current mode's value. Saved like a drag (Save / Revert). */
  setValue(axis: Axis, value: number): void {
    const sel = this.session.selected
    if (!sel || this.savingSk !== null) return
    const holder = this.remote.get(sel.sk)?.holderName
    if (holder) {
      this.message = `Being moved by ${holder}`
      return this.changed()
    }
    this.input.cancelDrag()
    if (!this.session.setValue(axis, value)) return
    this.applyDraft()
    this.changed()
  }

  /** Sends the draft and commits it only once the server confirms; on failure the draft stays for another try. */
  save(): void {
    if (this.savingSk !== null || !this.session.dirty) return
    // The item may have been rebuilt since the last rescan (preset switch, upsert): scan drops a stale selection
    this.scan()
    const sel = this.session.selected
    if (!sel || !this.session.dirty) return
    if (this.input.isDragging) {
      this.input.cancelDrag()
      this.session.endDrag()
    }
    const draft = this.session.draft!
    const draftKey = keyOf(draft)
    this.savingSk = sel.sk
    this.message = SAVING
    this.changed()
    this.virvi.editing.save(sel.element, sel.sk, draft).then(
      () => this.saved(sel.sk, draftKey),
      (err: unknown) => this.saveFailed(sel.sk, err),
    )
  }

  private saved(sk: string, draftKey: string): void {
    this.savingSk = null
    const sel = this.session.selected
    const draft = this.session.draft
    if (sel?.sk === sk && draft && keyOf(draft) === draftKey) this.session.takeSave()
    if (this.sentDraftFor === sk) {
      this.sentDraftFor = null
      try {
        this.virvi.editing.endDraft(sk, true)
      } catch {
        // Disconnected right after the save; the server releases the hold when this client leaves
      }
    }
    if (this.message === SAVING) this.message = null
    if (sel?.sk === sk) this.answerPrompt()
    else this.changed()
  }

  private saveFailed(sk: string, err: unknown): void {
    this.savingSk = null
    // No takeSave: the session stays dirty, the draft stays previewed, Save / Revert stay on
    const code = err instanceof Error ? err.message : 'server_error'
    if (this.session.selected?.sk === sk) this.message = code === 'not_connected' ? NOT_CONNECTED : code === 'outside_area' ? OUTSIDE_AREA : `Save failed — ${code}`
    else if (this.message === SAVING) this.message = null
    this.changed()
  }

  revert(): void {
    const sel = this.session.selected
    if (!sel || this.savingSk !== null) return
    this.input.cancelDrag()
    this.session.revert()
    this.virvi.editing.scene.restoreTransform(sel.element, sel.sk)
    this.appliedKey = ''
    this.releaseHold()
    this.message = null
    this.answerPrompt()
  }

  // ── EditHost (called by the frame system) ─────────────────────────────

  handleAt(entity: Entity): Handle | null {
    return this.gizmo.handleAt(entity)
  }

  itemAt(entity: Entity): string | null {
    return this.picks.skAt(entity)
  }

  excludedFromSurface(entity: Entity): boolean {
    if (this.picks.isHelper(entity) || this.gizmo.owns(entity) || this.outline.owns(entity) || entity === this.selectedEntity) return true
    const sel = this.session.selected
    return !!sel && this.picks.skAt(entity) === sel.sk
  }

  press(target: { handle: Handle } | { sk: string } | null): Handle | null {
    if (!target) return null
    if ('handle' in target) return this.session.selected ? target.handle : null
    if (this.session.selected?.sk !== target.sk && !this.selectSk(target.sk)) return null
    return this.session.mode === 'move' ? { kind: 'body' } : null
  }

  beginDrag(handle: Handle, ray: Ray, surfaceHit: Vec3 | null): void {
    const sel = this.session.selected
    const holder = sel ? this.remote.get(sel.sk)?.holderName : undefined
    if (!sel || holder || this.savingSk === sel.sk) {
      this.input.cancelDrag()
      if (holder) {
        this.message = `Being moved by ${holder}`
        this.changed()
      }
      return
    }
    // A clean selection may be stale (another editor saved since): start from what's stored now
    if (!this.session.dirty) this.reselect(sel.sk)
    this.session.beginDrag(handle, ray, surfaceHit)
  }

  drag(ray: Ray, surfaceHit: Vec3 | null): void {
    this.session.drag(ray, surfaceHit)
    this.applyDraft()
  }

  release(): void {
    this.session.endDrag()
  }

  shiftTapped(): void {
    this.session.cycleLock()
    this.changed()
  }

  setSnap(on: boolean): void {
    this.session.setSnap(on)
  }

  sync(dt: number): void {
    this.rescanIn -= dt
    if (this.rescanIn <= 0) {
      this.rescanIn = RESCAN_SECONDS
      this.scan()
    }
    this.picks.followItems()
    for (const [sk, label] of this.labels) {
      const p = this.picks.get(sk)
      const pos = p ? entityPosition(p.entity, this.labelHeight(p)) : null
      if (pos) follow(label, pos)
    }
    const sel = this.session.selected
    // While someone else holds the item, the gizmo sits where they have it, not at our stale draft
    const remoteT = sel && !this.session.dirty ? this.remote.get(sel.sk)?.transform : null
    const shown = sel ? remoteT ?? this.session.draft : null
    this.gizmo.update(this.session.mode, this.session.lock, shown, sel?.element ?? null)
    this.outline.update(shown, sel?.element ?? null)
    const vk = JSON.stringify(sel ? modeValues(this.session.mode, this.session.draft) : null)
    if (this.session.dirty !== this.lastDirty || vk !== this.lastValuesKey) this.changed()
  }

  // ── Selection and drafts ──────────────────────────────────────────────

  /** The item as stored now, or as another editor just saved it if stored data hasn't caught up. */
  private freshItem(sk: string): Selected | null {
    const p = this.picks.get(sk)
    const item = p ? this.virvi.editing.scene.findByEntity(p.entity) : null
    if (!item) return null
    const saved = this.remoteSaves.get(sk)
    if (saved) {
      const stored = keyOf(item.transform)
      // Any change to stored data since the entry was recorded (the save landing, or a later one) ends it
      const storedMoved = saved.stored !== null ? stored !== saved.stored : stored === keyOf(saved.transform)
      if (Date.now() - saved.at < REMOTE_SAVE_WINDOW_MS && !storedMoved) {
        return { ...item, transform: saved.transform }
      }
      this.remoteSaves.delete(sk)
    }
    return item
  }

  private selectSk(sk: string): boolean {
    const p = this.picks.get(sk)
    const item = this.freshItem(sk)
    if (!p || !item) return false
    if (this.session.dirty) {
      this.prompt = true
      this.pending = sk
      this.exitAfterPrompt = false
      this.changed()
      return false
    }
    this.releaseHold()
    this.session.select(item)
    this.selectedEntity = p.entity
    this.appliedKey = keyOf(item.transform)
    this.prompt = false
    this.pending = null
    this.message = null
    this.changed()
    return true
  }

  /** Replaces a clean selection's baseline with fresh data (no hold change, mode and lock kept). */
  private reselect(sk: string): void {
    const item = this.freshItem(sk)
    if (!item || this.session.dirty) return
    this.session.clear()
    this.session.select(item)
    this.appliedKey = keyOf(item.transform)
  }

  private answerPrompt(): void {
    this.prompt = false
    const next = this.pending
    const leave = this.exitAfterPrompt
    this.pending = null
    this.exitAfterPrompt = false
    if (next) this.selectSk(next)
    this.changed()
    if (leave && !next) this.exit()
  }

  /** Applies the draft to the item locally (every frame while dragging; drafts on the wire are throttled). */
  private applyDraft(): void {
    const sel = this.session.selected
    const draft = this.session.draft
    if (!sel || !draft) return
    const k = keyOf(draft)
    if (k === this.appliedKey) return
    this.appliedKey = k
    this.virvi.editing.scene.previewTransform(sel.element, sel.sk, draft)
  }

  private onDraft(d: DraftPayload): void {
    this.applyDraft()
    if (this.draftsForbidden) return
    try {
      // Dropped silently while disconnected (connection_lost shows the message)
      this.virvi.editing.sendDraft({ element: d.element, sk: d.sk, ...d.transform })
      this.sentDraftFor = d.sk
    } catch {
      if (this.message !== NOT_CONNECTED) {
        this.message = NOT_CONNECTED
        this.changed()
      }
    }
  }

  /** Tells the server this client no longer holds its item (no-op if it never sent a draft). */
  private releaseHold(): void {
    const sk = this.sentDraftFor
    if (!sk) return
    this.sentDraftFor = null
    try {
      this.virvi.editing.endDraft(sk, false)
    } catch {
      // Not connected: the server releases the hold when this client leaves
    }
  }

  // ── Remote editors ────────────────────────────────────────────────────

  private onRemoteDraft(d: { sk: string; holderName?: string; position: Vec3; rotation: Vec3; scale: Vec3 }): void {
    const holderName = d.holderName || 'another editor'
    this.remote.set(d.sk, { holderName, transform: { position: d.position, rotation: d.rotation, scale: d.scale } })
    this.ensureLabel(d.sk)
  }

  private onRemoteEnd(d: { sk: string; saved: boolean }): void {
    const last = this.remote.get(d.sk)?.transform ?? null
    this.remote.delete(d.sk)
    if (d.saved && last) {
      const p = this.picks.get(d.sk)
      const stored = p ? this.virvi.editing.scene.findByEntity(p.entity)?.transform : null
      this.remoteSaves.set(d.sk, { transform: last, at: Date.now(), stored: stored ? keyOf(stored) : null })
    }
    this.removeLabel(d.sk)
    // Our clean selection of that item is stale now (saved elsewhere, or restored): reselect it fresh
    const sel = this.session.selected
    if (sel?.sk === d.sk && !this.session.dirty) {
      this.input.cancelDrag()
      this.reselect(d.sk)
      this.changed()
    }
  }

  private onHeld(d: { sk: string; holderName?: string }): void {
    const holderName = d.holderName || 'another editor'
    const prev = this.remote.get(d.sk)
    this.remote.set(d.sk, { holderName, transform: prev?.transform ?? null })
    this.ensureLabel(d.sk)
    const sel = this.session.selected
    if (sel?.sk === d.sk) {
      // Our drag on an item someone else holds never counted: drop it and show where theirs is
      this.input.cancelDrag()
      this.session.revert()
      if (this.sentDraftFor === d.sk) this.sentDraftFor = null
      if (prev?.transform) this.virvi.editing.scene.previewTransform(sel.element, sel.sk, prev.transform)
      else this.virvi.editing.scene.restoreTransform(sel.element, sel.sk)
      this.appliedKey = ''
    }
    this.message = `Being moved by ${holderName}`
    this.changed()
  }

  /** Save errors arrive through editing.save's promise; this only handles a refused draft. */
  private onError(e: { code?: string; messageType?: string }): void {
    if (e?.messageType !== 'transform_draft' || (e.code !== 'forbidden' && e.code !== 'outside_area')) return
    // LIV-32: a tenant dragging something outside their area is refused for that item only
    if (e.code === 'outside_area') {
      this.sentDraftFor = null
      if (!this._active) return
      this.message = OUTSIDE_AREA
      this.changed()
      return
    }
    this.draftsForbidden = true
    this.sentDraftFor = null // the server never gave us the hold
    if (!this._active) return
    this.message = NO_EDIT_ACCESS
    this.changed()
  }

  /** The room dropped: the server released our hold; the draft stays here for a Save once reconnected. */
  private onConnectionLost(): void {
    this.sentDraftFor = null
    if (!this._active) return
    if (this.savingSk === null) this.message = NOT_CONNECTED // a pending save reports it when it rejects
    this.changed()
  }

  /** Only for items with a click area (so the label has somewhere to sit), only while active. */
  private ensureLabel(sk: string): void {
    const p = this.picks.get(sk)
    if (!this._active || !p) return
    const text = `being moved by ${this.remote.get(sk)?.holderName ?? 'another editor'}`
    const existing = this.labels.get(sk)
    if (existing !== undefined) {
      const ts = TextShape.getMutableOrNull(existing)
      if (ts && ts.text !== text) ts.text = text
      return
    }
    const pos = entityPosition(p.entity, this.labelHeight(p))
    if (!pos) return
    const e = engine.addEntity()
    Transform.create(e, { position: pos })
    TextShape.create(e, { text, fontSize: 3, textColor: Color4.White(), outlineWidth: 0.1, outlineColor: Color3.Black() })
    Billboard.create(e, {})
    this.labels.set(sk, e)
  }

  private removeLabel(sk: string): void {
    const label = this.labels.get(sk)
    if (label !== undefined) engine.removeEntity(label)
    this.labels.delete(sk)
  }

  /** Refreshes click areas, drops a selection whose item is gone, and keeps labels in step with picks. */
  private scan(): void {
    if (!this._active) return
    const live = this.picks.sync(this.virvi.editing.scene.listEditable())
    for (const sk of [...this.labels.keys()]) if (!this.picks.get(sk)) this.removeLabel(sk)
    for (const sk of this.remote.keys()) this.ensureLabel(sk)
    const sel = this.session.selected
    if (sel && live.get(sel.sk) !== this.selectedEntity) {
      // The selected item is gone or rebuilt (deleted, hidden, preset change, upsert, rejoin): its draft goes with it
      if (this.session.dirty) this.message = CHANGED_ELSEWHERE
      this.input.cancelDrag()
      if (this.sentDraftFor === sel.sk) this.releaseHold()
      this.session.clear()
      this.selectedEntity = null
      this.prompt = false
      this.pending = null
      this.exitAfterPrompt = false
      this.changed()
    }
  }

  /** Label height above the item's origin: over the top of a plane, the marker, or a base-origin model. */
  private labelHeight(p: Pick): number {
    const sy = Math.abs(Transform.getOrNull(p.entity)?.scale.y ?? 1)
    if (p.how === 'marker') return MARKER_SIZE / 2 + LABEL_GAP
    if (p.element === 'model') return sy + LABEL_GAP
    return sy / 2 + LABEL_GAP
  }

  private changed(): void {
    this.lastDirty = this.session.dirty
    const sel = this.session.selected
    this.lastValuesKey = JSON.stringify(sel ? modeValues(this.session.mode, this.session.draft) : null)
    try {
      this.onChange()
    } catch (err) {
      console.warn('[Virvi] edit mode onChange failed:', err)
    }
  }
}
