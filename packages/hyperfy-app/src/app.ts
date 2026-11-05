/**
 * The Virvi app for Hyperfy 0.16. Hyperfy runs this script once on the world's server and once in each
 * visitor's browser, with only its sandbox globals (world, app, fetch, props, setTimeout, Matrix4).
 * - Server: long-polls Virvi's scene feed with the world key, passes each new snapshot to every client, and
 *   records visits. Visitors' browsers never talk to Virvi.
 * - Client: renders the snapshot's plan as nodes under the app root. Each node's local transform is the Virvi
 *   transform, so the app's own placement and scale in the world carry the whole scene; the root is never moved.
 * - HUD (client, admins and builders only): links the player to Virvi, then edits the scene with Virvi's REST API.
 *   Hosted worlds link through the server half, which asks the image to vouch for its players (`app.virviVouch`,
 *   server only; the world secret stays in Node); self-run worlds pair from the browser with a code.
 */
import type { HyperfyFeedResponse, SerializedScene, ShowingInstance } from '@virvixr/shared'
import { clickHandler, renderedItem } from './edit/controller.js'
import { runHud } from './hud/client.js'
import { runLinkRelay } from './link-relay.js'
import { diffPlans, planScene, type RenderItem } from './plan.js'
import { FeedPoller } from './poller.js'
import { newSeekState, scheduledView, seekAction, virviClockOffset, type ScheduledView, type SeekState } from './showings.js'
import type { AppProps, ClientEditHooks, HApp, HNode, HWorld, Matrix4Ctor, ScriptFetch, ScriptSetTimeout } from './sandbox.js'
import { MODEL_TURN, toHyperfyTransform, toVirviPosition, worldToLocal, type HyperfyTransform } from './transform.js'
import type { VirviTransform } from './virvi-api.js'
import { VisitRecorder } from './visits.js'

declare const world: HWorld
declare const app: HApp
declare const fetch: ScriptFetch
declare const setTimeout: ScriptSetTimeout
declare const props: AppProps
declare const Matrix4: Matrix4Ctor
declare const uuid: () => string

const SCENE = 'virvi:scene'
/** A feed answer as the server half passes it on: plus Virvi's clock minus the world's shared clock (ms), if known. */
type SceneMessage = HyperfyFeedResponse & { clockOffsetMs?: number }

type V3 = { x: number; y: number; z: number }
const closeV = (a: V3, b: V3) => Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4 && Math.abs(a.z - b.z) < 1e-4
const sameTransform = (a: VirviTransform, b: VirviTransform) =>
  closeV(a.position, b.position) && closeV(a.rotation, b.rotation) && closeV(a.scale, b.scale)
const HELLO = 'virvi:hello'
/** How often playlist and scheduled screens are checked (Hyperfy's video node has no "ended" event). */
const PLAYLIST_CHECK_MS = 500
/** A video stopped within this many seconds of its end has ended. */
const END_SLACK_S = 0.5

/** Stopped at its end: not paused partway, nor not started yet (still loading, or autoplay blocked). */
const videoEnded = (node: HNode) =>
  node.playing === false &&
  typeof node.duration === 'number' &&
  node.duration > 0 &&
  typeof node.time === 'number' &&
  node.time >= node.duration - END_SLACK_S
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i])

app.configure([
  { key: 'feedUrl', type: 'text', label: 'Virvi feed URL', initial: 'https://api.virvi.io' },
  { key: 'worldKey', type: 'text', label: 'Virvi world key', initial: '' },
])

if (world.isServer) runServer()
else runHud(runClient(), { app, world, fetch, setTimeout, props, Matrix4, uuid })

