/**
 * LIV-134 CI check: the built Decentraland runtime, run the way Decentraland's LOD/map builder (abgen) runs a scene,
 * places the deployed models. abgen evaluates the scene in a bare JS engine with a stub prelude (fetch resolves to
 * nothing, WebSocket never opens, getSceneInformation returns made-up metadata with no `virvi` block, readFile serves
 * the deployment's own files), then runs onStart and 91 onUpdate frames on a fake clock, and keeps the entities with a
 * Transform and a GltfContainer whose src is a deployed file. That is the scene's Initial Scene State, which the map
 * photo and the distant view are made of. With nothing placed, abgen publishes no ISS and the parcel stays blank.
 *
 * The prelude below follows abgen's crate/src/lodgen/scenerun/prelude.js and driver.rs as of decentraland/abgen main
 * 542a686ae7f8348a789eebe365406f07f7dd466a (read 2026-11-07; last changed in 7000bd2fb9fe4c4d00e85ef84f1d907ea6a28504 and
 * 84b267163d5a8cba9dec3f9b0e03cc7c0d9dd715). The scene
 * runs in a fresh node:vm context: no setTimeout, TextDecoder or URL, as in the QuickJS sandbox. The CRDT the scene
 * sends to the "renderer" is replayed into a fresh @dcl/ecs engine to read the resulting state.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { Engine, components } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { PLACEMENTS_FILE, encodePlacements, type Placement } from '@virvixr/shared'
import { PLACEMENTS_READ_TIMEOUT_S } from '../src/placements.js'

const ROOT = new URL('../../../', import.meta.url)
const VERSION = /export const DCL_RUNTIME_VERSION = (\d+)/.exec(readFileSync(new URL('apps/server/src/services/dcl/runtime.ts', ROOT), 'utf8'))![1]
const BUNDLE = readFileSync(new URL(`apps/server/dcl-runtime/${VERSION}/bin/index.js`, ROOT), 'utf8')

/** abgen's prelude, condensed: the same stubs and the same tick/immediates loop. */
const PRELUDE = `
globalThis.global = globalThis;
globalThis.__abgen_module = { exports: {} };
globalThis.console = { log() {}, info() {}, debug() {}, trace() {}, warn() {}, warning() {}, error() {} };
globalThis.fetch = async (url) => { __abgen.network('fetch ' + url); return { status: 200, json: async () => undefined, text: async () => '' } };
globalThis.WebSocket = class WebSocket {
  constructor(url) { this.url = url; __abgen.network('ws ' + url) } onmessage() {} send() {} onclose() {} onerror() {} onopen() {} close() {}
  readyState = 0; CLOSED = 1; CLOSING = 0; CONNECTING = 0; OPEN = 0;
};
const __immediates = [];
globalThis.setImmediate = (fn) => { __immediates.push(fn) };
const __realDate = Date;
let __now = 1704067200000;
globalThis.__advanceClock = (ms) => { __now += ms };
globalThis.Date = class Date extends __realDate {
  constructor(...a) { if (a.length === 0) super(Math.floor(__now)); else super(...a) }
  static now() { return Math.floor(__now) }
};
const ok = async () => ({});
const __modules = {
  AdaptationLayerHelper: { getTextureSize: ok },
  EnvironmentApi: {
    isPreviewMode: async () => ({ isPreview: false }), getBootstrapData: ok, getPlatform: async () => ({ platform: 'LOD-generator' }),
    areUnsafeRequestAllowed: async () => ({ status: false }), getCurrentRealm: ok, getExplorerConfiguration: async () => ({ clientUri: '', configurations: {} }),
    getDecentralandTime: async () => ({ seconds: Date.now() / 1000 }),
  },
  CommsApi: { VideoTrackSourceType: {}, getActiveVideoStreams: async () => ({ streams: [] }) },
  EthereumController: { requirePayment: ok, signMessage: ok, convertMessageToObject: ok, sendAsync: ok, getUserAccount: ok },
  EngineApi: {
    sendBatch: async () => ({ events: [] }), subscribe: async () => ({ events: [] }), unsubscribe: async () => ({ events: [] }),
    crdtGetState: async () => ({ hasEntities: false, data: [] }),
    crdtGetMessageFromRenderer: async () => ({ data: [] }),
    crdtSendToRenderer: async ({ data }) => { __abgen.sendToRenderer(data); return { data: [] } },
    isServer: async () => ({ isServer: false }),
  },
  UserIdentity: { getUserData: async () => ({ data: { displayName: 'empty', publicKey: 'empty', hasConnectedWeb3: true, userId: 'empty', version: 0 } }), getUserPublicKey: ok },
  SignedFetch: { signedFetch: async (r) => (__abgen.network('signedFetch ' + (r && r.url)), { ok: false, status: 404, statusText: 'invalid lod server', headers: {}, body: '' }), getHeaders: async () => ({ headers: {} }) },
  Runtime: {
    getWorldTime: async () => ({ seconds: Date.now() / 1000 }),
    getExplorerInformation: async () => ({ agent: 'lod-server', platform: 'lod-server-platform', configurations: {} }),
    getRealm: async () => ({ realmInfo: undefined }),
    readFile: async ({ fileName }) => __abgen.readFile(fileName),
    getSceneInformation: async () => ({
      urn: 'https://none', baseUrl: 'https://none', content: [],
      metadataJson: __abgen.metadataJson || JSON.stringify({ display: { title: '', favicon: '' }, owner: '', contact: { name: '', email: '' }, main: 'bin/game.js', tags: [], scene: { parcels: ['-,-'], base: '-,-' } }),
    }),
  },
  RestrictedActions: { triggerEmote: ok, movePlayerTo: ok, changeRealm: ok, openExternalUrl: ok, openNftDialog: ok, setCommunicationsAdapter: ok, teleportTo: ok, triggerSceneEmote: ok },
  CommunicationsController: { send: ok, sendBinary: async () => ({ data: [] }) },
  PortableExperiences: { exit: ok, getPortableExperiencesLoaded: async () => ({ loaded: [] }), kill: ok, spawn: ok },
  UserActionModule: { requestTeleport: ok },
  Players: { getPlayerData: ok, getConnectedPlayers: async () => ({ players: [] }), getPlayersInScene: async () => ({ players: [] }) },
  Scene: { getSceneInfo: async () => ({ cid: '', metadata: '{}', baseUrl: '', contents: [] }) },
};
globalThis.require = (name) => {
  const key = String(name).replace(/^~system\\//, '');
  if (key in __modules) return __modules[key];
  throw new Error('Unknown module ' + name);
};
globalThis.__tick = async (kind, dt) => {
  try {
    const exp = globalThis.__abgen_module.exports;
    if (kind === 'start') { if (exp.onStart) await exp.onStart() } else if (exp.onUpdate) await exp.onUpdate(dt);
  } catch (err) { __abgen.log('[' + kind + ' failed]: ' + err) }
  while (__immediates.length) for (const fn of __immediates.splice(0)) { try { await fn() } catch (err) { __abgen.log('[setImmediate failed]: ' + err) } }
};
`

