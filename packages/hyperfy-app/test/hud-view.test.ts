import { describe, expect, it } from 'vitest'
import { planScene } from '../src/plan.js'
import { hudModel } from '../src/hud/model.js'
import { HudView, linkDotColor, type HudActions, type UiNode } from '../src/hud/view.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fake = Record<string, any>

function host() {
  const created: Fake[] = []
  return {
    created,
    create(type: string, data: Record<string, unknown> = {}): UiNode {
      const n: Fake = {
        type,
        ...data,
        children: [] as Fake[],
        add(c: Fake) {
          this.children.push(c)
        },
        remove(c: Fake) {
          this.children = this.children.filter((x: Fake) => x !== c)
        },
      }
      created.push(n)
      return n as UiNode
    },
    add() {},
    remove() {},
  }
}

const texts = (n: Fake): string[] => [
  ...(typeof n.value === 'string' ? [n.value as string] : []),
  ...n.children.flatMap(texts),
]
const noop = new Proxy({}, { get: () => () => {} }) as HudActions

const vm = (x: number) =>
  hudModel({
    pairing: { status: 'linked', displayName: 'Ada', sceneId: 's' },
    edit: {
      selectedKey: 'm1:i1',
      selectedName: 'Tree',
      mode: 'move',
      lock: 'free',
      snap: false,
      dirty: true,
      dragging: true,
      saving: false,
      prompt: false,
      values: { x, y: 0, z: 0 },
    },
    plan: planScene(null),
    scene: null,
    alerts: [],
    ui: { editing: true },
  })

describe('HudView', () => {
  it('a drag that only changes the values updates their text without rebuilding the HUD', () => {
    const h = host()
    const view = new HudView(h, noop)
    view.render(vm(1))
    const made = h.created.length
    const bar = h.created.find((n) => n.type === 'ui')!
    expect(texts(bar)).toContain('X 1.00')
    view.render(vm(2.5))
    expect(h.created.length).toBe(made)
    expect(texts(bar)).toContain('X 2.50')
    expect(texts(bar)).not.toContain('X 1.00')
  })

  it('the exact-value keypad draws its keys as buttons that type through typeKey', () => {
    const h = host()
    const pressed: Array<[string, string]> = []
    const act = new Proxy({}, { get: (_t, name) => (name === 'typeKey' ? (prop: string, char: string) => void pressed.push([prop, char]) : () => {}) }) as HudActions
    const view = new HudView(h, act)
    const typing = hudModel({ ...vmState(), ui: { editing: true, typing: { target: 'x', text: '1' } } })
    view.render(typing)
    const bar = h.created.find((n) => n.type === 'ui')!
    for (const label of ['7', '0', '-', '.', '⌫', 'Enter', 'Esc']) expect(texts(bar)).toContain(label)
    const find = (n: Fake, label: string): Fake | undefined =>
      n.onPointerDown && texts(n).includes(label) && texts(n).length === 1 ? n : n.children.map((c: Fake) => find(c, label)).find(Boolean)
    find(bar, '7')!.onPointerDown()
    find(bar, '⌫')!.onPointerDown()
    find(bar, 'Enter')!.onPointerDown()
    expect(pressed).toEqual([
      ['digit7', '7'],
      ['backspace', 'Backspace'],
      ['enter', 'Enter'],
    ])
  })
})