function runServer(): void {
  const feedUrl = (props.feedUrl || 'https://api.virvi.io').trim().replace(/\/+$/, '')
  const worldKey = (props.worldKey || '').trim()
  runLinkRelay({ app, world, setTimeout, vouch: app.virviVouch })
  if (!worldKey) {
    console.log('[virvi] set this app\'s world key (from Virvi: Connect your own Hyperfy world)')
    return
  }
  let latest: SceneMessage | null = null

  new FeedPoller({
    feedUrl,
    worldKey,
    fetch,
    setTimeout,
    onSnapshot: (r) => {
      // Pinned to the world's shared clock here, so visitors' own clocks don't matter (scheduled showings).
      latest = typeof r.serverTime === 'number' ? { ...r, clockOffsetMs: virviClockOffset(r.serverTime, world.getTime()) } : r
      app.send(SCENE, latest)
    },
  }).start()

  app.on(HELLO, (_data, playerId) => {
    if (latest && playerId) app.sendTo(playerId, SCENE, latest)
  })

  const visits = new VisitRecorder({
    feedUrl,
    worldKey,
    fetch,
    setTimeout,
    now: () => Date.now(),
    // Positions go to Virvi in its own frame: world -> app-local (wherever the owner placed the app) -> z mirrored.
    getPlayers: () => {
      const inverse = new Matrix4().copy(app.matrixWorld).invert()
      return world.getPlayers().map((p) => ({ id: p.id, position: toVirviPosition(worldToLocal(p.position, inverse)) }))
    },
  })
  world.on('enter', (e) => visits.enter(e.playerId))
  world.on('leave', (e) => visits.leave(e.playerId))
  visits.start()
}

export type { ClientEditHooks } from './sandbox.js'

