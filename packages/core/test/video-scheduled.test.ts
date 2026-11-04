import { describe, it, expect, vi } from 'vitest'
import { VideoSourceType, type ShowingInstance } from '@virvixr/shared'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'

const T0 = Date.UTC(2026, 10, 6, 0, 0)

function setup(localNow = T0) {
  let next = 1
  const systems = new Set<(dt: number) => void>()
  const clock = { now: localNow }
  const adapter: any = {
    capabilities: { video: true, platformName: 'test' },
    createEntity: vi.fn(() => next++),
    destroyEntity: vi.fn(),
    setTransform: vi.fn(),
    setPlaneRenderer: vi.fn(),
    setMaterial: vi.fn(),
    setCollider: vi.fn(),
    removeCollider: vi.fn(),
    createVideoPlayer: vi.fn(),
    registerSystem: vi.fn((f: any) => systems.add(f)),
    unregisterSystem: vi.fn((f: any) => systems.delete(f)),
  }
  const storage = VirviStorageImpl.create()
  const sm = new SceneManager(adapter, storage, new EventBus(), null, () => clock.now)
  const tick = (ms: number) => {
    clock.now += ms
    for (const f of [...systems]) f(ms / 1000)
  }
  return { adapter, storage, sm, clock, tick, systems }
}

const inst = { sk: 'i1', enabled: true, position: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
const screen = (extra: Record<string, unknown> = {}) => ({
  sk: 'v1', name: 'Screen', enabled: true, offType: VideoSourceType.SCHEDULED, offImageSrc: 'https://img/next.png', playlist: [], volume: 80, instances: [inst], ...extra,
})
const show: ShowingInstance = {
  showingId: 's1', startsAt: T0, title: 'Film',
  items: [{ url: 'https://cdn/reel.mp4', duration: 60, kind: 'ad' }, { url: 'https://cdn/film.mp4', duration: 5400 }],
}
const message = (serverTime: number, showings = [show]) => ({ elementId: 'v1', serverTime, showings })
const lastPlayer = (adapter: any) => adapter.createVideoPlayer.mock.calls.at(-1)?.[1]
/** Calls that start a video (not the stops before a holding image). */
const plays = (adapter: any) => adapter.createVideoPlayer.mock.calls.filter((c: any[]) => c[1].playing).length

describe('scheduled screens', () => {
  it('joining mid-show starts the right video at the right second, on the server clock', () => {
    // The local clock is 5 s behind the server's
    const { sm, adapter } = setup(T0 + 754_000 - 5000)
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen()] } })
    sm.handleScreenShowings(message(T0 + 754_000))
    expect(lastPlayer(adapter)).toEqual({ src: 'https://cdn/film.mp4', playing: true, loop: false, volume: 0.8, position: 694 })
  })

  it('showings that arrive before the screen are used once it appears', () => {
    const { sm, adapter } = setup(T0 + 30_000)
    sm.handleScreenShowings(message(T0 + 30_000))
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen()] } })
    expect(lastPlayer(adapter)).toMatchObject({ src: 'https://cdn/reel.mp4', position: 30 })
  })

  it('between shows it shows the holding image, then starts the show on time from the beginning', () => {
    const { sm, adapter, tick } = setup(T0 - 10_000)
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen()] } })
    sm.handleScreenShowings(message(T0 - 10_000))
    expect(adapter.createVideoPlayer.mock.calls.every((c: any[]) => c[1].playing === false)).toBe(true)
    adapter.createVideoPlayer.mockClear()
    expect(adapter.setMaterial).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ textureSrc: 'https://img/next.png' }))
    tick(9_000)
    expect(adapter.createVideoPlayer).not.toHaveBeenCalled()
    tick(1_000)
    expect(lastPlayer(adapter)).toMatchObject({ src: 'https://cdn/reel.mp4', position: 0 })
  })

  it('moves on to the next item at the boundary, and back to the holding image at the end', () => {
    const { sm, adapter, tick } = setup(T0 + 59_000)
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen()] } })
    sm.handleScreenShowings(message(T0 + 59_000))
    expect(plays(adapter)).toBe(1)
    tick(500)
    expect(plays(adapter)).toBe(1) // same item: no re-seek
    tick(500)
    expect(lastPlayer(adapter)).toMatchObject({ src: 'https://cdn/film.mp4', position: 0 })
    adapter.setMaterial.mockClear()
    tick(5_400_000)
    expect(adapter.setMaterial).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ textureSrc: 'https://img/next.png' }))
  })

  it('new showings replace the old ones (an edit, or the hourly top-up), and the film stops', () => {
    const { sm, adapter } = setup(T0 + 100_000)
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen()] } })
    sm.handleScreenShowings(message(T0 + 100_000))
    sm.handleScreenShowings(message(T0 + 100_000, []))
    expect(lastPlayer(adapter)).toMatchObject({ playing: false })
    expect(adapter.setMaterial).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ textureSrc: 'https://img/next.png' }))
  })

  it('an unchanged top-up does not restart the video', () => {
    const { sm, adapter } = setup(T0 + 100_000)
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen()] } })
    sm.handleScreenShowings(message(T0 + 100_000))
    sm.handleScreenShowings(message(T0 + 101_000))
    expect(plays(adapter)).toBe(1)
  })

  it('leaving Schedule mode or removing the screen stops the clock', () => {
    const { sm, systems } = setup(T0 + 100_000)
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen()] } })
    sm.handleScreenShowings(message(T0 + 100_000))
    expect(systems.size).toBe(1)
    sm.handlePresetUpdate({ action: 'upsert', element: 'video', elementData: screen({ offType: VideoSourceType.IMAGE }) })
    expect(systems.size).toBe(0)
    sm.handlePresetUpdate({ action: 'upsert', element: 'video', elementData: screen() })
    expect(systems.size).toBe(1)
    sm.handlePresetUpdate({ action: 'delete', element: 'video', id: 'v1' })
    expect(systems.size).toBe(0)
  })

  it('a live stream that ends between shows leaves no sound under the holding image', () => {
    const { sm, adapter } = setup(T0 - 600_000)
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen({ enableLiveStream: true, liveSrc: 'https://live/a.m3u8' })] } })
    sm.handleScreenShowings(message(T0 - 600_000))
    sm.handleVideoStatus({ elementId: 'v1', status: 'live' })
    expect(lastPlayer(adapter)).toMatchObject({ src: 'https://live/a.m3u8', playing: true })
    sm.handleVideoStatus({ elementId: 'v1', status: 'offline' })
    expect(lastPlayer(adapter)).toMatchObject({ playing: false })
  })

  it('a disabled scheduled screen stops changing videos', () => {
    const { sm, adapter, tick, systems } = setup(T0 + 59_000)
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen()] } })
    sm.handleScreenShowings(message(T0 + 59_000))
    sm.handlePresetUpdate({ action: 'update', element: 'video', elementData: { sk: 'v1', enabled: false } })
    adapter.createVideoPlayer.mockClear()
    tick(2000)
    sm.handleScreenShowings(message(T0 + 61_000))
    expect(adapter.createVideoPlayer.mock.calls.filter((c: any[]) => c[1].playing)).toEqual([])
    expect(systems.size).toBe(0)
  })

  it('other modes ignore showings', () => {
    const { sm, adapter } = setup(T0 + 100_000)
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen({ offType: VideoSourceType.IMAGE })] } })
    sm.handleScreenShowings(message(T0 + 100_000))
    expect(adapter.createVideoPlayer).not.toHaveBeenCalled()
  })
})
