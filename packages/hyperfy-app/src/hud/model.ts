/**
 * The HUD's view model, free of Hyperfy nodes: what the edit bar, panels and alert stack show for the current
 * pairing, edit and scene state, plus the HUD's small pure helpers (alerts, typing, placement). view.ts draws it.
 */
import {
  formatPairingCode,
  type SerializedScene,
  type SerializedSceneElement,
  type Vec3,
} from '@virvixr/shared'
import type { MoveLock, TransformMode } from '@virvixr/core/transform/session'
import {
  ALERT_LOST,
  ALERT_NO_ACCESS,
  ALERT_RECONNECTED,
  alertCouldntSave,
  type EditState,
  type HudAlert,
} from '../edit/controller.js'
import type { PairingState } from '../pairing.js'
import type { RenderItem } from '../plan.js'
import { toVirviPosition, worldToLocal } from '../transform.js'
import type { ApiFailure, ApiResult, VirviTransform } from '../virvi-api.js'

export const alertLinked = (name: string) => `Linked to Virvi as ${name}`
export const ALERT_LINK_EXPIRED = 'Link expired. Pair again.'
export const ALERT_STREAM_LIVE = 'Stream is live'
export const ALERT_STREAM_OFFLINE = 'Stream went offline'
export const ALERT_PLACED = 'Added here. Decentraland needs a redeploy to show it.'
export const alertCouldntLoad = (reason: string) => `Couldn't load: ${reason}`
export const PLACE_LABEL = 'Place in front of me'
/** Shift is Hyperfy's run key, so L cycles the axis lock. */
export const KEY_HINT = 'L: axis lock · ` or Esc: use the HUD · click the world: aim'
/**
 * Hyperfy's chat opens on '/' and Enter ahead of any app, so links (every one has a '/') come in through chat instead:
 * a message starting with '/' is a command, kept off the chat log and handed to apps. Chat is a real text box, so
 * pasting works there.
 */
export const CHAT_COMMAND = 'virvi'
export const LINK_HINT = 'In chat, type /virvi and paste the link'
export const SEARCH_PLACEHOLDER = 'Search the catalog'

/** How far in front of the camera "Place in front of me" puts a model, in metres. */
export const PLACE_DISTANCE = 2
const MAX_ALERTS = 3
export const PAGE_SIZE = 8
/** VideoSourceType.SCHEDULED (LIV-87). */
const SCHEDULED = 6

export type Panel = 'layout' | 'streams' | 'assets' | null
export type AssetTab = 'library' | 'catalog' | 'link'
export type Axis = 'x' | 'y' | 'z'
export type TypingTarget = Axis | 'search'

/** A stream as GET /api/scenes/:id/streams lists it (never the stream key). */
export interface HudStream { id: string; name: string; hlsPlaylistUrl: string; live: boolean; mine: boolean }

/** "Main Stage (live)", "Editor Cam (offline, yours)": as the dashboard and the Decentraland HUD say it. */
export const streamOptionLabel = (s: HudStream) => `${s.name} (${s.live ? 'live' : 'offline'}${s.mine ? ', yours' : ''})`

/** What a screen's live source is: one of the scene's streams, a link pasted elsewhere, or nothing. */
export function streamSourceLabel(liveSrc: string, streams: HudStream[] | null): string {
  if (!liveSrc) return 'No stream'
  const s = (streams ?? []).find((x) => x.hlsPlaylistUrl === liveSrc)
  return s ? streamOptionLabel(s) : 'Custom link'
}

/** An image from the scene library that can be a screen's off image (LIV-54). */
export interface HudImage { id: string; name: string; url: string }

/** Image types a screen can show (as the Decentraland HUD offers). */
const OFF_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The scene library's ready images, for the off image list. */
export function offImageChoices(entries: ReadonlyArray<{ id: string; kind: string; name: string; url: string; status: string; contentType?: unknown }>): HudImage[] {
  return entries
    .filter((a) => a.status === 'ready' && !!a.url && a.kind === 'media' && typeof a.contentType === 'string' && OFF_IMAGE_TYPES.has(a.contentType))
    .map((a) => ({ id: a.id, name: a.name, url: a.url }))
}