function runClient(): ClientEditHooks {
  /**
   * `track`: for a playlist screen, the index of the playlist video it is showing. `view`/`seek`: for a scheduled
   * screen, what it is showing and its video's seeks.
   */
  type Shown = { item: RenderItem; node: HNode | null; track: number; view?: ScheduledView; seek?: SeekState }
  let plan: RenderItem[] = []
  const shown = new Map<string, Shown>()
  /** Scheduled screens' showings by element id, and Virvi's clock minus the world's (from the latest snapshot). */
  let showings = new Map<string, ShowingInstance[]>()
  let clockOffsetMs: number | null = null
  const virviNow = () => (clockOffsetMs === null ? Date.now() : world.getTime() * 1000 + clockOffsetMs)
  const elementOf = (key: string) => key.slice(0, key.indexOf(':'))
  const viewOf = (item: RenderItem) => scheduledView(showings.get(elementOf(item.key)) ?? [], virviNow(), item.schedule?.holdingImage ?? '')
  /** Edit mode's drafts shown in place of the feed transform, by key, until restored. */
  const previews = new Map<string, VirviTransform>()
  let editing = false
  let select: (key: string) => void = () => {}
  const planListeners: Array<(prev: RenderItem[], next: RenderItem[], scene: SerializedScene | null) => void> = []

  const setClick = (node: HNode, item: RenderItem) => {
    node.onPointerDown = clickHandler(item, editing, { select: (key) => select(key), open: (url) => world.open(url, true) })
  }

  /** Sets the Virvi transform as the node's local transform. Planes and sounds take no scale: a plane's Virvi
   * scale is its width and height (see `plane`), so scaling the node as well would size it twice. */
  const place = (node: HNode, item: RenderItem, t: HyperfyTransform = item.transform) => {
    const { position: p, rotation: r, scale: s } = t
    node.position.fromArray(p)
    node.rotation.set(r[0], r[1], r[2], 'YXZ')
    node.scale.fromArray(item.kind === 'model' ? s : [1, 1, 1])
    if (item.kind === 'video' || item.kind === 'image') {
      node.width = s[0]
      node.height = s[1]
    }
  }

  /** The transform to show: edit mode's draft if there is one, else the feed's. */
  const shownTransform = (item: RenderItem): HyperfyTransform => {
    const draft = previews.get(item.key)
    return draft ? toHyperfyTransform(draft) : item.transform
  }

  const plane = (type: 'video' | 'image', item: RenderItem, src = item.src): HNode => {
    const node = app.create(type)
    node.src = src
    // A Virvi plane is 1 m times its scale, so its scale is the plane's size
    node.width = item.width
    node.height = item.height
    node.fit = 'none'
    node.doubleside = true
    if (type === 'image') node.color = 'transparent'
    else {
      node.loop = item.loop
      node.volume = item.volume
    }
    return node
  }

  const add = (item: RenderItem, track = 0) => {
    const entry: Shown = { item, node: null, track }
    shown.set(item.key, entry)
    if (item.kind === 'model') {
      world
        .load('model', item.src)
        .then((model) => {
          if (shown.get(item.key) !== entry) return // removed or replaced while loading
          // The group carries the Virvi transform; the model turns inside it to face the way Decentraland shows it.
          const group = app.create('group')
          place(group, item, shownTransform(item))
          setClick(group, item)
          model.rotation.set(MODEL_TURN[0], MODEL_TURN[1], MODEL_TURN[2], 'YXZ')
          group.add(model)
          entry.node = group
          app.add(group)
        })
        .catch((err: unknown) => console.warn(`[virvi] model ${item.src} failed to load`, err))
      return
    }
    let node: HNode
    if (item.schedule) {
      const view = viewOf(item)
      entry.view = view
      watchScreens()
      if (view.type === 'none') return
      node = plane(view.type, item, view.src)
      if (view.type === 'video') {
        node.loop = false
        entry.seek = newSeekState()
      }
    } else if (item.kind === 'audio') {
      node = app.create('audio')
      node.src = item.src
      node.loop = item.loop
      node.volume = item.volume
    } else {
      node = plane(item.kind, item, item.playlist[track] ?? item.src)
    }
    place(node, item, shownTransform(item))
    setClick(node, item)
    entry.node = node
    app.add(node)
    node.play?.()
    if (item.playlist.length > 1) watchScreens()
  }

  const remove = (key: string) => {
    const entry = shown.get(key)
    if (!entry) return
    shown.delete(key)
    if (entry.node) app.remove(entry.node)
  }

  /** A scheduled screen changes picture when the show moves on, and keeps its video where the shared show is. */
  const checkScheduled = (entry: Shown) => {
    const view = viewOf(entry.item)
    if (view.key !== entry.view?.key) {
      remove(entry.item.key)
      add(entry.item)
      return
    }
    const { node, seek } = entry
    if (view.type !== 'video' || !node || !seek) return
    if (seekAction(seek, Date.now(), view.offset, view.duration, node)) node.time = view.offset
  }

  /**
   * Each playlist screen whose video has ended gets a fresh node for the next video (the last is followed by the
   * first); scheduled screens follow the clock.
   */
  let watching = false
  const checkScreens = () => {
    let any = false
    for (const entry of [...shown.values()]) {
      if (entry.item.schedule) {
        any = true
        checkScheduled(entry)
        continue
      }
      const { item, node, track } = entry
      if (item.playlist.length < 2 || !node) continue
      any = true
      if (!videoEnded(node)) continue
      remove(item.key)
      add(item, (track + 1) % item.playlist.length)
    }
    watching = any
    if (any) setTimeout(checkScreens, PLAYLIST_CHECK_MS)
  }
  const watchScreens = () => {
    if (watching) return
    watching = true
    setTimeout(checkScreens, PLAYLIST_CHECK_MS)
  }

  app.on(SCENE, (data) => {
    const r = data as SceneMessage
    showings = new Map((r?.showings ?? []).map((s) => [s.elementId, s.showings]))
    if (typeof r?.clockOffsetMs === 'number') clockOffsetMs = r.clockOffsetMs
    let next: RenderItem[]
    try {
      next = planScene(r?.scene ?? null)
    } catch (err) {
      return console.warn('[virvi] could not read the scene', err)
    }
    const d = diffPlans(plan, next)
    for (const key of d.remove) remove(key)
    for (const item of d.update) {
      // A screen that kept its playlist (moved, renamed, volume) stays on the video it was showing.
      const old = shown.get(item.key)
      const track = old && sameList(old.item.playlist, item.playlist) ? old.track : 0
      remove(item.key)
      add(item, track)
    }
    for (const item of d.add) add(item)
    // A preview ends with its item, or once the feed carries it (a save came back).
    for (const [key, t] of [...previews]) {
      const entry = shown.get(key)
      if (!entry || sameTransform(entry.item.virvi, t)) previews.delete(key)
    }
    const prev = plan
    plan = next
    for (const cb of planListeners) cb(prev, next, r?.scene ?? null)
  })

  app.send(HELLO, null)

  return {
    setEditing(on, onSelect) {
      editing = on
      select = onSelect
      for (const { item, node } of shown.values()) if (node) setClick(node, item)
    },
    items: () => new Map([...shown.values()].map(({ item }) => [item.key, renderedItem(item)])),
    preview(key, t) {
      const entry = shown.get(key)
      if (!entry) return
      previews.set(key, t)
      if (entry.node) place(entry.node, entry.item, toHyperfyTransform(t))
    },
    restore(key) {
      previews.delete(key)
      const entry = shown.get(key)
      if (entry?.node) place(entry.node, entry.item)
    },
    onPlan(cb) {
      planListeners.push(cb)
    },
  }
}
