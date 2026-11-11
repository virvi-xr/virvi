import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { SerializedScene } from '@virvixr/shared'
import type { EditState, HudAlert } from '../src/edit/controller.js'
import {
  ALERT_LINK_EXPIRED,
  ALERT_PLACED,
  ALERT_STREAM_LIVE,
  ALERT_STREAM_OFFLINE,
  LINK_HINT,
  alertsFromSnapshot,
  clearCopiesPrompt,
  offImageChoices,
  offImageLabel,
  showingRow,
  showControlAlert,
  timeLeft,
  NO_SHOWINGS,
  SHOWINGS_LOADING,
  clearedAlert,
  chatCommandText,
  chatEntry,
  failureAlert,
  loadFailureAlert,
  hudModel,
  inFrontOf,
  pairingAlert,
  placeAsset,
  typeKey,
  type AssetEntry,
  type HudState,
} from '../src/hud/model.js'
import { planScene } from '../src/plan.js'
import type { ApiResult } from '../src/virvi-api.js'

const edit = (over: Partial<EditState> = {}): EditState => ({
  selectedKey: null,
  selectedName: null,
  mode: 'move',
  lock: 'free',
  snap: false,
  dirty: false,
  dragging: false,
  saving: false,
  prompt: false,
  values: null,
  ...over,
})

const inst = (sk: string) => ({
  sk,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
})

const scene = (over: Partial<SerializedScene> = {}): SerializedScene => ({
  sk: 'preset-a',
  videos: [
    {
      sk: 'v1',
      name: 'Main screen',
      enabled: true,
      enableLiveStream: true,
      isLive: false,
      offType: 2,
      playlist: ['https://x/a.mp4'],
      instances: [inst('vi1')],
    },
  ],
  images: [
    {
      sk: 'im1',
      name: 'Poster',
      enabled: false,
      textureSrc: 'https://x/p.png',
      instances: [inst('ii1')],
    },
  ],
  models: [{ sk: 'm1', name: 'Tree', modelSrc: 'https://x/t.glb', instances: [inst('mi1')] }],
  sounds: [],
  ...over,
})

const linked = { status: 'linked' as const, displayName: 'Ada', sceneId: 'scene-1' }

function state(over: Partial<HudState> = {}): HudState {
  const sc = scene()
  return { pairing: linked, edit: edit(), plan: planScene(sc), scene: sc, alerts: [], ...over }
}