const TIMED_FRAMES = 90
const FRAME_DT_MS = 100 / 3

/** Lets every pending job run, as QuickJS's pump does between abgen's calls. */
const pump = () => new Promise<void>((r) => setImmediate(r))

/**
 * Runs `code` like abgen does; returns the CRDT it sent, what it logged and the network calls it made, each with the
 * frame it happened in. Outside abgen's own conditions, for the startup-timeout check: `hangReads` never settles a
 * readFile (a stalled content fetch), `metadataJson` replaces the made-up metadata, `frames` runs more timed frames.
 */
async function runLikeAbgen(code: string, files: Map<string, Uint8Array>, opts: { hangReads?: boolean; metadataJson?: string; frames?: number } = {}) {
  const sent: Uint8Array[] = []
  const logs: string[] = []
  const reads: string[] = []
  const network: Array<{ call: string; frame: number }> = []
  let frame = -1
  const ctx = vm.createContext({
    __abgen: {
      sendToRenderer: (data: Uint8Array) => sent.push(new Uint8Array(data)),
      readFile: (name: string) => {
        reads.push(name)
        if (opts.hangReads) return new Promise(() => {})
        const content = files.get(name)
        if (!content) throw new Error(`file not found: ${name}`)
        return { content, hash: 'bafy' }
      },
      log: (s: string) => logs.push(s),
      network: (call: string) => network.push({ call, frame }),
      metadataJson: opts.metadataJson,
    },
  })
  vm.runInContext(PRELUDE, ctx)
  await pump()
  let evalError: unknown = null
  try {
    vm.runInContext(`;(function (module, exports) { ${code}\n}).call(__abgen_module.exports, __abgen_module, __abgen_module.exports);`, ctx)
  } catch (err) {
    evalError = err
  }
  await pump()
  const tick = async (kind: string, dt: number) => { await (ctx.__tick as (k: string, d: number) => Promise<void>)(kind, dt); await pump() }
  await tick('start', 0)
  frame = 0
  await tick('update', 0)
  for (let i = 0; i < (opts.frames ?? TIMED_FRAMES); i++) {
    frame = i + 1
    ;(ctx.__advanceClock as (ms: number) => void)(FRAME_DT_MS)
    await tick('update', FRAME_DT_MS / 1000)
  }
  return { sent, logs, reads, network, evalError }
}

