import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createContext, runInContext } from 'node:vm'
import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import type { HyperfyFeedResponse } from '@virvixr/shared'
// @ts-expect-error plain .mjs shared with the build script
import { bundleOptions } from '../scripts/bundle-options.mjs'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
let js = ''

beforeAll(async () => {
  // Bundled the same way as scripts/build-hyp.mjs.
  const out = await build(bundleOptions(pkg, join(pkg, 'src/app.ts')))
  js = out.outputFiles[0].text
}, 30_000)

type Fake = Record<string, any>

/** A Hyperfy-like node: three.js transform objects plus children. */
function node(type: string, data: Fake = {}): Fake {
  return {
    type,
    ...data,
    position: new Vector3(),
    rotation: new Euler(),
    scale: new Vector3(1, 1, 1),
    children: [] as Fake[],
    add(c: Fake) {
      this.children.push(c)
    },
    remove(c: Fake) {
      this.children = this.children.filter((x: Fake) => x !== c)
    },
  }
}

/** A fake `app.control()`: buttons made on first use, a locked pointer, the camera rig and the screen. */
function control(): Fake {
  const target: Fake = {
    pointer: { locked: true, coords: new Vector3(0.5, 0.5, 0), lock() {}, unlock() {} },
    camera: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion(), zoom: 0 },
    screen: { width: 1600, height: 900 },
    release() {},
  }
  return new Proxy(target, {
    get(t, prop: string) {
      if (!(prop in t)) t[prop] = { $button: true, down: false, pressed: false, released: false, capture: false, onPress: null, onRelease: null }
      return t[prop]
    },
  })
}

/** Every text in a node tree, depth first. */
const texts = (n: Fake): string[] => [...(typeof n.value === 'string' ? [n.value] : []), ...(n.children ?? []).flatMap(texts)]
/** The first node in the tree with a click handler whose text is `label`. */
function button(roots: Fake[], label: string): Fake | undefined {
  for (const r of roots) {
    if (r.onPointerDown && texts(r).includes(label)) return r
    const inner = button(r.children ?? [], label)
    if (inner) return inner
  }
  return undefined
}

type Res = { ok: boolean; status: number; json(): Promise<unknown> } | undefined
const res = (status: number, body: unknown): Res => ({ ok: status < 400, status, json: async () => body })
/** A hosted world's `app.virviVouch` (the image vouches in Node; the script never holds the world secret). */
type VouchReq = { hyperfyPlayerId: string; playerName: string | null; pendingPairingId?: string }
function hostedVouch(answer: (req: VouchReq, n: number) => unknown) {
  const calls: VouchReq[] = []
  const virviVouch = async (req: VouchReq) => (calls.push(req), answer(req, calls.length))
  return { calls, virviVouch }
}
const admin = (id: string, name: string) => ({ id, name, admin: true, builder: false, position: new Vector3() })
const START = { code: 'SLF234', approveUrl: 'https://virvi.io/pair/SLF234', qrUrl: 'https://q', expiresAt: new Date(Date.now() + 600_000).toISOString() }

/**
 * Host globals a browser or Node has but Hyperfy's script compartment doesn't: any use is recorded. (Anything else
 * missing simply isn't defined in the vm context, so using it throws.)
 */
function forbiddenGlobals(used: string[]): Record<string, unknown> {
  const trap = (name: string) =>
    new Proxy(function () {}, {
      get: () => (used.push(name), undefined),
      apply: () => (used.push(name), undefined),
      construct: () => (used.push(name), {}),
    })
  const names = ['setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone', 'localStorage', 'crypto', 'TextEncoder', 'TextDecoder', 'performance', 'process', 'Buffer', 'require', 'window', 'document', 'navigator', 'WebSocket']
  return Object.fromEntries(names.map((n) => [n, trap(n)]))
}

/**
 * Exactly the endowments Hyperfy 0.16's Scripts system gives its compartment (src/core/systems/Scripts.js): note
 * Date is `{ now }` only and URL is `{ createObjectURL }` only. The vm context adds just the ECMAScript intrinsics,
 * as SES does; the intrinsic Date is shadowed by the endowment, as in Hyperfy.
 */
