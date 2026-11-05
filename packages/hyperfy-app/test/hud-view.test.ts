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