describe('hudModel', () => {
  it('link card: a Link button when idle, the formatted code and QR while waiting, the name when linked', () => {
    const idle = hudModel(state({ pairing: { status: 'idle' } }))
    expect(idle.link).toMatchObject({ status: 'idle', label: 'Link to Virvi', canLink: true })
    expect(idle.linked).toBe(false)
    expect(idle.bar).toBeNull()

    const waiting = hudModel(
      state({
        pairing: {
          status: 'waiting',
          code: 'ABC234',
          approveUrl: 'https://virvi.io/pair/ABC234',
          qrUrl: 'https://api/qr.png',
          expiresAt: 'x',
        },
      }),
    )
    expect(waiting.link).toMatchObject({
      status: 'waiting',
      code: 'ABC-234',
      approveUrl: 'https://virvi.io/pair/ABC234',
      qrUrl: 'https://api/qr.png',
      canLink: false,
    })

    const done = hudModel(state())
    expect(done.link).toMatchObject({
      status: 'linked',
      label: 'Linked to Virvi as Ada',
      canLink: false,
    })
    expect(done.linked).toBe(true)

    expect(hudModel(state({ pairing: { status: 'expired' } })).link).toMatchObject({
      label: ALERT_LINK_EXPIRED,
      canLink: true,
    })
    expect(hudModel(state({ pairing: { status: 'lost' } })).link.label).toBe(
      'Lost connection to Virvi. Retrying…',
    )
  })

  it('edit bar: mode, lock, dirty, selected name, and the current values', () => {
    const vm = hudModel(
      state({
        edit: edit({
          selectedKey: 'm1:mi1',
          selectedName: 'Tree',
          mode: 'rotate',
          lock: 'y',
          dirty: true,
          values: { x: 1, y: -2.5, z: 90 },
        }),
        ui: { editing: true },
      }),
    )
    expect(vm.bar).toMatchObject({
      editing: true,
      mode: 'rotate',
      lock: 'y',
      lockLabel: 'Y',
      dirty: true,
      selectedName: 'Tree',
    })
    expect(vm.bar!.values).toEqual([
      { axis: 'x', text: '1.00', typing: false },
      { axis: 'y', text: '-2.50', typing: false },
      { axis: 'z', text: '90.00', typing: false },
    ])
    expect(vm.bar!.hint).toContain('L')
    // typing into an axis shows the typed text
    const typing = hudModel(
      state({
        edit: edit({ selectedKey: 'm1:mi1', values: { x: 1, y: 2, z: 3 } }),
        ui: { editing: true, typing: { target: 'y', text: '-1.' } },
      }),
    )
    expect(typing.bar!.values![1]).toEqual({ axis: 'y', text: '-1._', typing: true })
    // nothing selected: no values
    expect(hudModel(state({ ui: { editing: true } })).bar!.values).toBeNull()
  })

  it('scene layout: every element with its enabled toggle, presets with the active one', () => {
    const vm = hudModel(
      state({
        ui: {
          panel: 'layout',
          presets: [
            { id: 'preset-a', name: 'Day' },
            { id: 'preset-b', name: 'Night' },
          ],
        },
      }),
    )
    expect(vm.panel).toBe('layout')
    expect(vm.layout.items).toEqual([
      { elementId: 'v1', kind: 'video', name: 'Main screen', enabled: true, copies: 1, clearPrompt: null },
      { elementId: 'im1', kind: 'image', name: 'Poster', enabled: false, copies: 1, clearPrompt: null },
      { elementId: 'm1', kind: 'model', name: 'Tree', enabled: true, copies: 1, clearPrompt: null },
    ])
    expect(vm.layout.presets).toEqual([
      { id: 'preset-a', name: 'Day', active: true },
      { id: 'preset-b', name: 'Night', active: false },
    ])
  })

  it('streams: each video with enableLiveStream and isLive', () => {
    const sc = scene({
      videos: [
        { sk: 'v1', name: 'Main screen', enableLiveStream: true, isLive: true, instances: [] },
        { sk: 'v2', name: '', enableLiveStream: false, instances: [] },
      ],
    })
    const vm = hudModel(state({ scene: sc, ui: { panel: 'streams' } }))
    expect(vm.streams).toEqual([
      { elementId: 'v1', name: 'Main screen', enableLiveStream: true, isLive: true, source: 'No stream', picking: false, offImage: 'No off image', imagePicking: false, scheduled: false, showingsOpen: false },
      { elementId: 'v2', name: 'Screen', enableLiveStream: false, isLive: false, source: 'No stream', picking: false, offImage: 'No off image', imagePicking: false, scheduled: false, showingsOpen: false },
    ])
    expect(vm.streamOptions).toEqual([])
  })

  it('streams: names what each screen plays, and lists the scene streams to choose from (LIV-53)', () => {
    const sc = scene({
      videos: [
        { sk: 'v1', name: 'Main', liveSrc: 'https://live/main.m3u8', instances: [] },
        { sk: 'v2', name: 'Side', liveSrc: ' https://elsewhere/x.m3u8 ', instances: [] },
      ],
    })
    const streamList = [
      { id: 's1', name: 'Main Stage', hlsPlaylistUrl: 'https://live/main.m3u8', live: true, mine: false },
      { id: 's2', name: 'Editor Cam', hlsPlaylistUrl: 'https://live/cam.m3u8', live: false, mine: true },
    ]
    const vm = hudModel(state({ scene: sc, ui: { panel: 'streams', streamList, streamPicking: 'v1' } }))
    expect(vm.streams.map((s) => [s.elementId, s.source, s.picking])).toEqual([
      ['v1', 'Main Stage (live)', true],
      ['v2', 'Custom link', false],
    ])
    expect(vm.streamOptions).toEqual([
      { id: 's1', label: 'Main Stage (live)', current: true },
      { id: 's2', label: 'Editor Cam (offline, yours)', current: false },
    ])
    // Still loading, or none set up
    expect(hudModel(state({ scene: sc, ui: { panel: 'streams', streamList: null, streamPicking: 'v1' } })).streamsNote).toBe('Loading streams…')
    expect(hudModel(state({ scene: sc, ui: { panel: 'streams', streamList: [], streamPicking: 'v1' } })).streamsNote).toBe('No streams yet: set one up on the Streaming page at virvi.io')
    expect(hudModel(state({ scene: sc, ui: { panel: 'streams', streamList } })).streamsNote).toBeNull()
  })

  it('asset browser: Library, Catalog and Link tabs, the chosen entry, and Place in front of me', () => {
    const library = [
      { id: 'l1', name: 'Bench', src: 'https://x/bench.glb', source: 'library' as const },
      { id: 'l2', name: 'Lamp', src: 'https://x/lamp.glb', source: 'library' as const },
    ]
    const vm = hudModel(state({ ui: { panel: 'assets', tab: 'library', library, chosen: 'l2' } }))
    expect(vm.assets.tabs).toEqual(['library', 'catalog', 'link'])
    expect(vm.assets.tab).toBe('library')
    expect(vm.assets.entries.map((e) => [e.id, e.chosen])).toEqual([
      ['l1', false],
      ['l2', true],
    ])
    expect(vm.assets.placeLabel).toBe('Place in front of me')
    expect(vm.assets.canPlace).toBe(true)
    // nothing chosen, or no active preset: can't place
    expect(
      hudModel(state({ ui: { panel: 'assets', tab: 'library', library } })).assets.canPlace,
    ).toBe(false)
    expect(
      hudModel(
        state({ scene: null, ui: { panel: 'assets', tab: 'library', library, chosen: 'l1' } }),
      ).assets.canPlace,
    ).toBe(false)
    // catalog loading
    expect(
      hudModel(state({ ui: { panel: 'assets', tab: 'catalog', catalog: null } })).assets,
    ).toMatchObject({ loading: true, entries: [] })
    // link: a typed GLB URL can be placed
    const link = hudModel(
      state({ ui: { panel: 'assets', tab: 'link', linkUrl: 'https://x/a.glb' } }),
    )
    expect(link.assets).toMatchObject({ linkUrl: 'https://x/a.glb', canPlace: true })
    expect(
      hudModel(state({ ui: { panel: 'assets', tab: 'link', linkUrl: 'not a url' } })).assets
        .canPlace,
    ).toBe(false)
  })

  it('alert stack: newest last, at most three', () => {
    const alerts: HudAlert[] = ['a', 'b', 'c', 'd'].map((text) => ({ kind: 'info', text }))
    expect(hudModel(state({ alerts })).alerts.map((a) => a.text)).toEqual(['b', 'c', 'd'])
  })

  it('an expired link keeps the edit bar (and its draft) while editing, next to the Link button', () => {
    const vm = hudModel(
      state({
        pairing: { status: 'expired' },
        edit: edit({
          selectedKey: 'm1:mi1',
          selectedName: 'Tree',
          dirty: true,
          values: { x: 1, y: 2, z: 3 },
        }),
        ui: { editing: true },
      }),
    )
    expect(vm.linked).toBe(false)
    expect(vm.link).toMatchObject({ label: ALERT_LINK_EXPIRED, canLink: true })
    expect(vm.bar).toMatchObject({ editing: true, dirty: true, selectedName: 'Tree' })
    expect(hudModel(state({ pairing: { status: 'expired' } })).bar).toBeNull()
  })

  it('panels need a link', () => {
    const vm = hudModel(state({ pairing: { status: 'idle' }, ui: { panel: 'layout' } }))
    expect(vm.panel).toBeNull()
  })
})