function hyperfyEndowments(uuid: () => string): Record<string, unknown> {
  class Placeholder {}
  return {
    console: {
      log: (...a: unknown[]) => console.log(...a),
      warn: (...a: unknown[]) => console.warn(...a),
      error: (...a: unknown[]) => console.error(...a),
      time: (...a: unknown[]) => console.time(...(a as [string])),
      timeEnd: (...a: unknown[]) => console.timeEnd(...(a as [string])),
    },
    Date: { now: () => Date.now() },
    URL: { createObjectURL: () => 'blob:x' },
    Math,
    eval: undefined,
    harden: undefined,
    lockdown: undefined,
    num: (min: number, max: number) => min + (max - min) / 2,
    prng: () => () => 0.5,
    clamp: (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n)),
    Object3D,
    Quaternion,
    Vector3,
    Euler,
    Matrix4,
    LerpVector3: Placeholder,
    LerpQuaternion: Placeholder,
    BufferedLerpVector3: Placeholder,
    BufferedLerpQuaternion: Placeholder,
    Curve: Placeholder,
    DEG2RAD: Math.PI / 180,
    RAD2DEG: 180 / Math.PI,
    uuid,
  }
}

/** Runs the bundled script with only the sandbox globals it may use. */
function run(opts: {
  isServer: boolean
  players?: Fake[]
  /** The client's local player (world.getPlayer()). */
  me?: Fake
  matrixWorld?: Matrix4
  /** A hosted world's server-only vouch (Task 9's image provides it); undefined for self-run worlds. */
  virviVouch?: (req: VouchReq) => Promise<unknown>
  route?: (url: string, body: any) => Res | undefined
}) {
  const timers: Array<() => void> = []
  const posts: Array<{ url: string; body: any }> = []
  const requests: Array<{ url: string; body: any }> = []
  const handlers = new Map<string, (data: unknown, id?: string) => void>()
  const added: Fake[] = []
  const created: Fake[] = []
  const loads: Array<Promise<Fake>> = []
  const sent: Array<{ name: string; data: any }> = []
  const sentTo: Array<{ playerId: string; name: string; data: any }> = []
  const controls: Fake[] = []
  const used: string[] = []
  const worldHandlers = new Map<string, (e: any) => void>()
  const world = {
    isServer: opts.isServer,
    isClient: !opts.isServer,
    on: (name: string, cb: (e: any) => void) => worldHandlers.set(name, cb),
    getPlayers: () => opts.players ?? [],
    getPlayer: (id?: string) => (id === undefined ? (opts.me ?? null) : ((opts.players ?? []).find((p) => p.id === id) ?? null)),
    load: (_type: string, _url: string) => {
      const p = Promise.resolve(node('model'))
      loads.push(p)
      return p
    },
    open() {},
  }
  const app = {
    matrixWorld: opts.matrixWorld ?? new Matrix4(),
    virviVouch: opts.virviVouch,
    configure() {},
    on: (name: string, cb: (data: unknown, id?: string) => void) => handlers.set(name, cb),
    send: (name: string, data: unknown) => void sent.push({ name, data }),
    sendTo: (playerId: string, name: string, data: unknown) => void sentTo.push({ playerId, name, data }),
    create: (type: string, data?: Fake) => {
      const n = node(type, data)
      created.push(n)
      return n
    },
    add: (n: Fake) => added.push(n),
    remove: (n: Fake) => {
      const i = added.indexOf(n)
      if (i >= 0) added.splice(i, 1)
    },
    control: () => {
      const c = control()
      controls.push(c)
      return c
    },
  }
  const fetch = async (url: string, init: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    if (url.includes('/api/hyperfy/analytics')) posts.push({ url, body })
    else requests.push({ url, body })
    return opts.route?.(url, body) // undefined: the feed poller just backs off
  }
  const setTimeout = (fn: () => void) => void timers.push(fn)
  const props = { feedUrl: 'https://api.example', worldKey: 'virviw_k' }
  let n = 0
  const uuid = () => `uuid-${++n}`
  const context = createContext({ ...hyperfyEndowments(uuid), ...forbiddenGlobals(used) })
  // Hyperfy's wrapRawCode: the script body runs inside (world, app, fetch, props, setTimeout, WebSocket) => { … }.
  const wrapped = runInContext(
    `(function() { const shared = {}; return (world, app, fetch, props, setTimeout, WebSocket) => { const config = props\n${js}\n} })()`,
    context,
  ) as (...args: unknown[]) => void
  wrapped(world, app, fetch, props, setTimeout, context.WebSocket)
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  /** Runs every pending timer once, then lets promises settle. */
  const tick = async () => {
    for (const fn of timers.splice(0)) fn()
    await settle()
  }
  const update = () => handlers.get('update')?.(1 / 60)
  return { timers, posts, requests, handlers, worldHandlers, added, created, loads, sent, sentTo, controls, used, settle, tick, update }
}