/** "Off image: Poster", by its library name as the dashboard and the Decentraland HUD show it. */
export function offImageLabel(src: string, images: HudImage[] | null): string {
  if (!src) return 'No off image'
  const img = (images ?? []).find((i) => i.url === src)
  return `Off image: ${img ? img.name : 'from a link'}`
}

export const IMAGES_LOADING = 'Loading images…'
export const NO_IMAGES = 'No images in the scene library yet: add one from Images & Video on virvi.io'

/** A screen's showing as the Streams panel uses it (LIV-87): its shows on now or coming up, start in UTC ms. */
export interface HudShowing {
  id: string
  title: string
  enabled: boolean
  upcoming: Array<{ startsAt: number; lengthSeconds: number }>
}
export type ShowControl = 'delay' | 'end' | 'play-now'
/** "Delay 5 min" moves the next show this far; pressing again adds more (Virvi caps it at 3 hours). */
export const DELAY_STEP_MINUTES = 5
export const SHOWINGS_LOADING = 'Loading showings…'
export const NO_SHOWINGS = 'No showings yet: add them on virvi.io'

/** How long until something, rounded up: "23 min", "1 h 05 min", "2 days". Relative: the sandbox can't format a clock. */
export function timeLeft(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000))
  if (min < 60) return `${min} min`
  if (min < 1440) return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
  const d = Math.floor(min / 1440)
  return `${d} ${d === 1 ? 'day' : 'days'}`
}

/** One showing's line and which controls apply: End while a show is on, Play now between shows, Delay with one coming up. */
export function showingRow(s: HudShowing, now: number): { id: string; title: string; status: string; canEnd: boolean; canPlay: boolean; canDelay: boolean } {
  const title = s.title || 'Untitled showing'
  if (!s.enabled) return { id: s.id, title, status: 'Paused on virvi.io', canEnd: false, canPlay: false, canDelay: false }
  const on = s.upcoming.find((u) => u.startsAt <= now && now < u.startsAt + u.lengthSeconds * 1000)
  const next = s.upcoming.find((u) => u.startsAt > now)
  const status = on
    ? `On now, ${timeLeft(on.startsAt + on.lengthSeconds * 1000 - now)} left`
    : next
      ? `Next in ${timeLeft(next.startsAt - now)}`
      : 'Nothing coming up'
  return { id: s.id, title, status, canEnd: !!on, canPlay: !on, canDelay: !!next }
}

export function showControlAlert(control: ShowControl, title: string): HudAlert {
  const name = title || 'Untitled showing'
  const text =
    control === 'delay' ? `${name}: the next show starts ${DELAY_STEP_MINUTES} min later` : control === 'end' ? `${name}: ended` : `${name}: playing now for everyone`
  return { kind: 'info', text }
}

export const STREAMS_LOADING = 'Loading streams…'
export const NO_STREAMS = 'No streams yet: set one up on the Streaming page at virvi.io'

export interface AssetEntry {
  id: string
  name: string
  /** The model file to place. */
  src: string
  source: AssetTab
}

/** The HUD's own state (what panel is open, what was loaded or typed). */
export interface HudUi {
  /** Edit mode is on: clicks select. */
  editing: boolean
  panel: Panel
  tab: AssetTab
  /** null while loading (or not loaded yet). */
  library: AssetEntry[] | null
  catalog: AssetEntry[] | null
  query: string
  linkUrl: string
  /** The chosen asset's id. */
  chosen: string | null
  presets: Array<{ id: string; name: string }> | null
  /** The scene's streams for the Streams panel; null while loading (or not loaded yet). */
  streamList: HudStream[] | null
  /** The screen whose stream list is open. */
  streamPicking: string | null
  /** The scene library's images for off images; null while loading (or not loaded yet). */
  imageList: HudImage[] | null
  /** The screen whose off image list is open. */
  imagePicking: string | null
  /** The Schedule-mode screen whose showings are open, and its showings (null while loading). */
  showingsFor: string | null
  showingList: HudShowing[] | null
  /** The object whose "remove every copy" is waiting to be confirmed (LIV-12). */
  clearing: string | null
  typing: { target: TypingTarget; text: string } | null
  /** A link request is on its way (hosted worlds ask their server half). */
  linking: boolean
  /** A placement is on its way. */
  placing: boolean
}

