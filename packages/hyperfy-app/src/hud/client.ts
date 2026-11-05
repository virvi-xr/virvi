import type { SerializedScene } from '@virvixr/shared'
import { TransformSession } from '@virvixr/core/transform/session'
import { EditController, type HudAlert } from '../edit/controller.js'
import { Gizmo, type GizmoNode } from '../edit/gizmo.js'
import { pointerRay } from '../edit/rays.js'
import { Pairing, type PairingState, type PassRenewer } from '../pairing.js'
import type { RenderItem } from '../plan.js'
import {
  LINK,
  type AppProps,
  type ClientEditHooks,
  type HApp,
  type HControl,
  type HWorld,
  type LinkReply,
  type LinkRequest,
  type Matrix4Ctor,
  type ScriptFetch,
  type ScriptSetTimeout,
} from '../sandbox.js'
import { toHyperfyTransform } from '../transform.js'
import { VirviApi, type ApiResult } from '../virvi-api.js'
import {
  alertsFromSnapshot,
  chatCommandText,
  chatEntry,
  failureAlert,
  loadFailureAlert,
  hudModel,
  inFrontOf,
  initialUi,
  pairingAlert,
  placeAsset,
  typeKey,
  type AssetEntry,
  type Axis,
  type HudUi,
} from './model.js'
import { HudView, type UiNode } from './view.js'

const LINK_REPLY_MS = 10_000
const ALERT_MS = 6_000

/** The sandbox globals the HUD uses. */
export interface HudSandbox {
  app: HApp
  world: HWorld
  fetch: ScriptFetch
  setTimeout: ScriptSetTimeout
  props: AppProps
  Matrix4: Matrix4Ctor
  uuid: () => string
}

/**
 * The HUD, for players who are admin or builder in this world (visitors get nothing: no nodes, no controls).
 *
 * Input (Hyperfy fires node pointer events only for the reticle while the pointer is locked, and for screen UI while
 * it is unlocked):
 * - Aim (pointer locked, Hyperfy's normal play): with edit mode on, clicking a Virvi object selects it; clicking the
 *   selected object again starts a body drag, and gizmo handles start handle drags. A drag follows the camera's
 *   forward ray until the mouse button is released.
 * - Panels (pointer unlocked with ` or Esc, Hyperfy's own toggles): the bar and panels are clickable; clicking the
 *   world locks the pointer again.
 * - Keys: L cycles the axis lock (Shift is Hyperfy's run key). While a field is being typed into, every key goes to
 *   it: digits, '-' and '.' for values, any character for searches, Enter commits, Escape cancels.
 * - Chat: Hyperfy's chat takes '/' and Enter ahead of apps, so a link can't be typed into the HUD. `/virvi <link>` in
 *   chat opens the Link tab with it (and `/virvi <words>` searches the catalog).
 */