describe('alertsFromSnapshot', () => {
  const live = (isLive: boolean) =>
    scene({ videos: [{ sk: 'v1', name: 'Main', isLive, enableLiveStream: true, instances: [] }] })

  it('says the stream is live when isLive turns on', () => {
    expect(alertsFromSnapshot(live(false), live(true))).toEqual([
      { kind: 'info', text: ALERT_STREAM_LIVE },
    ])
  })

  it('says the stream went offline when isLive turns off', () => {
    expect(alertsFromSnapshot(live(true), live(false))).toEqual([
      { kind: 'info', text: ALERT_STREAM_OFFLINE },
    ])
  })

  it('says nothing for the first snapshot, an unchanged stream, or a new screen', () => {
    expect(alertsFromSnapshot(null, live(true))).toEqual([])
    expect(alertsFromSnapshot(live(true), live(true))).toEqual([])
    expect(alertsFromSnapshot(scene({ videos: [] }), live(true))).toEqual([])
  })
})

describe('pairingAlert and failureAlert', () => {
  it('maps link changes to the fixed copy', () => {
    expect(
      pairingAlert(
        { status: 'waiting', code: 'A', approveUrl: '', qrUrl: '', expiresAt: '' },
        linked,
      ),
    ).toEqual({ kind: 'info', text: 'Linked to Virvi as Ada' })
    expect(pairingAlert(linked, { status: 'expired' })).toEqual({
      kind: 'error',
      text: 'Link expired. Pair again.',
    })
    expect(pairingAlert(linked, { status: 'lost' })).toEqual({
      kind: 'error',
      text: 'Lost connection to Virvi. Retrying…',
    })
    expect(pairingAlert({ status: 'lost' }, linked)).toEqual({ kind: 'info', text: 'Reconnected' })
    expect(pairingAlert(linked, linked)).toBeNull()
  })

  it('maps API failures to the fixed copy (auth is shown by the link state)', () => {
    expect(failureAlert('no_access')).toEqual({
      kind: 'error',
      text: "You can't edit this right now",
    })
    expect(failureAlert('lost')).toEqual({
      kind: 'error',
      text: 'Lost connection to Virvi. Retrying…',
    })
    expect(failureAlert('server')).toEqual({ kind: 'error', text: "Couldn't save: server" })
    expect(failureAlert('auth')).toBeNull()
  })
})