/** The scene state the CRDT describes: entities with a Transform and a GltfContainer. */
async function placedModels(sent: Uint8Array[]) {
  const e = Engine()
  const Transform = components.Transform(e)
  const GltfContainer = components.GltfContainer(e)
  const transport: any = { send: async () => {}, filter: () => true }
  e.addTransport(transport)
  for (const chunk of sent) transport.onmessage(chunk)
  await e.update(0)
  return [...e.getEntitiesWith(Transform, GltfContainer)].map(([, t, g]) => ({ src: g.src, mask: g.visibleMeshesCollisionMask, t }))
}

const copy = (i: string, src: string, over: Partial<Placement> = {}): Placement => ({
  instanceId: i, elementId: 'e', src, position: { x: 4, y: 0, z: 6 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, collisions: false, ...over,
})

/** A wizard World's deployment, as Virvi assembles it: runtime, scene.json, models and the placements snapshot. */
function deployment(placements: Placement[] | null) {
  const enc = (s: string) => new TextEncoder().encode(s)
  const files = new Map<string, Uint8Array>([
    ['bin/index.js', enc(BUNDLE)],
    ['scene.json', enc(JSON.stringify({ main: 'bin/index.js', scene: { parcels: ['0,0'], base: '0,0' }, virvi: { runtime: Number(VERSION), apiUrl: 'https://virvi.io', wssUrl: 'wss://virvi.io' } }))],
    ['models/virvi/Chair.glb', enc('glb')],
    ['models/virvi/Tower.glb', enc('glb')],
  ])
  if (placements) files.set(PLACEMENTS_FILE, enc(encodePlacements(placements)))
  return files
}

describe(`runtime v${VERSION} in a Decentraland LOD sandbox`, () => {
  it('places every deployed model within the 90 frames, with no network and no virvi metadata', async () => {
    const files = deployment([
      copy('i1', 'models/virvi/Chair.glb'),
      copy('i2', 'models/virvi/Chair.glb', { position: { x: 10, y: 0, z: 2 }, rotation: { x: 0, y: 45, z: 0 }, scale: { x: 2, y: 2, z: 2 } }),
      copy('i3', 'models/virvi/Tower.glb', { position: { x: 8, y: 0, z: 8 }, collisions: true }),
    ])
    const run = await runLikeAbgen(BUNDLE, files)
    expect(run.evalError).toBeNull()
    expect(run.reads).toContain(PLACEMENTS_FILE)
    const placed = await placedModels(run.sent)
    expect(placed.map((p) => p.src).sort()).toEqual(['models/virvi/Chair.glb', 'models/virvi/Chair.glb', 'models/virvi/Tower.glb'])
    for (const p of placed) expect(files.has(p.src)).toBe(true) // abgen drops a src the deployment doesn't ship
    const rotated = placed.find((p) => p.t.position.x === 10)!
    expect(rotated.t.scale).toEqual({ x: 2, y: 2, z: 2 })
    const q = Quaternion.fromEulerDegrees(0, 45, 0)
    for (const k of ['x', 'y', 'z', 'w'] as const) expect(rotated.t.rotation[k]).toBeCloseTo(q[k], 5)
    expect(placed.find((p) => p.src.endsWith('Tower.glb'))).toMatchObject({ mask: 2, t: { position: { x: 8, y: 0, z: 8 } } })
  })

  it('never touches the network in the LOD run (it returns at the missing virvi block)', async () => {
    const run = await runLikeAbgen(BUNDLE, deployment([copy('i1', 'models/virvi/Chair.glb')]))
    expect(run.network).toEqual([])
  })

  it(`still connects to Virvi when the snapshot read stalls, after ${PLACEMENTS_READ_TIMEOUT_S} s of frames and not before`, async () => {
    const metadataJson = JSON.stringify({ main: 'bin/index.js', scene: { parcels: ['0,0'], base: '0,0' }, virvi: { runtime: Number(VERSION), apiUrl: 'https://virvi.test', wssUrl: 'wss://virvi.test' } })
    const timeoutFrames = Math.ceil((PLACEMENTS_READ_TIMEOUT_S * 1000) / FRAME_DT_MS)
    const run = await runLikeAbgen(BUNDLE, deployment([copy('i1', 'models/virvi/Chair.glb')]), { hangReads: true, metadataJson, frames: timeoutFrames + 30 })
    expect(run.evalError).toBeNull()
    expect(run.reads).toContain(PLACEMENTS_FILE)
    expect(run.network.length).toBeGreaterThan(0)
    expect(run.network[0].frame).toBeGreaterThanOrEqual(timeoutFrames - 1)
    expect(run.network[0].frame).toBeLessThanOrEqual(timeoutFrames + 2)
    expect(await placedModels(run.sent)).toEqual([])
  })

  it('places nothing, and still runs, in a deployment without a snapshot (a v10 scene with no models)', async () => {
    const run = await runLikeAbgen(BUNDLE, deployment(null))
    expect(run.evalError).toBeNull()
    expect(await placedModels(run.sent)).toEqual([])
  })
})