export const initialUi = (): HudUi => ({
  editing: false,
  panel: null,
  tab: 'library',
  library: null,
  catalog: null,
  query: '',
  linkUrl: '',
  chosen: null,
  presets: null,
  streamList: null,
  streamPicking: null,
  imageList: null,
  imagePicking: null,
  showingsFor: null,
  showingList: null,
  clearing: null,
  typing: null,
  linking: false,
  placing: false,
})

export interface HudState {
  pairing: PairingState
  edit: EditState
  plan: RenderItem[]
  scene: SerializedScene | null
  alerts: HudAlert[]
  ui?: Partial<HudUi>
  /** Date.now() for the showings' "on now" and "next in" lines. */
  now?: number
}

export interface HudViewModel {
  link: {
    status: PairingState['status']
    label: string
    /** XXX-XXX while waiting. */
    code?: string
    approveUrl?: string
    qrUrl?: string
    canLink: boolean
  }
  linked: boolean
  /** The edit bar; null until linked (kept while editing if the link lapses). */
  bar: null | {
    editing: boolean
    mode: TransformMode
    lock: MoveLock
    lockLabel: string
    snap: boolean
    dirty: boolean
    saving: boolean
    /** Unsaved changes blocked a selection or Done: Save or Revert. */
    prompt: boolean
    selectedName: string | null
    values: Array<{ axis: Axis; text: string; typing: boolean }> | null
    /** On-screen keys while typing an axis value (there's no text input): each types like the key `prop`/`char`. */
    keypad: KeypadKey[] | null
    hint: string
  }
  panel: Panel
  layout: {
    items: Array<{
      elementId: string
      kind: 'video' | 'image' | 'model' | 'audio'
      name: string
      enabled: boolean
      /** How many copies (instances) it has in the scene. */
      copies: number
      /** The confirmation to show while it is being cleared, else null. */
      clearPrompt: string | null
    }>
    presets: Array<{ id: string; name: string; active: boolean }>
  }
  streams: Array<{
    elementId: string
    name: string
    enableLiveStream: boolean
    isLive: boolean
    source: string
    picking: boolean
    /** "Off image: Poster" or "No off image". */
    offImage: string
    imagePicking: boolean
    /** In Schedule mode: has a Showings list (LIV-87). */
    scheduled: boolean
    showingsOpen: boolean
  }>
  /** The open screen's showings, each with its line and controls. */
  showingRows: Array<ReturnType<typeof showingRow>>
  /** Shown in place of the rows: still loading, or none. */
  showingsNote: string | null
  /** The streams to choose from for the screen being picked for; `current` is the one it plays. */
  streamOptions: Array<{ id: string; label: string; current: boolean }>
  /** Shown in place of the options: still loading, or none set up. */
  streamsNote: string | null
  /** The off images to choose from for the screen being picked for, None ('') first; `current` is the one it shows. */
  imageOptions: Array<{ id: string; label: string; current: boolean }>
  /** Shown above the options: still loading, or no images in the library. */
  imagesNote: string | null
  assets: {
    tabs: AssetTab[]
    tab: AssetTab
    entries: Array<AssetEntry & { chosen: boolean }>
    loading: boolean
    query: string
    /** The search field: what is being typed (with a cursor), else the query or a placeholder. */
    searchText: string
    linkUrl: string
    /** The Link tab: the link, or how to send one from chat. */
    linkText: string
    typing: TypingTarget | null
    canPlace: boolean
    placeLabel: string
  }
  alerts: HudAlert[]
}

const KINDS: Array<
  [
    keyof SerializedScene & ('videos' | 'images' | 'models' | 'sounds'),
    'video' | 'image' | 'model' | 'audio',
    string,
  ]