describe('HudView brand', () => {
  const brandOf = (h: ReturnType<typeof host>) => {
    const bar = h.created.find((n) => n.type === 'ui')!
    const firstRow = bar.children[0]
    return firstRow.children[0] as Fake
  }

  it('shows the Virvi V with a round status dot at the symbol position instead of a Virvi label', () => {
    const h = host()
    new HudView(h, noop, { iconSrc: 'asset://abc.png' }).render(vm(1))
    const bar = h.created.find((n) => n.type === 'ui')!
    expect(texts(bar)).not.toContain('Virvi')
    const brand = brandOf(h)
    expect(brand).toMatchObject({ type: 'uiview', width: 28, height: 28 })
    const [img, dot] = brand.children
    expect(img).toMatchObject({ type: 'uiimage', src: 'asset://abc.png', width: 28, height: 28 })
    const k = 28 / 1254
    expect(dot).toMatchObject({ type: 'uiview', absolute: true, backgroundColor: '#08ddeb' })
    expect(dot.left).toBeCloseTo((627 - 132) * k)
    expect(dot.top).toBeCloseTo((373 - 132) * k)
    expect(dot.width).toBeCloseTo(264 * k)
    expect(dot.borderRadius).toBeCloseTo(dot.width / 2)
  })

  it('the dot follows the link state; without an icon only the dot is drawn', () => {
    expect(linkDotColor('linked')).toBe('#08ddeb')
    expect(linkDotColor('idle')).toBe('#e0ad14')
    expect(linkDotColor('waiting')).toBe('#e0ad14')
    for (const s of ['error', 'lost', 'expired'] as const) expect(linkDotColor(s)).toBe('#e5484d')
    const h = host()
    new HudView(h, noop).render(hudModel({ ...vmState(), pairing: { status: 'idle' } }))
    const brand = brandOf(h)
    expect(brand.children).toHaveLength(1)
    expect(brand.children[0]).toMatchObject({ absolute: true, backgroundColor: '#e0ad14' })
    expect(h.created.some((n) => n.type === 'uiimage')).toBe(false)
  })
})

function vmState() {
  return {
    pairing: { status: 'linked' as const, displayName: 'Ada', sceneId: 's' },
    edit: { selectedKey: 'm1:i1', selectedName: 'Tree', mode: 'move' as const, lock: 'free' as const, snap: false, dirty: false, dragging: false, saving: false, prompt: false, values: { x: 1, y: 0, z: 0 } },
    plan: planScene(null),
    scene: null,
    alerts: [],
  }
}

describe('HudView streams panel (LIV-53)', () => {
  it('shows what each screen plays and lists the streams to choose from', () => {
    const h = host()
    const calls: unknown[][] = []
    const act = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => void calls.push([name, ...args]) }) as HudActions
    const view = new HudView(h, act)
    const scene = { videos: [{ sk: 'v1', name: 'Main', liveSrc: 'https://live/main.m3u8', instances: [] }], images: [], models: [], sounds: [] }
    const streamList = [
      { id: 's1', name: 'Main Stage', hlsPlaylistUrl: 'https://live/main.m3u8', live: true, mine: false },
      { id: 's2', name: 'Editor Cam', hlsPlaylistUrl: 'https://live/cam.m3u8', live: false, mine: true },
    ]
    view.render(hudModel({ ...vmState(), scene, ui: { panel: 'streams', streamList, streamPicking: 'v1' } }))
    const all = h.created.flatMap((n) => (typeof n.value === 'string' ? [n.value] : []))
    for (const t of ['Main Stage (live)', 'Close list', 'Editor Cam (offline, yours)', 'Go live']) expect(all).toContain(t)
    const press = (label: string) => h.created.find((n) => n.onPointerDown && texts(n).length === 1 && texts(n)[0] === label)!.onPointerDown()
    press('Editor Cam (offline, yours)')
    press('Close list')
    expect(calls).toEqual([['chooseStream', 'v1', 's2'], ['pickStream', 'v1']])
  })
})

describe('HudView layout panel: clearing copies (LIV-12)', () => {
  const scene = { videos: [], images: [], models: [{ sk: 'm1', name: 'Chair', instances: [{ sk: 'a' }, { sk: 'b' }] }], sounds: [] }
  const setup = (ui: Record<string, unknown>) => {
    const h = host()
    const calls: unknown[][] = []
    const act = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => void calls.push([name, ...args]) }) as HudActions
    new HudView(h, act).render(hudModel({ ...vmState(), scene: scene as never, ui: { panel: 'layout', ...ui } }))
    const all = h.created.flatMap((n) => (typeof n.value === 'string' ? [n.value] : []))
    const press = (label: string) => h.created.find((n) => n.onPointerDown && texts(n).length === 1 && texts(n)[0] === label)!.onPointerDown()
    return { all, press, calls }
  }

  it('shows the copy count and a Clear button that asks first', () => {
    const t = setup({})
    expect(t.all).toContain('×2')
    t.press('Clear')
    expect(t.calls).toEqual([['askClear', 'm1']])
  })

  it('while confirming: the prompt, then Remove or Cancel', () => {
    const t = setup({ clearing: 'm1' })
    expect(t.all).toContain("Remove all 2 copies of Chair? The object stays. This can't be undone.")
    t.press('Remove')
    t.press('Cancel')
    expect(t.calls).toEqual([['clearCopies', 'm1'], ['askClear', null]])
  })
})