describe('loadFailureAlert', () => {
  it('a failed library or catalog load says it could not load, not save', () => {
    expect(loadFailureAlert('server')).toEqual({ kind: 'error', text: "Couldn't load: server" })
    expect(loadFailureAlert('invalid')).toEqual({ kind: 'error', text: "Couldn't load: invalid" })
    expect(loadFailureAlert('lost')).toEqual({
      kind: 'error',
      text: 'Lost connection to Virvi. Retrying…',
    })
    expect(loadFailureAlert('no_access')).toEqual({
      kind: 'error',
      text: "You can't edit this right now",
    })
    expect(loadFailureAlert('auth')).toBeNull()
  })
})

describe('exact-value keypad (no text input in Hyperfy)', () => {
  const typingY = (text: string) =>
    hudModel(state({ edit: edit({ selectedKey: 'm1:mi1', values: { x: 1, y: 2, z: 3 } }), ui: { editing: true, typing: { target: 'y', text } } }))

  it('typing an axis shows on-screen digits, minus, point, backspace, Enter and Esc', () => {
    const pad = typingY('').bar!.keypad!
    expect(pad.map((k) => k.label)).toEqual(['7', '8', '9', '4', '5', '6', '1', '2', '3', '-', '0', '.', '⌫', 'Enter', 'Esc'])
    expect(pad.find((k) => k.label === '⌫')).toEqual({ label: '⌫', prop: 'backspace', char: 'Backspace' })
    expect(pad.find((k) => k.label === 'Enter')).toEqual({ label: 'Enter', prop: 'enter', char: 'Enter' })
    expect(pad.find((k) => k.label === 'Esc')).toEqual({ label: 'Esc', prop: 'escape', char: 'Escape' })
    // not typing an axis: no keypad
    expect(hudModel(state({ edit: edit({ selectedKey: 'm1:mi1', values: { x: 1, y: 2, z: 3 } }), ui: { editing: true } })).bar!.keypad).toBeNull()
    expect(hudModel(state({ ui: { editing: true, typing: { target: 'search', text: '' } } })).bar!.keypad).toBeNull()
  })

  it('pressing the on-screen keys types the value the same way the keyboard does', () => {
    const pad = typingY('').bar!.keypad!
    const press = (text: string, label: string) => {
      const k = pad.find((x) => x.label === label)!
      return typeKey(text, k.prop, k.char, 'number')
    }
    let text = ''
    for (const label of ['-', '1', '.', '5', '⌫', '2']) text = press(text, label).text
    expect(text).toBe('-1.2')
    expect(press(text, 'Enter')).toEqual({ text: '-1.2', action: 'commit' })
    expect(press(text, 'Esc')).toEqual({ text: '-1.2', action: 'cancel' })
  })
})