export function runHud(hooks: ClientEditHooks, sandbox: HudSandbox): void {
  const { app, world, fetch, setTimeout, props, Matrix4, uuid } = sandbox
  const feedUrl = (props.feedUrl || 'https://api.virvi.io').trim().replace(/\/+$/, '')
  const worldKey = (props.worldKey || '').trim()
  let ui: HudUi = initialUi()
  let link: PairingState = { status: 'idle' }
  let scene: SerializedScene | null = null
  let plan: RenderItem[] = []
  const alerts: Array<HudAlert & { id: number }> = []
  let alertIds = 0
  let visible = false
  let control: HControl | null = null
  let gizmo: Gizmo | null = null
  let pairing: Pairing | null = null
  /**
   * Every LINK request carries a new attempt number and the server half echoes it. Answers are taken only for the
   * current link attempt or the pending renewal; anything older (or after falling back to browser pairing) is dropped.
   */
  let attempts = 0
  let linkAttempt = 0
  let renewAttempt = 0
  /** A hosted renewal waiting for the server half's answer. */
  let renewWaiter: ((r: Awaited<ReturnType<PassRenewer>>) => void) | null = null
  const ask = (): number => {
    const attempt = ++attempts
    const req: LinkRequest = { attempt }
    app.send(LINK, req)
    return attempt
  }
  let lastDrawn = ''

  const sceneId = () => (link.status === 'linked' ? link.sceneId : '')
  const rootInverse = () => new Matrix4().copy(app.matrixWorld).invert()

  const api = new VirviApi({
    feedUrl,
    fetch,
    getPass: () => pairing?.pass() ?? null,
    onAuthFailure: () => pairing?.renewOrExpire() ?? Promise.resolve(false),
  })
  const session = new TransformSession({ now: () => Date.now(), onDraft: () => {} })
  const controller = new EditController({
    session,
    api,
    items: () => hooks.items(),
    preview: (key, t) => hooks.preview(key, t),
    restore: (key) => hooks.restore(key),
    alert: (a) => pushAlert(a),
    rootInverse,
    onChange: () => redraw(),
    setTimeout,
  })

  // Built on first show, so a visitor's browser never gets HUD nodes.
  let view: HudView | null = null
  const makeView = () =>
    new HudView(
      {
        create: (type, data) => app.create(type, data) as unknown as UiNode,
        add: (n) => app.add(n),
        remove: (n) => app.remove(n),
      },
      {
        link: () => startLink(),
        openUrl: (url) => world.open(url, true),
        toggleEditing: () => setEditing(!ui.editing),
        setMode: (m) => controller.setMode(m),
        cycleLock: () => controller.cycleLock(),
        toggleSnap: () => controller.setSnap(!controller.state.snap),
        save: () => void controller.save(),
        revert: () => controller.revert(),
        done: () => controller.done(),
        typeAxis: (axis) =>
          controller.state.values && setUi({ typing: { target: axis, text: '' } }),
        typeKey: (prop, char) => void typeInto(prop, char),
        openPanel: (p) => {
          setUi({ panel: ui.panel === p ? null : p, typing: null })
          if (ui.panel === 'layout') void loadPresets()
          if (ui.panel === 'assets') void loadTab(ui.tab)
        },
        toggleEnabled: (id, on) => void request(api.setEnabled(id, on)),
        setPreset: (id) => void request(api.setPreset(sceneId(), id)),
        toggleLive: (id, on) => void request(api.setLive(id, on)),
        pickStream: (id) => {
          const open = ui.streamPicking !== id
          setUi({ streamPicking: open ? id : null })
          if (open) void loadStreams()
        },
        chooseStream: (id, streamId) => void chooseStream(id, streamId),
        setTab: (tab) => {
          setUi({ tab, chosen: null, typing: null })
          void loadTab(tab)
        },
        choose: (id) => setUi({ chosen: id }),
        typeField: (field) => setUi({ typing: { target: field, text: ui.query } }),
        place: () => void place(),
      },
      { iconSrc: typeof props.hudIcon?.url === 'string' ? props.hudIcon.url : null },
    )

  // ── alerts and drawing ───────────────────────────────────────────────

  function pushAlert(a: HudAlert | null): void {
    if (!a || !visible) return
    const id = ++alertIds
    alerts.push({ kind: a.kind, text: a.text, id })
    if (alerts.length > 10) alerts.shift()
    setTimeout(() => {
      const i = alerts.findIndex((x) => x.id === id)
      if (i >= 0) alerts.splice(i, 1)
      redraw()
    }, ALERT_MS)
    redraw()
  }

  function setUi(patch: Partial<HudUi>): void {
    ui = { ...ui, ...patch }
    redraw()
  }

  function redraw(): void {
    const vm = visible
      ? hudModel({
          pairing: link,
          edit: controller.state,
          plan,
          scene,
          alerts: alerts.map(({ kind, text }) => ({ kind, text })),
          ui,
        })
      : null
    const drawn = JSON.stringify(vm)
    if (drawn !== lastDrawn) {
      lastDrawn = drawn
      if (vm) view ??= makeView()
      view?.render(vm)
    }
    // The gizmo sits on the selected item (its draft while editing), in the app root's frame.
    const key = controller.state.selectedKey
    const t = session.draft ?? (key ? hooks.items().get(key)?.transform : undefined)
    if (gizmo)
      gizmo.show(
        controller.state.mode,
        ui.editing && key && t ? toHyperfyTransform(t).position : null,
      )
  }

  // ── linking ──────────────────────────────────────────────────────────

  function setLink(s: PairingState): void {
    const before = link
    link = s
    if (s.status !== 'idle' && ui.linking) ui = { ...ui, linking: false }
    pushAlert(pairingAlert(before, s))
    if (s.status === 'linked' && before.status !== 'linked') void loadPresets()
    // Edit mode stays on if the link lapses: the draft is kept, and Save works again once re-linked.
    redraw()
  }

  /** Hosted renewals ask the server half to vouch again; it answers with a fresh pass. */
  const hostedRenewer: PassRenewer = () =>
    new Promise((resolve) => {
      renewWaiter?.(null)
      renewWaiter = resolve
      renewAttempt = ask()
      setTimeout(() => {
        if (renewWaiter === resolve) {
          renewWaiter = null
          resolve(null)
        }
      }, LINK_REPLY_MS)
    })

  const newPairing = (renewer?: PassRenewer) => {
    pairing?.stop()
    pairing = new Pairing({
      feedUrl,
      worldKey,
      fetch,
      setTimeout,
      uuid,
      onState: setLink,
      ...(renewer ? { renewer } : {}),
    })
    return pairing
  }

  /** Asks the server half first: a hosted world vouches; anything else (or no answer) pairs from the browser. */
  function startLink(): void {
    setUi({ linking: true })
    const attempt = (linkAttempt = ask())
    setTimeout(() => {
      if (attempt === linkAttempt && ui.linking) pairSelf()
    }, LINK_REPLY_MS)
  }

  /** Pairs from the browser (self-run worlds, or no answer): drops any hosted attempt and its code card. */
  function pairSelf(): void {
    linkAttempt = 0
    setUi({ linking: true })
    setLink({ status: 'idle' })
    newPairing().start(world.getPlayer()?.name ?? '')
  }

  app.on(LINK, (data) => {
    const r = data as (LinkReply & { attempt?: unknown }) | null
    if (!r || typeof r !== 'object' || typeof r.attempt !== 'number' || r.attempt === 0) return
    let waiter: typeof renewWaiter = null
    if (renewWaiter && r.attempt === renewAttempt) {
      waiter = renewWaiter
      renewWaiter = null
    } else if (r.attempt !== linkAttempt) return // an answer to an older attempt
    switch (r.status) {
      case 'self':
        if (waiter) return waiter(null)
        pairSelf()
        return
      case 'linked':
        if (waiter)
          return waiter({ pass: r.pass, passExpiresAt: r.passExpiresAt, sceneId: r.sceneId })
        linkAttempt = 0
        setUi({ linking: false })
        newPairing(hostedRenewer).adopt({
          pass: r.pass,
          passExpiresAt: r.passExpiresAt,
          pairingId: r.pairingId,
          sceneId: r.sceneId,
          displayName: r.displayName,
        })
        return
      case 'unlinked':
        // A renewal that found no live pairing (revoked) gets a new code: show it, and take that attempt's answers.
        if (waiter) {
          pairing?.stop()
          waiter(null)
          linkAttempt = r.attempt
        }
        setUi({ linking: false })
        setLink({
          status: 'waiting',
          code: r.code,
          approveUrl: r.approveUrl,
          qrUrl: r.qrUrl,
          expiresAt: r.expiresAt,
        })
        return
      case 'expired':
        if (waiter) return waiter('revoked')
        linkAttempt = 0
        setUi({ linking: false })
        setLink({ status: 'expired' })
        return
      case 'lost':
        if (waiter) return waiter(null)
        linkAttempt = 0
        setUi({ linking: false })
        pushAlert(failureAlert('lost'))
        return
    }
  })

  // ── panels ───────────────────────────────────────────────────────────

  async function request(p: Promise<ApiResult<unknown>>): Promise<boolean> {
    const r = await p
    if (!r.ok) pushAlert(failureAlert(r.reason))
    return r.ok
  }

  /** The scene's streams for the Streams panel (LIV-53). */
  async function loadStreams(): Promise<void> {
    const id = sceneId()
    if (!id) return
    setUi({ streamList: null })
    const r = await api.listStreams(id)
    if (r.ok) setUi({ streamList: r.value })
    else {
      setUi({ streamList: [], streamPicking: null })
      pushAlert(failureAlert(r.reason))
    }
  }

  /** The screen plays the chosen stream; the new liveSrc arrives with the next feed snapshot. */
  async function chooseStream(elementId: string, streamId: string): Promise<void> {
    const stream = (ui.streamList ?? []).find((s) => s.id === streamId)
    const id = sceneId()
    if (!stream || !id) return
    if (await request(api.setLiveSource(id, elementId, stream.hlsPlaylistUrl))) setUi({ streamPicking: null })
  }

  async function loadPresets(): Promise<void> {
    const id = sceneId()
    if (!id) return
    const r = await api.getScene(id)
    if (r.ok) setUi({ presets: r.value.presets })
  }

  async function loadTab(tab: HudUi['tab']): Promise<void> {
    const id = sceneId()
    if (!id || tab === 'link') return
    if (tab === 'library') {
      setUi({ library: null })
      const r = await api.listLibrary(id)
      if (!r.ok) pushAlert(loadFailureAlert(r.reason))
      const entries: AssetEntry[] = r.ok
        ? r.value
            .filter((e) => e.kind === 'model' && e.url)
            .map((e) => ({ id: e.id, name: e.name || 'Model', src: e.url, source: 'library' }))
        : []
      setUi({ library: entries })
    } else {
      setUi({ catalog: null })
      const r = await api.listCatalog(ui.query)
      if (!r.ok) pushAlert(loadFailureAlert(r.reason))
      const entries: AssetEntry[] = r.ok
        ? r.value.assets
            .filter((a) => a.cdnUrl)
            .map((a) => ({ id: a.id, name: a.name || 'Model', src: a.cdnUrl!, source: 'catalog' }))
        : []
      setUi({ catalog: entries })
    }
  }

  async function place(): Promise<void> {
    const me = world.getPlayer()
    const presetId = typeof scene?.sk === 'string' ? scene.sk : ''
    const list = ui.tab === 'library' ? ui.library : ui.tab === 'catalog' ? ui.catalog : null
    const entry: AssetEntry | undefined =
      ui.tab === 'link'
        ? { id: 'link', name: 'Model', src: ui.linkUrl.trim(), source: 'link' }
        : list?.find((e) => e.id === ui.chosen)
    if (!me || !control || !entry || !presetId || ui.placing) return
    setUi({ placing: true })
    await placeAsset({
      api,
      sceneId: sceneId(),
      presetId,
      entry,
      transform: inFrontOf(control.camera, me.position.y, rootInverse()),
      alert: pushAlert,
    })
    setUi({ placing: false })
  }

  // ── edit mode and input ──────────────────────────────────────────────

  const ray = () => {
    const c = control!
    const pointer = c.pointer.locked
      ? null
      : {
          x: c.pointer.coords.x,
          y: c.pointer.coords.y,
          aspect: c.screen.width / (c.screen.height || 1),
        }
    return pointerRay(c.camera, pointer)
  }

  /** A click on a Virvi node while editing: select it, or (already selected) grab it. */
  const onNodeClick = (key: string) => {
    if (!control) return
    if (controller.state.selectedKey === key) controller.pointerDown(null, ray())
    else controller.select(key)
  }

  function setEditing(on: boolean): void {
    if (!on && controller.done() === 'dirty') return // the bar asks Save or Revert first
    if (on && !gizmo) {
      gizmo = new Gizmo(
        {
          create: (type, data) => app.create(type as 'prim', data) as unknown as GizmoNode,
          add: (n) => app.add(n),
          remove: (n) => app.remove(n),
        },
        {
          down: (h) => control && controller.pointerDown(h, ray()),
          enter: (h) => gizmo?.highlight(h),
          leave: () => gizmo?.highlight(null),
        },
      )
    }
    hooks.setEditing(on, onNodeClick)
    setUi({ editing: on, typing: null })
  }

  /** One key into the field being typed (the keyboard, or the exact-value panel's on-screen keys). */
  function typeInto(prop: string, text: string): boolean {
    const typing = ui.typing
    if (!typing) return false
    const isAxis = typing.target === 'x' || typing.target === 'y' || typing.target === 'z'
    const r = typeKey(typing.text, prop, text, isAxis ? 'number' : 'text')
    if (r.action === 'cancel') setUi({ typing: null })
    else if (r.action === 'commit') {
      setUi({ typing: null })
      if (isAxis) {
        const v = Number(r.text)
        if (r.text.trim() && Number.isFinite(v)) controller.setValue(typing.target as Axis, v)
      } else {
        setUi({ query: r.text })
        void loadTab('catalog')
      }
    } else setUi({ typing: { target: typing.target, text: r.text } })
    return true
  }

  function bindControl(): HControl {
    const c = app.control()
    c.keyL.onPress = () => {
      if (!ui.editing || ui.typing) return
      controller.cycleLock()
      return true
    }
    c.onButtonPress = (prop, text) => typeInto(prop, text)
    return c
  }

  world.on('command', (e) => {
    const me = world.getPlayer()
    if (!visible || link.status !== 'linked' || !me || e.playerId !== me.id) return
    const text = chatCommandText(e)
    const entry = text === null ? null : chatEntry(text)
    if (!entry) return
    if (entry.tab === 'link')
      setUi({ panel: 'assets', tab: 'link', linkUrl: entry.linkUrl, chosen: null, typing: null })
    else {
      setUi({ panel: 'assets', tab: 'catalog', query: entry.query, chosen: null, typing: null })
      void loadTab('catalog')
    }
  })

  hooks.onPlan((prev, next, sc) => {
    if (link.status === 'linked') for (const a of alertsFromSnapshot(scene, sc)) pushAlert(a)
    scene = sc
    plan = next
    controller.onSnapshot(prev, next)
    redraw()
  })

  app.on('update', () => {
    const me = world.getPlayer()
    const allowed = !!me && (!!me.admin || !!me.builder)
    if (allowed !== visible) {
      if (!allowed && ui.editing) {
        controller.revert()
        controller.done()
        hooks.setEditing(false, onNodeClick)
        ui = { ...ui, editing: false, typing: null }
      }
      if (!allowed) {
        // Demoted: drop the link, so this browser stops renewing a pass it may no longer use.
        pairing?.stop()
        pairing = null
        renewWaiter?.(null)
        renewWaiter = null
        linkAttempt = 0
        link = { status: 'idle' }
        ui = { ...ui, linking: false, panel: null }
      }
      visible = allowed
      if (visible && !control) control = bindControl()
      redraw()
    }
    if (!visible || !control) return
    if (controller.state.dragging) {
      if (!control.mouseLeft.down || control.mouseLeft.released) controller.pointerUp()
      else controller.pointerMove(ray())
    }
  })
}