describe('HudView streams panel: off images (LIV-54)', () => {
  it("shows each screen's off image and lets the owner choose one or none", () => {
    const h = host()
    const calls: unknown[][] = []
    const act = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => void calls.push([name, ...args]) }) as HudActions
    const scene = { videos: [{ sk: 'v1', name: 'Main', offImageSrc: 'https://cdn/poster.png', instances: [] }], images: [], models: [], sounds: [] }
    const imageList = [{ id: 'a1', name: 'Poster', url: 'https://cdn/poster.png' }, { id: 'a2', name: 'Logo', url: 'https://cdn/logo.jpg' }]
    new HudView(h, act).render(hudModel({ ...vmState(), scene: scene as never, ui: { panel: 'streams', imageList, imagePicking: 'v1' } }))
    const all = h.created.flatMap((n) => (typeof n.value === 'string' ? [n.value] : []))
    for (const t of ['Off image: Poster', 'Close images', 'None', 'Logo', 'Choose stream']) expect(all).toContain(t)
    const press = (label: string) => h.created.find((n) => n.onPointerDown && texts(n).length === 1 && texts(n)[0] === label)!.onPointerDown()
    press('Logo')
    press('None')
    press('Close images')
    expect(calls).toEqual([['chooseImage', 'v1', 'a2'], ['chooseImage', 'v1', ''], ['pickImage', 'v1']])
  })
})

describe('HudView streams panel: showings (LIV-87)', () => {
  const NOW = 1_800_000_000_000
  const scene = { videos: [{ sk: 'v1', name: 'Cinema', offType: 6, instances: [] }, { sk: 'v2', name: 'Lobby', offType: 2, instances: [] }], images: [], models: [], sounds: [] }
  const draw = (ui: Record<string, unknown>) => {
    const h = host()
    const calls: unknown[][] = []
    const act = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => void calls.push([name, ...args]) }) as HudActions
    new HudView(h, act).render(hudModel({ ...vmState(), scene: scene as never, now: NOW, ui: { panel: 'streams', ...ui } }))
    const all = h.created.flatMap((n) => (typeof n.value === 'string' ? [n.value] : []))
    const buttons = (label: string) => h.created.filter((n) => n.onPointerDown && texts(n).length === 1 && texts(n)[0] === label)
    return { all, calls, buttons, press: (label: string) => buttons(label)[0].onPointerDown() }
  }

  it('only Schedule-mode screens get a Showings button', () => {
    const t = draw({})
    expect(t.buttons('Showings')).toHaveLength(1)
    t.press('Showings')
    expect(t.calls).toEqual([['openShowings', 'v1']])
  })

  it('an open list shows each showing with the controls that apply', () => {
    const showingList = [
      { id: 'a', title: 'Film', enabled: true, upcoming: [{ startsAt: NOW - 60_000, lengthSeconds: 600 }, { startsAt: NOW + 86_400_000, lengthSeconds: 600 }] },
      { id: 'b', title: 'Shorts', enabled: true, upcoming: [{ startsAt: NOW + 3_600_000, lengthSeconds: 600 }] },
    ]
    const t = draw({ showingsFor: 'v1', showingList })
    for (const s of ['Close showings', 'Film: On now, 9 min left', 'Shorts: Next in 1 h 00 min']) expect(t.all).toContain(s)
    t.press('End now')
    t.press('Play now')
    t.buttons('Delay 5 min')[1].onPointerDown()
    expect(t.calls).toEqual([['controlShowing', 'a', 'end'], ['controlShowing', 'b', 'play-now'], ['controlShowing', 'b', 'delay']])
  })

  it('while loading, or with none, says so', () => {
    expect(draw({ showingsFor: 'v1' }).all).toContain('Loading showings…')
    expect(draw({ showingsFor: 'v1', showingList: [] }).all).toContain('No showings yet: add them on virvi.io')
  })
})