describe('typeKey', () => {
  it('numbers take digits, a minus and a point; Enter commits, Escape cancels, Backspace deletes', () => {
    expect(typeKey('1', 'digit2', '2', 'number')).toEqual({ text: '12', action: 'none' })
    expect(typeKey('', 'minus', '-', 'number')).toEqual({ text: '-', action: 'none' })
    expect(typeKey('1', 'keyA', 'a', 'number')).toEqual({ text: '1', action: 'none' })
    expect(typeKey('12', 'backspace', 'Backspace', 'number')).toEqual({ text: '1', action: 'none' })
    expect(typeKey('12', 'enter', 'Enter', 'number')).toEqual({ text: '12', action: 'commit' })
    expect(typeKey('12', 'escape', 'Escape', 'number')).toEqual({ text: '12', action: 'cancel' })
  })

  it('text takes any printable character', () => {
    expect(typeKey('https', 'semicolon', ':', 'text')).toEqual({ text: 'https:', action: 'none' })
    expect(typeKey('a', 'shiftLeft', 'Shift', 'text')).toEqual({ text: 'a', action: 'none' })
  })
})

describe('placement', () => {
  it('puts a model 2 m in front of the camera, on the floor, in Virvi coordinates', () => {
    // Camera at (0, 1.6, 0) looking down Hyperfy -z and a little down; the floor is at y = 0.
    const q = new Quaternion().setFromEuler(new Euler(-0.3, 0, 0, 'YXZ'))
    const t = inFrontOf({ position: { x: 0, y: 1.6, z: 0 }, quaternion: q }, 0, new Matrix4())
    expect(t.position.x).toBeCloseTo(0)
    expect(t.position.y).toBeCloseTo(0)
    expect(t.position.z).toBeCloseTo(2) // Hyperfy -2 is Virvi +2
    expect(t.scale).toEqual({ x: 1, y: 1, z: 1 })
  })

  it('goes through the app root: an app moved to (10, 0, 0) and turned 90° about Y', () => {
    const root = new Matrix4().compose(
      new Vector3(10, 0, 0),
      new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)),
      new Vector3(1, 1, 1),
    )
    // Facing world -x from (10, 1.7, 0): 2 m ahead is world (8, 0, 0), app-local (0, 0, -2), Virvi (0, 0, 2).
    const q = new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0, 'YXZ'))
    const t = inFrontOf(
      { position: { x: 10, y: 1.7, z: 0 }, quaternion: q },
      0,
      new Matrix4().copy(root).invert(),
    )
    expect(t.position.x).toBeCloseTo(0)
    expect(t.position.y).toBeCloseTo(0)
    expect(t.position.z).toBeCloseTo(2)
  })
})

describe('placeAsset', () => {
  const where = {
    position: { x: 1, y: 0, z: 2 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  }
  const ok = <T>(value: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, value })

  it('placing a model emits the redeploy alert', async () => {
    const calls: unknown[][] = []
    const alerts: HudAlert[] = []
    const api = {
      addFromCatalog: (...a: unknown[]) => (calls.push(['addFromCatalog', ...a]), ok({})),
      placeModel: (...a: unknown[]) => (
        calls.push(['placeModel', ...a]),
        ok({ elementId: 'e', instanceId: 'i' })
      ),
    }
    const placed = await placeAsset({
      api,
      sceneId: 'scene-1',
      presetId: 'preset-a',
      entry: { id: 'c1', name: 'Rock', src: 'https://cdn/rock.glb', source: 'catalog' },
      transform: where,
      alert: (a) => alerts.push(a),
    })
    expect(placed).toBe(true)
    expect(calls).toEqual([
      ['addFromCatalog', 'scene-1', { id: 'c1' }],
      ['placeModel', 'preset-a', 'https://cdn/rock.glb', where, 'Rock'],
    ])
    expect(alerts).toEqual([{ kind: 'info', text: ALERT_PLACED }])
  })

  it('a library or link model is placed directly; a failure alerts instead', async () => {
    const calls: string[] = []
    const alerts: HudAlert[] = []
    const api = {
      addFromCatalog: () => (calls.push('addFromCatalog'), ok({})),
      placeModel: (): Promise<ApiResult<{ elementId: string; instanceId: string }>> => (
        calls.push('placeModel'),
        Promise.resolve({ ok: false, reason: 'no_access' })
      ),
    }
    const placed = await placeAsset({
      api,
      sceneId: 's',
      presetId: 'p',
      entry: { id: 'link', name: 'a', src: 'https://x/a.glb', source: 'link' },
      transform: where,
      alert: (a) => alerts.push(a),
    })
    expect(placed).toBe(false)
    expect(calls).toEqual(['placeModel'])
    expect(alerts).toEqual([{ kind: 'error', text: "You can't edit this right now" }])
  })

  it('a library model is named after its library name, a pasted link after its URL', async () => {
    const named: unknown[] = []
    const api = {
      addFromCatalog: () => ok({}),
      placeModel: (_p: string, _s: string, _t: unknown, name?: string) => (named.push(name), ok({ elementId: 'e', instanceId: 'i' })),
    }
    const place = (entry: AssetEntry) => placeAsset({ api, sceneId: 's', presetId: 'p', entry, transform: where, alert: () => {} })
    await place({ id: 'l1', name: 'Chair.glb', src: 'https://cdn/u/3cb079fe-bc44-4ebf-87db-459e003c7c3f.glb', source: 'library' })
    await place({ id: 'link', name: 'Model', src: 'https://x/a.glb', source: 'link' })
    expect(named).toEqual(['Chair.glb', undefined])
  })
})