> = [
  ['videos', 'video', 'Screen'],
  ['images', 'image', 'Image'],
  ['models', 'model', 'Model'],
  ['sounds', 'audio', 'Sound'],
]
/** One on-screen key of the exact-value panel: pressing it is the same as the keyboard key `prop` with text `char`. */
export interface KeypadKey {
  label: string
  prop: string
  char: string
}
const digit = (d: string): KeypadKey => ({ label: d, prop: `digit${d}`, char: d })
/** Rows of three: 7 8 9 / 4 5 6 / 1 2 3 / - 0 . / ⌫ Enter Esc. */
export const KEYPAD: KeypadKey[] = [
  ...['7', '8', '9', '4', '5', '6', '1', '2', '3'].map(digit),
  { label: '-', prop: 'minus', char: '-' },
  digit('0'),
  { label: '.', prop: 'period', char: '.' },
  { label: '⌫', prop: 'backspace', char: 'Backspace' },
  { label: 'Enter', prop: 'enter', char: 'Enter' },
  { label: 'Esc', prop: 'escape', char: 'Escape' },
]
const LOCK_LABEL: Record<MoveLock, string> = { free: 'Free', x: 'X', y: 'Y', z: 'Z' }
const AXES: Axis[] = ['x', 'y', 'z']

const nameOf = (el: SerializedSceneElement, fallback: string) =>
  typeof el.name === 'string' && el.name.trim() ? el.name : fallback
/** A model link the HUD will place: an http(s) URL. */
export const isModelUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim())

function linkCard(p: PairingState, linking: boolean): HudViewModel['link'] {
  switch (p.status) {
    case 'idle':
      return { status: p.status, label: linking ? 'Linking…' : 'Link to Virvi', canLink: !linking }
    case 'waiting':
      return {
        status: p.status,
        label: 'Approve this code on virvi.io',
        code: formatPairingCode(p.code),
        approveUrl: p.approveUrl,
        qrUrl: p.qrUrl,
        canLink: false,
      }
    case 'linked':
      return { status: p.status, label: alertLinked(p.displayName), canLink: false }
    case 'expired':
      return { status: p.status, label: ALERT_LINK_EXPIRED, canLink: !linking }
    case 'lost':
      return { status: p.status, label: ALERT_LOST, canLink: false }
    case 'error':
      return { status: p.status, label: "This app's Virvi world key isn't valid", canLink: false }
  }
}