describe('the Virvi app script', () => {
  it('server: players already in the world are recorded, and positions are posted in Virvi coordinates', async () => {
    // App moved to (10, 0, 20), turned 90° about Y and scaled 2: Virvi (1, 0, 2) is Hyperfy local (1, 0, -2).
    const root = new Matrix4().compose(new Vector3(10, 0, 20), new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)), new Vector3(2, 2, 2))
    const at = new Vector3(1, 0, -2).applyMatrix4(root)
    const s = run({ isServer: true, players: [{ id: 'p1', position: at }], matrixWorld: root })
    // Run every pending timer once (poller, sample, flush) a few rounds.
    for (let round = 0; round < 4 && !s.posts.length; round++) {
      for (const fn of s.timers.splice(0)) fn()
      await s.settle()
    }
    expect(s.posts.length).toBeGreaterThan(0)
    const events = s.posts[0].body.events
    expect(events[0]).toMatchObject({ type: 'enter', playerId: 'p1' })
    const pos = events.find((e: { type: string }) => e.type === 'pos')
    expect(pos.x).toBeCloseTo(1)
    expect(pos.y).toBeCloseTo(0)
    expect(pos.z).toBeCloseTo(2)
  })

  it('client: a model sits in a group carrying the mapped transform, turned half a circle inside it', async () => {
    const c = run({ isServer: false })
    const snap: HyperfyFeedResponse = {
      v: 1,
      version: 'a',
      scene: {
        videos: [],
        images: [],
        sounds: [],
        models: [
          {
            sk: 'm1',
            modelSrc: 'https://x/m.glb',
            instances: [{ sk: 'i1', position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 } }],
          },
        ],
      },
    }
    c.handlers.get('virvi:scene')!(snap)
    await Promise.all(c.loads)
    await c.settle()
    expect(c.added).toHaveLength(1)
    const group = c.added[0]
    expect(group.type).toBe('group')
    expect(group.position.toArray()).toEqual([1, 2, -3])
    expect(group.rotation.y).toBeCloseTo(-Math.PI / 2)
    expect(group.scale.toArray()).toEqual([2, 2, 2])
    expect(group.children).toHaveLength(1)
    const model = group.children[0]
    expect(model.type).toBe('model')
    expect([model.rotation.x, model.rotation.y, model.rotation.z]).toEqual([0, Math.PI, 0])
    expect(model.scale.toArray()).toEqual([1, 1, 1])
  })

  it('client: a playlist screen moves to the next video when one ends, and loops back to the first', async () => {
    const c = run({ isServer: false })
    const list = ['https://x/1.mp4', 'https://x/2.mp4', 'https://x/3.mp4']
    const tv = (playlist: string[], x = 1) => ({
      sk: 'tv',
      offType: 2,
      playlist,
      volume: 0.5,
      instances: [{ sk: 'i1', position: { x, y: 1, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 3, y: 2, z: 1 } }],
    })
    const snap = (playlist: string[], version = 'a', x = 1): HyperfyFeedResponse => ({
      v: 1,
      version,
      scene: { videos: [tv(playlist, x)], images: [], models: [], sounds: [] },
    })
    c.handlers.get('virvi:scene')!(snap(list))
    const screen = () => {
      const videos = c.added.filter((n) => n.type === 'video')
      expect(videos).toHaveLength(1)
      return videos[0]
    }
    // Hyperfy's video node: playing, time and duration (seconds); no "ended" event.
    const play = (n: Fake) => Object.assign(n, { playing: true, time: 3, duration: 20 })
    const end = (n: Fake) => Object.assign(n, { playing: false, time: 20, duration: 20 })
    expect(screen()).toMatchObject({ src: list[0], loop: false })

    const seen = [screen().src]
    for (let i = 0; i < 3; i++) {
      play(screen())
      await c.tick()
      expect(screen().src).toBe(seen[seen.length - 1]) // still playing: stays
      end(screen())
      await c.tick()
      seen.push(screen().src)
    }
    expect(seen).toEqual([...list, list[0]])
    expect(screen()).toMatchObject({ loop: false, volume: 0.5, width: 3, height: 2 })

    // Not started yet (autoplay blocked, still loading): never skipped.
    Object.assign(screen(), { playing: false, time: 0, duration: 0 })
    await c.tick()
    expect(screen().src).toBe(list[0])

    // A move keeps its place in the playlist; a new playlist starts over.
    end(screen())
    await c.tick()
    c.handlers.get('virvi:scene')!(snap(list, 'b', 4))
    expect(screen().src).toBe(list[1])
    expect(screen().position.x).toBe(4)
    c.handlers.get('virvi:scene')!(snap(['https://x/9.mp4', ...list], 'c', 4))
    expect(screen().src).toBe('https://x/9.mp4')
  })

  it('client: a one-video playlist loops in the node and is never replaced', async () => {
    const c = run({ isServer: false })
    c.handlers.get('virvi:scene')!({
      v: 1,
      version: 'a',
      scene: {
        videos: [{ sk: 'tv', offType: 2, playlist: ['https://x/1.mp4'], instances: [{ sk: 'i1' }] }],
        images: [],
        models: [],
        sounds: [],
      },
    })
    const [node] = c.added.filter((n) => n.type === 'video')
    expect(node).toMatchObject({ src: 'https://x/1.mp4', loop: true })
    Object.assign(node, { playing: false, time: 20, duration: 20 })
    await c.tick()
    expect(c.added.filter((n) => n.type === 'video')).toEqual([node])
  })

  it('the sandbox build runs the client and server halves without forbidden globals', async () => {
    const me = { id: 'p1', name: 'Pip', admin: true, builder: true, position: new Vector3() }
    const server = run({ isServer: true, players: [me], virviVouch: hostedVouch(() => ({ status: 'pending' })).virviVouch })
    server.handlers.get('virvi:link')!(null, 'p1')
    for (let i = 0; i < 3; i++) await server.tick()
    const client = run({ isServer: false, me, route: () => res(200, { code: 'ABC234', approveUrl: 'a', qrUrl: 'q', expiresAt: new Date(Date.now() + 600_000).toISOString() }) })
    client.update()
    button(client.added, 'Link to Virvi')!.onPointerDown()
    client.handlers.get('virvi:link')!({ status: 'self', attempt: client.sent.find((m) => m.name === 'virvi:link')!.data.attempt })
    for (let i = 0; i < 3; i++) await client.tick()
    client.update()
    expect([...server.used, ...client.used]).toEqual([])
  })

  it("the HUD draws nothing for a visitor who isn't admin or builder", async () => {
    const c = run({ isServer: false, me: { id: 'p9', name: 'Vi', admin: false, builder: false, position: new Vector3() } })
    c.update()
    await c.settle()
    expect(c.created.filter((n) => n.type.startsWith('ui'))).toEqual([])
    expect(c.controls).toHaveLength(0)
    expect(c.sent.filter((m) => m.name === 'virvi:link')).toEqual([])
  })

  it('an admin or builder gets the Link button; a self-run world pairs from the browser', async () => {
    const c = run({
      isServer: false,
      me: { id: 'p1', name: 'Pip', admin: false, builder: true, position: new Vector3() },
      route: (url) => (url.endsWith('/api/hyperfy/pair') ? res(200, { code: 'ABC234', approveUrl: 'https://virvi.io/pair/ABC234', qrUrl: 'https://q', expiresAt: new Date(Date.now() + 600_000).toISOString() }) : undefined),
    })
    c.update()
    const link = button(c.added, 'Link to Virvi')
    expect(link).toBeDefined()
    link!.onPointerDown()
    expect(c.sent.filter((m) => m.name === 'virvi:link')).toHaveLength(1)
    c.handlers.get('virvi:link')!({ status: 'self', attempt: c.sent.find((m) => m.name === 'virvi:link')!.data.attempt })
    await c.settle()
    expect(c.requests.find((r) => r.url === 'https://api.example/api/hyperfy/pair')?.body).toMatchObject({ worldKey: 'virviw_k', playerName: 'Pip' })
    c.update()
    expect(c.added.flatMap(texts)).toContain('ABC-234')
  })

  it('hosted: a virvi:link request is answered with the vouch result for that player only', async () => {
    const players = [admin('p1', 'Pip'), admin('p2', 'Bo')]
    const v = hostedVouch((_req, n) => {
      if (n === 1) return { status: 'unlinked', code: 'ABC234', approveUrl: 'https://virvi.io/pair/ABC234', qrUrl: 'https://q', expiresAt: 'e', pairingId: 'pair-1' }
      if (n === 2) return { status: 'pending' }
      return { status: 'linked', pass: 'PASS', passExpiresAt: 'x', pairingId: 'pair-1', sceneId: 'scene-1', user: { id: 'u1', displayName: 'Ada' } }
    })
    const s = run({ isServer: true, players, virviVouch: v.virviVouch, route: () => res(200, { status: 'pending' }) })
    // The body can't pick the player: the sender's id does.
    s.handlers.get('virvi:link')!({ hyperfyPlayerId: 'p2', playerName: 'Mallory', attempt: 4 }, 'p1')
    await s.settle()
    expect(v.calls[0]).toEqual({ hyperfyPlayerId: 'p1', playerName: 'Pip' })
    expect(s.sentTo).toEqual([{ playerId: 'p1', name: 'virvi:link', data: { status: 'unlinked', code: 'ABC234', approveUrl: 'https://virvi.io/pair/ABC234', qrUrl: 'https://q', expiresAt: 'e', attempt: 4 } }])
    // polls with the pending pairing until it's approved
    await s.tick()
    expect(v.calls[1]).toEqual({ hyperfyPlayerId: 'p1', playerName: 'Pip', pendingPairingId: 'pair-1' })
    expect(s.sentTo).toHaveLength(1)
    await s.tick()
    expect(v.calls[2]).toEqual({ hyperfyPlayerId: 'p1', playerName: 'Pip', pendingPairingId: 'pair-1' })
    expect(s.sentTo.at(-1)).toEqual({ playerId: 'p1', name: 'virvi:link', data: { status: 'linked', pass: 'PASS', passExpiresAt: 'x', pairingId: 'pair-1', sceneId: 'scene-1', displayName: 'Ada', attempt: 4 } })
    // linked: polling stops, and nothing was broadcast
    await s.tick()
    expect(v.calls).toHaveLength(3)
    expect(s.sentTo.every((m) => m.playerId === 'p1')).toBe(true)
    expect(s.sent.filter((m) => m.name === 'virvi:link')).toEqual([])
    // the script never calls Virvi's vouch itself: the image does, holding the world secret the script never sees
    expect(s.requests.filter((r) => r.url.includes('vouch'))).toEqual([])
  })

  it('hosted: the relay never sees a world secret, and a failed vouch is answered lost', async () => {
    const v = hostedVouch(() => ({ status: 'error' }))
    const s = run({ isServer: true, players: [admin('p1', 'Pip')], virviVouch: v.virviVouch, route: () => res(200, { status: 'pending' }) })
    s.handlers.get('virvi:link')!({ attempt: 7 }, 'p1')
    await s.settle()
    expect(v.calls).toEqual([{ hyperfyPlayerId: 'p1', playerName: 'Pip' }])
    expect(s.sentTo).toEqual([{ playerId: 'p1', name: 'virvi:link', data: { status: 'lost', attempt: 7 } }])
    // nothing the script was given or sent carries a secret: the fake world, app and props have none anywhere
    expect(JSON.stringify([v.calls, s.sentTo, s.sent, s.requests])).not.toMatch(/secret/i)
  })

  it('hosted: Virvi not knowing the world secret (unauthorized) falls back to pairing from the browser', async () => {
    const v = hostedVouch(() => ({ status: 'unauthorized' }))
    const s = run({ isServer: true, players: [admin('p1', 'Pip')], virviVouch: v.virviVouch, route: () => res(200, { status: 'pending' }) })
    s.handlers.get('virvi:link')!({ attempt: 3 }, 'p1')
    await s.settle()
    expect(v.calls).toHaveLength(1)
    expect(s.sentTo).toEqual([{ playerId: 'p1', name: 'virvi:link', data: { status: 'self', attempt: 3 } }])
    // nothing is pending: a later request vouches afresh
    await s.tick()
    expect(v.calls).toHaveLength(1)
  })

  it('hosted: a sender who is neither admin nor builder gets no vouch and no reply', async () => {
    const v = hostedVouch(() => ({ status: 'pending' }))
    const s = run({ isServer: true, players: [{ id: 'p3', name: 'Vi', admin: false, builder: false, position: new Vector3() }], virviVouch: v.virviVouch, route: () => res(200, { status: 'pending' }) })
    s.handlers.get('virvi:link')!({ attempt: 1 }, 'p3')
    s.handlers.get('virvi:link')!({ attempt: 1 }, 'nobody')
    await s.tick()
    expect(v.calls).toEqual([])
    expect(s.sentTo).toEqual([])
  })

  it('without app.virviVouch the world is self-run: no vouch', async () => {
    const s = run({ isServer: true, players: [admin('p1', 'Pip')], route: () => res(200, { status: 'pending' }) })
    s.handlers.get('virvi:link')!({ attempt: 2 }, 'p1')
    await s.settle()
    expect(s.requests.filter((r) => r.url.includes('vouch'))).toEqual([])
    expect(s.sentTo).toEqual([{ playerId: 'p1', name: 'virvi:link', data: { status: 'self', attempt: 2 } }])
  })

  it('client: a late reply to an older link attempt is ignored', async () => {
    const c = run({ isServer: false, me: admin('p1', 'Pip'), route: (url) => (url.endsWith('/api/hyperfy/pair') ? res(200, START) : undefined) })
    c.update()
    button(c.added, 'Link to Virvi')!.onPointerDown()
    const attempt = c.sent.find((m) => m.name === 'virvi:link')!.data.attempt
    expect(typeof attempt).toBe('number')
    await c.tick() // no answer: falls back to pairing from the browser
    c.update()
    expect(c.added.flatMap(texts)).toContain('SLF-234')
    c.handlers.get('virvi:link')!({ status: 'unlinked', code: 'LAT234', approveUrl: 'a', qrUrl: 'q', expiresAt: 'e', attempt })
    c.update()
    expect(c.added.flatMap(texts)).toContain('SLF-234')
    expect(c.added.flatMap(texts)).not.toContain('LAT-234')
  })

  it('client: a self answer while a hosted code is showing switches to pairing from the browser', async () => {
    const c = run({ isServer: false, me: admin('p1', 'Pip'), route: (url) => (url.endsWith('/api/hyperfy/pair') ? res(200, START) : undefined) })
    c.update()
    button(c.added, 'Link to Virvi')!.onPointerDown()
    const attempt = c.sent.find((m) => m.name === 'virvi:link')!.data.attempt
    c.handlers.get('virvi:link')!({ status: 'unlinked', code: 'HOS234', approveUrl: 'a', qrUrl: 'q', expiresAt: 'e', attempt })
    c.update()
    expect(c.added.flatMap(texts)).toContain('HOS-234')
    c.handlers.get('virvi:link')!({ status: 'self', attempt })
    await c.settle()
    c.update()
    expect(c.requests.some((r) => r.url === 'https://api.example/api/hyperfy/pair')).toBe(true)
    expect(c.added.flatMap(texts)).not.toContain('HOS-234')
    expect(c.added.flatMap(texts)).toContain('SLF-234')
  })

  it('client: losing admin and builder stops the link, so no more pass renewals', async () => {
    const me = admin('p1', 'Pip')
    const c = run({ isServer: false, me })
    c.update()
    button(c.added, 'Link to Virvi')!.onPointerDown()
    const attempt = c.sent.find((m) => m.name === 'virvi:link')!.data.attempt
    // A pass that is due for renewal at once.
    c.handlers.get('virvi:link')!({ status: 'linked', pass: 'P', passExpiresAt: new Date(Date.now() + 60_000).toISOString(), pairingId: 'pair-1', sceneId: 'scene-1', displayName: 'Ada', attempt })
    await c.settle()
    me.admin = false
    c.update()
    const before = c.sent.filter((m) => m.name === 'virvi:link').length
    for (let i = 0; i < 3; i++) await c.tick()
    expect(c.sent.filter((m) => m.name === 'virvi:link').length).toBe(before)
  })

  it('self-run: after approval the HUD claims the code and links (in the sandbox, Date is only { now })', async () => {
    const claimed = { status: 'approved', pass: 'PASS', passExpiresAt: new Date(Date.now() + 900_000).toISOString(), pairingId: 'pair-1', sceneId: 'scene-1', user: { id: 'u1', displayName: 'Ada' } }
    const c = run({
      isServer: false,
      me: admin('p1', 'Pip'),
      route: (url) => (url.endsWith('/api/hyperfy/pair') ? res(200, START) : url.endsWith('/claim') ? res(200, claimed) : undefined),
    })
    c.update()
    button(c.added, 'Link to Virvi')!.onPointerDown()
    c.handlers.get('virvi:link')!({ status: 'self', attempt: c.sent.find((m) => m.name === 'virvi:link')!.data.attempt })
    await c.settle()
    const claims = () => c.requests.filter((r) => r.url === 'https://api.example/api/hyperfy/pair/SLF234/claim')
    for (let i = 0; i < 3 && !claims().length; i++) await c.tick()
    expect(claims()).toHaveLength(1)
    c.update()
    expect(c.added.flatMap(texts)).toContain('Linked to Virvi as Ada')
    expect(c.used).toEqual([])
  })

  it('linked: /virvi <link> in chat opens the Link tab with that link; other players and commands are ignored', async () => {
    const claimed = { status: 'approved', pass: 'PASS', passExpiresAt: new Date(Date.now() + 900_000).toISOString(), pairingId: 'pair-1', sceneId: 'scene-1', user: { id: 'u1', displayName: 'Ada' } }
    const c = run({
      isServer: false,
      me: admin('p1', 'Pip'),
      route: (url) => (url.endsWith('/api/hyperfy/pair') ? res(200, START) : url.endsWith('/claim') ? res(200, claimed) : undefined),
    })
    c.update()
    const command = c.worldHandlers.get('command')!
    // not linked yet: nothing to fill
    command({ playerId: 'p1', cmd: 'virvi', value: 'https://x.io/a.glb', args: ['virvi', 'https://x.io/a.glb'] })
    expect(c.added.flatMap(texts)).not.toContain('https://x.io/a.glb')
    button(c.added, 'Link to Virvi')!.onPointerDown()
    c.handlers.get('virvi:link')!({ status: 'self', attempt: c.sent.find((m) => m.name === 'virvi:link')!.data.attempt })
    await c.settle()
    for (let i = 0; i < 3 && !c.added.flatMap(texts).includes('Linked to Virvi as Ada'); i++) await c.tick()
    command({ playerId: 'p2', cmd: 'virvi', value: 'https://x.io/other.glb', args: ['virvi', 'https://x.io/other.glb'] })
    command({ playerId: 'p1', cmd: 'spawn', value: 'https://x.io/spawn.glb', args: ['spawn', 'https://x.io/spawn.glb'] })
    command({ playerId: 'p1', cmd: 'virvi', value: 'https://x.io/a.glb', args: ['virvi', 'https://x.io/a.glb'] })
    const shown = c.added.flatMap(texts)
    expect(shown).toContain('https://x.io/a.glb')
    expect(shown).not.toContain('https://x.io/other.glb')
    expect(shown).not.toContain('https://x.io/spawn.glb')
  })

  it('self-run: the server half never vouches and tells the player to pair from the browser', async () => {
    const s = run({ isServer: true, players: [admin('p1', 'Pip')] })
    s.handlers.get('virvi:link')!(null, 'p1')
    await s.settle()
    expect(s.requests.filter((r) => r.url.includes('vouch'))).toEqual([])
    expect(s.sentTo).toEqual([{ playerId: 'p1', name: 'virvi:link', data: { status: 'self', attempt: 0 } }])
  })
})