describe('text fields', () => {
  it('the catalog search shows what is being typed, then the committed query', () => {
    const typing = hudModel(
      state({ ui: { panel: 'assets', tab: 'catalog', catalog: [], query: 'old', typing: { target: 'search', text: 'cha' } } }),
    )
    expect(typing.assets.searchText).toBe('cha_')
    expect(hudModel(state({ ui: { panel: 'assets', tab: 'catalog', catalog: [], query: 'chair' } })).assets.searchText).toBe('chair')
    expect(hudModel(state({ ui: { panel: 'assets', tab: 'catalog', catalog: [] } })).assets.searchText).toBe('Search the catalog')
  })

  it('the Link tab shows the link, or how to paste one from chat', () => {
    expect(hudModel(state({ ui: { panel: 'assets', tab: 'link' } })).assets.linkText).toBe(LINK_HINT)
    expect(LINK_HINT).toBe('In chat, type /virvi and paste the link')
    expect(hudModel(state({ ui: { panel: 'assets', tab: 'link', linkUrl: 'https://x/a.glb' } })).assets.linkText).toBe('https://x/a.glb')
  })

  it('/virvi in chat: a link fills the Link tab, anything else searches the catalog', () => {
    expect(chatEntry(' https://x.io/a/b.glb ')).toEqual({ tab: 'link', linkUrl: 'https://x.io/a/b.glb' })
    expect(chatEntry('HTTP://x.io/a.glb')).toEqual({ tab: 'link', linkUrl: 'HTTP://x.io/a.glb' })
    expect(chatEntry('red chair')).toEqual({ tab: 'catalog', query: 'red chair' })
    expect(chatEntry('   ')).toBeNull()
  })

  it("reads /virvi's text from Hyperfy's command event, and ignores other commands", () => {
    expect(chatCommandText({ playerId: 'p1', cmd: 'virvi', value: 'red chair', args: ['virvi', 'red', 'chair'] })).toBe('red chair')
    // the server's event has only args
    expect(chatCommandText({ playerId: 'p1', args: ['virvi', 'https://x/a.glb'] })).toBe('https://x/a.glb')
    expect(chatCommandText({ playerId: 'p1', cmd: 'spawn', value: 'x', args: ['spawn', 'x'] })).toBeNull()
    // '/' opens chat with a '/' already typed, so typing /virvi there sends //virvi
    expect(chatCommandText({ playerId: 'p1', cmd: '/virvi', value: 'https://x/a.glb', args: ['/virvi', 'https://x/a.glb'] })).toBe('https://x/a.glb')
    expect(chatCommandText(null)).toBeNull()
    expect(chatCommandText({ cmd: 'virvi' })).toBe('')
  })
})