export function hudModel(state: HudState): HudViewModel {
  const ui = { ...initialUi(), ...state.ui }
  const linked = state.pairing.status === 'linked'
  const e = state.edit
  const typingAxis = ui.typing && AXES.includes(ui.typing.target as Axis) ? ui.typing : null
  const values =
    e.selectedKey && e.values
      ? AXES.map((axis) =>
          typingAxis?.target === axis
            ? { axis, text: `${typingAxis.text}_`, typing: true }
            : { axis, text: e.values![axis].toFixed(2), typing: false },
        )
      : null
  const scene = state.scene
  const activePreset = typeof scene?.sk === 'string' ? scene.sk : null

  const items: HudViewModel['layout']['items'] = []
  for (const [list, kind, fallback] of KINDS) {
    for (const el of scene?.[list] ?? []) {
      if (typeof el.sk !== 'string') continue
      const name = nameOf(el, fallback)
      const copies = Array.isArray(el.instances) ? el.instances.length : 0
      items.push({
        elementId: el.sk,
        kind,
        name,
        enabled: el.enabled !== false,
        copies,
        clearPrompt: ui.clearing === el.sk && copies > 0 ? clearCopiesPrompt({ name, copies }) : null,
      })
    }
  }
  const presets = (
    ui.presets ??
    (activePreset
      ? [{ id: activePreset, name: typeof scene?.name === 'string' ? scene.name : 'Preset' }]
      : [])
  ).map((p) => ({
    ...p,
    active: p.id === activePreset,
  }))
  const streams = (scene?.videos ?? [])
    .filter((v) => typeof v.sk === 'string')
    .map((v) => ({
      elementId: v.sk as string,
      name: nameOf(v, 'Screen'),
      enableLiveStream: !!v.enableLiveStream,
      isLive: !!v.isLive,
      source: streamSourceLabel(liveSrcOf(v), ui.streamList),
      picking: ui.streamPicking === v.sk,
      offImage: offImageLabel(offImageOf(v), ui.imageList),
      imagePicking: ui.imagePicking === v.sk,
      scheduled: v.offType === SCHEDULED,
      showingsOpen: v.offType === SCHEDULED && ui.showingsFor === v.sk,
    }))
  const showingsOpen = streams.some((s) => s.showingsOpen)
  const showingRows = showingsOpen ? (ui.showingList ?? []).map((sh) => showingRow(sh, state.now ?? 0)) : []
  const showingsNote = !showingsOpen ? null : ui.showingList === null ? SHOWINGS_LOADING : ui.showingList.length === 0 ? NO_SHOWINGS : null
  const picked = streams.find((s) => s.picking)
  const pickedSrc = picked ? liveSrcOf((scene?.videos ?? []).find((v) => v.sk === picked.elementId) ?? {}) : ''
  const streamOptions = picked
    ? (ui.streamList ?? []).map((s) => ({ id: s.id, label: streamOptionLabel(s), current: s.hlsPlaylistUrl === pickedSrc }))
    : []
  const imagePicked = (scene?.videos ?? []).find((v) => typeof v.sk === 'string' && v.sk === ui.imagePicking)
  const imageSrc = imagePicked ? offImageOf(imagePicked) : ''
  const imageOptions = imagePicked
    ? [{ id: '', label: 'None', current: !imageSrc }, ...(ui.imageList ?? []).map((i) => ({ id: i.id, label: i.name, current: i.url === imageSrc }))]
    : []
  const imagesNote = !imagePicked ? null : ui.imageList === null ? IMAGES_LOADING : ui.imageList.length === 0 ? NO_IMAGES : null
  const streamsNote = !picked ? null : ui.streamList === null ? STREAMS_LOADING : ui.streamList.length === 0 ? NO_STREAMS : null

  const list = ui.tab === 'library' ? ui.library : ui.tab === 'catalog' ? ui.catalog : []
  const entries = (list ?? [])
    .slice(0, PAGE_SIZE)
    .map((a) => ({ ...a, chosen: a.id === ui.chosen }))
  const chosen = ui.tab === 'link' ? isModelUrl(ui.linkUrl) : entries.some((a) => a.chosen)

  return {
    link: linkCard(state.pairing, ui.linking),
    linked,
    // While editing the bar stays even if the link lapses, so a draft survives re-linking.
    bar:
      linked || ui.editing
        ? {
            editing: ui.editing,
            mode: e.mode,
            lock: e.lock,
            lockLabel: LOCK_LABEL[e.lock],
            snap: e.snap,
            dirty: e.dirty,
            saving: e.saving,
            prompt: e.prompt,
            selectedName: e.selectedName,
            values,
            keypad: values && typingAxis ? KEYPAD : null,
            hint: KEY_HINT,
          }
        : null,
    panel: linked ? ui.panel : null,
    layout: { items, presets },
    streams,
    streamOptions,
    streamsNote,
    imageOptions,
    imagesNote,
    showingRows,
    showingsNote,
    assets: {
      tabs: ['library', 'catalog', 'link'],
      tab: ui.tab,
      entries,
      loading: ui.tab !== 'link' && list === null,
      query: ui.query,
      searchText:
        ui.typing?.target === 'search' ? `${ui.typing.text}_` : ui.query || SEARCH_PLACEHOLDER,
      linkUrl: ui.linkUrl,
      linkText: ui.linkUrl || LINK_HINT,
      typing: ui.typing && !typingAxis ? ui.typing.target : null,
      canPlace: chosen && !!activePreset && !ui.placing,
      placeLabel: PLACE_LABEL,
    },
    alerts: state.alerts.slice(-MAX_ALERTS),
  }
}

