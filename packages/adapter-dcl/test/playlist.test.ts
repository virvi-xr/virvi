import { describe, it, expect, vi, beforeEach } from 'vitest'

// A minimal stand-in for the SDK 7 runtime: entities, VideoPlayer components, one system list, and the
// video states the explorer reports through VideoEvent.
const sdk = vi.hoisted(() => {
  const VS_LOADING = 2
  const VS_PLAYING = 4
  const VS_PAUSED = 7
  let next = 512
  const players = new Map<number, any>()
  const states = new Map<number, { state: number; currentOffset: number; videoLength: number }>()
  const systems: Array<(dt: number) => void> = []
  const engine = {
    addEntity: () => next++,
    removeEntity: (e: number) => {
      players.delete(e)
      states.delete(e)
    },
    addSystem: (fn: (dt: number) => void) => void systems.push(fn),
  }
  const VideoPlayer = {
    createOrReplace: (e: number, v: any) => {
      players.set(e, { ...v })
      // VideoEvent keeps the previous source's last state until the new one reports
    },
    getMutableOrNull: (e: number) => players.get(e) ?? null,
    has: (e: number) => players.has(e),
  }
  const VideoEvent = { has: (e: number) => states.has(e) }
  const videoEventsSystem = { getVideoState: (e: number) => states.get(e) }
  const stub = () => ({})
  const component = { createOrReplace: stub, getMutableOrNull: stub, has: () => false, deleteFrom: stub }
  return {
    VS_LOADING,
    VS_PLAYING,
    VS_PAUSED,
    players,
    states,
    systems,
    reset() {
      players.clear()
      states.clear()
      systems.length = 0
    },
    ecs: {
      engine,
      VideoPlayer,
      VideoEvent,
      videoEventsSystem,
      VideoState: { VS_LOADING, VS_PLAYING, VS_PAUSED },
      Transform: component,
      MeshRenderer: { setPlane: stub },
      MeshCollider: { setBox: stub, setPlane: stub, deleteFrom: stub },
      Material: { setPbrMaterial: stub, setBasicMaterial: stub, Texture: { Common: stub, Video: stub } },
      AudioSource: component,
      GltfContainer: component,
      Name: component,
      TextShape: component,
      PointerEvents: component,
      pointerEventsSystem: { onPointerDown: stub, removeOnPointerDown: stub },
      ColliderLayer: {},
      InputAction: {},
    },
  }
})

vi.mock('@dcl/sdk/ecs', () => sdk.ecs)
vi.mock('@dcl/sdk/math', () => ({
  Vector3: { create: (x: number, y: number, z: number) => ({ x, y, z }) },
  Quaternion: { fromEulerDegrees: () => ({ x: 0, y: 0, z: 0, w: 1 }) },
  Color3: { White: () => ({ r: 1, g: 1, b: 1 }), create: () => ({}) },
  Color4: { create: () => ({}) },
}))

import { SceneManager, VirviStorageImpl, EventBus } from '@virvixr/core'
import { DclAdapter } from '../src/DclAdapter.js'

const frame = () => sdk.systems.forEach((s) => s(0.016))

/** The one VideoPlayer in the scene (each screen has its own player entity). */
function player(): { e: number; vp: any } {
  const [e, vp] = [...sdk.players.entries()][0]
  return { e, vp }
}

/** The explorer loads the current source, plays it to its end, and pauses there (as it does with loop off). */
function playToEnd(length = 30) {
  const { e } = player()
  sdk.states.set(e, { state: sdk.VS_LOADING, currentOffset: 0, videoLength: 0 })
  frame()
  sdk.states.set(e, { state: sdk.VS_PLAYING, currentOffset: 10, videoLength: length })
  frame()
  sdk.states.set(e, { state: sdk.VS_PAUSED, currentOffset: length, videoLength: length })
  frame()
}

const screen = (playlist: string[], offType = 2) => ({
  sk: 'tv',
  name: 'TV',
  enabled: true,
  offType,
  playlist,
  instances: [{ sk: 'tv-i', enabled: true, position: { x: 8, y: 1, z: 8 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 3.2, y: 1.8, z: 1 } }],
})

function load(playlist: string[]) {
  const sm = new SceneManager(new DclAdapter(), VirviStorageImpl.create(), new EventBus())
  sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen(playlist)] } })
  return sm
}

describe('DclAdapter playlist mode', () => {
  beforeEach(() => sdk.reset())

  it('plays each of three videos in turn and loops back to the first after the last', () => {
    load(['https://v/1.mp4', 'https://v/2.mp4', 'https://v/3.mp4'])
    const seen = [player().vp.src]
    for (let i = 0; i < 4; i++) {
      playToEnd()
      seen.push(player().vp.src)
    }
    expect(seen).toEqual(['https://v/1.mp4', 'https://v/2.mp4', 'https://v/3.mp4', 'https://v/1.mp4', 'https://v/2.mp4'])
    expect(player().vp).toMatchObject({ playing: true, loop: false })
  })

  it('one end advances once, however many frames the video sits paused at its end', () => {
    load(['https://v/1.mp4', 'https://v/2.mp4', 'https://v/3.mp4'])
    playToEnd()
    expect(player().vp.src).toBe('https://v/2.mp4')
    // The new source has not reported yet and the old end state lingers: no further advance.
    const { e } = player()
    sdk.states.set(e, { state: sdk.VS_PAUSED, currentOffset: 30, videoLength: 30 })
    for (let i = 0; i < 5; i++) frame()
    expect(player().vp.src).toBe('https://v/2.mp4')
  })

  it('a single video loops in the player and never advances', () => {
    load(['https://v/only.mp4'])
    expect(player().vp).toMatchObject({ src: 'https://v/only.mp4', loop: true, playing: true })
    playToEnd()
    expect(player().vp).toMatchObject({ src: 'https://v/only.mp4', loop: true })
  })

  it('an empty playlist creates no video player', () => {
    load([])
    expect(sdk.players.size).toBe(0)
  })
})