describe('clearing copies (LIV-12)', () => {
  const linked = { status: 'linked' as const, displayName: 'Ada', sceneId: 's' }
  const sc = (): SerializedScene => ({
    sk: 'p1',
    videos: [],
    images: [{ sk: 'i1', name: 'Poster', instances: [] }],
    models: [{ sk: 'm1', name: 'Chair', instances: [inst('a'), inst('b'), inst('c')] }],
    sounds: [],
  })
  const st = (ui: HudState['ui'] = {}): HudState => ({ pairing: linked, edit: edit(), plan: planScene(null), scene: sc(), alerts: [], ui: { panel: 'layout', ...ui } })

  it('each object shows how many copies it has; only one being cleared asks to confirm', () => {
    const items = hudModel(st({ clearing: 'm1' })).layout.items
    expect(items.map((i) => [i.elementId, i.copies, i.clearPrompt])).toEqual([
      ['i1', 0, null],
      ['m1', 3, 'Remove all 3 copies of Chair? The object stays. This can\'t be undone.'],
    ])
  })

  it('an object with no copies left has nothing to confirm, even if it was being cleared', () => {
    expect(hudModel(st({ clearing: 'i1' })).layout.items[0].clearPrompt).toBeNull()
  })

  it('says it plainly for one copy, and after clearing', () => {
    expect(clearCopiesPrompt({ name: 'Lamp', copies: 1 })).toBe("Remove the only copy of Lamp? The object stays. This can't be undone.")
    expect(clearedAlert('Chair', 3)).toEqual({ kind: 'info', text: 'Removed 3 copies of Chair' })
    expect(clearedAlert('Lamp', 1)).toEqual({ kind: 'info', text: 'Removed 1 copy of Lamp' })
    expect(clearedAlert('', 0)).toEqual({ kind: 'info', text: 'Unnamed had no copies left' })
  })
})

describe('off images (LIV-54)', () => {
  const linked = { status: 'linked' as const, displayName: 'Ada', sceneId: 's' }
  const sc = (): SerializedScene => ({
    sk: 'p1',
    videos: [
      { sk: 'v1', name: 'Main', offImageSrc: 'https://cdn/poster.png', instances: [] },
      { sk: 'v2', name: 'Side', instances: [] },
    ],
    images: [],
    models: [],
    sounds: [],
  })
  const images = [
    { id: 'a1', name: 'Poster', url: 'https://cdn/poster.png' },
    { id: 'a2', name: 'Logo', url: 'https://cdn/logo.jpg' },
  ]
  const st = (ui: HudState['ui'] = {}): HudState => ({ pairing: linked, edit: edit(), plan: planScene(null), scene: sc(), alerts: [], ui: { panel: 'streams', ...ui } })

  it('only ready library images a screen can show are choices', () => {
    const entries = [
      { id: 'a1', kind: 'media', name: 'Poster', url: 'https://cdn/poster.png', status: 'ready', contentType: 'image/png' },
      { id: 'a3', kind: 'media', name: 'Clip', url: 'https://cdn/clip.mp4', status: 'ready', contentType: 'video/mp4' },
      { id: 'a4', kind: 'media', name: 'Wip', url: 'https://cdn/wip.png', status: 'processing', contentType: 'image/png' },
      { id: 'a5', kind: 'model', name: 'Chair', url: 'https://cdn/chair.glb', status: 'ready' },
      { id: 'a2', kind: 'media', name: 'Logo', url: 'https://cdn/logo.jpg', status: 'ready', contentType: 'image/jpeg' },
    ] as const
    expect(offImageChoices([...entries])).toEqual(images)
  })

  it("labels each screen's off image by its library name", () => {
    expect(offImageLabel('https://cdn/poster.png', images)).toBe('Off image: Poster')
    expect(offImageLabel('https://elsewhere/x.png', images)).toBe('Off image: from a link')
    expect(offImageLabel('https://cdn/poster.png', null)).toBe('Off image: from a link')
    expect(offImageLabel('', images)).toBe('No off image')
  })

  it('picking lists the images (the current one marked) plus None', () => {
    const vm = hudModel(st({ imageList: images, imagePicking: 'v1' }))
    expect(vm.streams.map((s) => [s.elementId, s.offImage, s.imagePicking])).toEqual([
      ['v1', 'Off image: Poster', true],
      ['v2', 'No off image', false],
    ])
    expect(vm.imageOptions).toEqual([
      { id: '', label: 'None', current: false },
      { id: 'a1', label: 'Poster', current: true },
      { id: 'a2', label: 'Logo', current: false },
    ])
    expect(vm.imagesNote).toBeNull()
  })

  it('while loading, or with no images, a note instead of a list', () => {
    expect(hudModel(st({ imagePicking: 'v2' })).imagesNote).toBe('Loading images…')
    const empty = hudModel(st({ imageList: [], imagePicking: 'v2' }))
    expect(empty.imagesNote).toBe('No images in the scene library yet: add one from Images & Video on virvi.io')
    expect(empty.imageOptions).toEqual([{ id: '', label: 'None', current: true }])
    expect(hudModel(st({ imageList: images })).imageOptions).toEqual([])
  })
})