const unnamed = (name: string) => name || 'Unnamed'

/** The confirmation for "remove every copy, keep the object" (as the dashboard and the Decentraland HUD ask it). */
export function clearCopiesPrompt(item: { name: string; copies: number }): string {
  const what = item.copies === 1 ? 'the only copy' : `all ${item.copies} copies`
  return `Remove ${what} of ${unnamed(item.name)}? The object stays. This can't be undone.`
}

/** What clearing did: how many copies went. */
export function clearedAlert(name: string, deleted: number): HudAlert {
  if (deleted === 0) return { kind: 'info', text: `${unnamed(name)} had no copies left` }
  return { kind: 'info', text: `Removed ${deleted} ${deleted === 1 ? 'copy' : 'copies'} of ${unnamed(name)}` }
}

const liveSrcOf = (v: Record<string, unknown>) => (typeof v.liveSrc === 'string' ? v.liveSrc.trim() : '')
const offImageOf = (v: Record<string, unknown>) => (typeof v.offImageSrc === 'string' ? v.offImageSrc.trim() : '')

/** "Stream is live" / "Stream went offline" for each screen whose isLive changed between two snapshots. */
export function alertsFromSnapshot(
  prev: SerializedScene | null,
  next: SerializedScene | null,
): HudAlert[] {
  if (!prev || !next) return []
  const before = new Map((prev.videos ?? []).map((v) => [v.sk, !!v.isLive]))
  const out: HudAlert[] = []
  for (const v of next.videos ?? []) {
    const was = before.get(v.sk)
    if (was === undefined || was === !!v.isLive) continue
    out.push({ kind: 'info', text: v.isLive ? ALERT_STREAM_LIVE : ALERT_STREAM_OFFLINE })
  }
  return out
}

/** The alert for a change of link state, or null. */
export function pairingAlert(prev: PairingState, next: PairingState): HudAlert | null {
  if (prev.status === next.status) return null
  switch (next.status) {
    case 'linked':
      return prev.status === 'lost'
        ? { kind: 'info', text: ALERT_RECONNECTED }
        : { kind: 'info', text: alertLinked(next.displayName) }
    case 'expired':
      return { kind: 'error', text: ALERT_LINK_EXPIRED }
    case 'lost':
      return { kind: 'error', text: ALERT_LOST }
    default:
      return null
  }
}

/** The alert for a failed HUD request. 'auth' has none: the link state shows "Link expired". */
export function failureAlert(reason: ApiFailure): HudAlert | null {
  switch (reason) {
    case 'auth':
      return null
    case 'no_access':
      return { kind: 'error', text: ALERT_NO_ACCESS }
    case 'lost':
      return { kind: 'error', text: ALERT_LOST }
    default:
      return { kind: 'error', text: alertCouldntSave(reason) }
  }
}

/** The alert for a failed library or catalog load. 'auth' has none: the link state shows "Link expired". */
export function loadFailureAlert(reason: ApiFailure): HudAlert | null {
  if (reason === 'auth' || reason === 'no_access' || reason === 'lost') return failureAlert(reason)
  return { kind: 'error', text: alertCouldntLoad(reason) }
}

/**
 * One key while typing into a HUD field (Hyperfy has no text input; `app.control()` gives the key and its text).
 * Numbers take digits, '-' and '.'; text takes any printable character. Enter commits, Escape cancels.
 */
export function typeKey(
  text: string,
  prop: string,
  char: string,
  kind: 'number' | 'text',
): { text: string; action: 'none' | 'commit' | 'cancel' } {
  if (prop === 'enter') return { text, action: 'commit' }
  if (prop === 'escape') return { text, action: 'cancel' }
  if (prop === 'backspace') return { text: text.slice(0, -1), action: 'none' }
  if (typeof char !== 'string' || char.length !== 1) return { text, action: 'none' }
  if (kind === 'number' && !/[0-9.\-]/.test(char)) return { text, action: 'none' }
  return { text: text + char, action: 'none' }
}