describe('showings in the Streams panel (LIV-87)', () => {
  const NOW = 1_800_000_000_000
  const film = (upcoming: Array<[number, number]>, enabled = true) => ({
    id: 'sh1', title: 'Film', enabled, upcoming: upcoming.map(([startsAt, lengthSeconds]) => ({ startsAt, lengthSeconds })),
  })

  it('timeLeft reads in minutes, hours and minutes, or days', () => {
    expect(timeLeft(30_000)).toBe('1 min')
    expect(timeLeft(23 * 60_000)).toBe('23 min')
    expect(timeLeft(65 * 60_000)).toBe('1 h 05 min')
    expect(timeLeft(26 * 3600_000)).toBe('1 day')
    expect(timeLeft(50 * 3600_000)).toBe('2 days')
  })

  it('a show on now can be ended or the next delayed; between shows it can be played now', () => {
    expect(showingRow(film([[NOW - 600_000, 6000], [NOW + 86_400_000, 6000]]), NOW)).toEqual({
      id: 'sh1', title: 'Film', status: 'On now, 1 h 30 min left', canEnd: true, canPlay: false, canDelay: true,
    })
    expect(showingRow(film([[NOW + 65 * 60_000, 6000]]), NOW)).toMatchObject({ status: 'Next in 1 h 05 min', canEnd: false, canPlay: true, canDelay: true })
    expect(showingRow(film([]), NOW)).toMatchObject({ status: 'Nothing coming up', canPlay: true, canDelay: false })
  })

  it('a paused showing has no controls', () => {
    expect(showingRow(film([[NOW + 60_000, 60]], false), NOW)).toEqual({ id: 'sh1', title: 'Film', status: 'Paused on virvi.io', canEnd: false, canPlay: false, canDelay: false })
  })

  it('Schedule-mode screens get a Showings list, loading or empty notes, and rows', () => {
    const sc = scene({ videos: [{ sk: 'v1', name: 'Cinema', offType: 6, instances: [] }, { sk: 'v2', name: 'Lobby', offType: 2, instances: [] }] })
    const closed = hudModel(state({ scene: sc, ui: { panel: 'streams' } }))
    expect(closed.streams.map((s) => [s.scheduled, s.showingsOpen])).toEqual([[true, false], [false, false]])
    expect(closed.showingRows).toEqual([])
    expect(hudModel(state({ scene: sc, ui: { panel: 'streams', showingsFor: 'v1' } })).showingsNote).toBe(SHOWINGS_LOADING)
    expect(hudModel(state({ scene: sc, ui: { panel: 'streams', showingsFor: 'v1', showingList: [] } })).showingsNote).toBe(NO_SHOWINGS)
    const open = hudModel(state({ scene: sc, now: NOW, ui: { panel: 'streams', showingsFor: 'v1', showingList: [film([[NOW + 60_000, 60]])] } }))
    expect(open.streams[0].showingsOpen).toBe(true)
    expect(open.showingsNote).toBeNull()
    expect(open.showingRows).toEqual([{ id: 'sh1', title: 'Film', status: 'Next in 1 min', canEnd: false, canPlay: true, canDelay: true }])
  })

  it('says what each control did', () => {
    expect(showControlAlert('delay', 'Film')).toEqual({ kind: 'info', text: 'Film: the next show starts 5 min later' })
    expect(showControlAlert('end', '')).toEqual({ kind: 'info', text: 'Untitled showing: ended' })
    expect(showControlAlert('play-now', 'Film')).toEqual({ kind: 'info', text: 'Film: playing now for everyone' })
  })
})