/** What `/virvi <text>` in chat fills: a web link goes to the Link tab, anything else searches the catalog. */
export function chatEntry(
  text: string,
): { tab: 'link'; linkUrl: string } | { tab: 'catalog'; query: string } | null {
  const t = text.trim()
  if (!t) return null
  return /^https?:\/\//i.test(t) ? { tab: 'link', linkUrl: t } : { tab: 'catalog', query: t }
}

/**
 * The text after `/virvi` from Hyperfy's 'command' event, or null for any other command. The client's event carries
 * `cmd` and `value` (the rest of the line as typed); the server's carries only `args`. Pressing '/' opens chat with a
 * '/' already typed, so typing `/virvi` there sends `//virvi` (cmd '/virvi'): both count.
 */
export function chatCommandText(e: unknown): string | null {
  if (!e || typeof e !== 'object') return null
  const { cmd, value, args } = e as { cmd?: unknown; value?: unknown; args?: unknown }
  const list = Array.isArray(args) ? args : []
  const name = typeof cmd === 'string' ? cmd : list[0]
  if (typeof name !== 'string' || name.replace(/^\/+/, '') !== CHAT_COMMAND) return null
  if (typeof value === 'string') return value
  return list.slice(1).filter((a): a is string => typeof a === 'string').join(' ')
}

type XYZ = { x: number; y: number; z: number }
type Quat = XYZ & { w: number }

/** q * v (unit quaternion). */
function rotate(q: Quat, v: XYZ): XYZ {
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

/**
 * Where "Place in front of me" puts a model: PLACE_DISTANCE in front of the camera rig, along its heading (pitch
 * ignored), at the player's feet height; then app-local (inverse of the app root's world matrix) and Virvi coordinates.
 */
export function inFrontOf(
  camera: { position: XYZ; quaternion: Quat },
  floorY: number,
  rootInverse: { elements: ArrayLike<number> },
): VirviTransform {
  const f = rotate(camera.quaternion, { x: 0, y: 0, z: -1 })
  let len = Math.hypot(f.x, f.z)
  // Looking straight up or down: use the camera's up vector, which then points along the heading.
  const h = len > 1e-6 ? f : rotate(camera.quaternion, { x: 0, y: f.y > 0 ? -1 : 1, z: 0 })
  len = Math.hypot(h.x, h.z) || 1
  const world = {
    x: camera.position.x + (h.x / len) * PLACE_DISTANCE,
    y: floorY,
    z: camera.position.z + (h.z / len) * PLACE_DISTANCE,
  }
  const position: Vec3 = toVirviPosition(worldToLocal(world, rootInverse))
  return { position, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
}

export interface PlaceApi {
  addFromCatalog(sceneId: string, item: { id: string }): Promise<ApiResult<unknown>>
  placeModel(
    presetId: string,
    src: string,
    t: VirviTransform,
    /** The new element's name; the URL's file name when absent. */
    name?: string,
  ): Promise<ApiResult<{ elementId: string; instanceId: string }>>
}

/**
 * Places a model from the asset browser in the active preset: a catalog model is added to the scene library first.
 * Alerts "Added here…" on success (Decentraland shows it after a redeploy), or the failure.
 */
export async function placeAsset(opts: {
  api: PlaceApi
  sceneId: string
  presetId: string
  entry: AssetEntry
  transform: VirviTransform
  alert: (a: HudAlert) => void
}): Promise<boolean> {
  const fail = (reason: ApiFailure) => {
    const a = failureAlert(reason)
    if (a) opts.alert(a)
    return false
  }
  if (opts.entry.source === 'catalog') {
    const added = await opts.api.addFromCatalog(opts.sceneId, { id: opts.entry.id })
    if (!added.ok) return fail(added.reason)
  }
  // Library and catalog models are named as the library names them (an upload's URL is only its storage id)
  const name = opts.entry.source === 'link' ? undefined : opts.entry.name
  const placed = await opts.api.placeModel(opts.presetId, opts.entry.src, opts.transform, name)
  if (!placed.ok) return fail(placed.reason)
  opts.alert({ kind: 'info', text: ALERT_PLACED })
  return true
}
