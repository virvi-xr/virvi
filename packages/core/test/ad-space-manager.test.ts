import { describe, it, expect, vi } from 'vitest'
import { AD_LIMITS } from '@virvixr/shared'
import type { AdItem, AdServeResponse } from '@virvixr/shared'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'
import { AdHost } from '../src/ads/host.js'

type Serve = AdServeResponse | null

function setup(serves: Serve[] = [], opts: { noVideoEnded?: boolean; post?: () => Promise<{ ok: boolean; status: number }> } = {}) {
  let next = 1
  let t = 1_000_000
  const systems = new Set<(dt: number) => void>()
  const destroyed = new Set<number>()
  const texted = new Set<number>()
  const ended = new Map<number, () => void>()
  const media: { e: number; kind: 'image' | 'video'; src: string; opts: any }[] = []
  const adapter: any = {
    capabilities: { video: true, platformName: 'test' },
    createEntity: vi.fn(() => next++),
    destroyEntity: vi.fn((e: number) => destroyed.add(e)),
    entityExists: vi.fn((e: number) => !destroyed.has(e)),
    setTransform: vi.fn(),
    setPlaneRenderer: vi.fn(),
    setMaterial: vi.fn((e: number, m: any) => media.push({ e, kind: 'image', src: m.textureSrc, opts: m })),
    createVideoPlayer: vi.fn((e: number, o: any) => media.push({ e, kind: 'video', src: o.src, opts: o })),
    setCollider: vi.fn(),
    removeCollider: vi.fn(),
    onPointerDown: vi.fn(),
    removePointerEvents: vi.fn(),
    openUrl: vi.fn(),
    registerSystem: vi.fn((fn: (dt: number) => void) => systems.add(fn)),
    unregisterSystem: vi.fn((fn: (dt: number) => void) => systems.delete(fn)),
    onPointerHover: vi.fn(),
    getCameraPose: vi.fn(() => null),
    setText: vi.fn((e: number) => texted.add(e)),
  }
  if (!opts.noVideoEnded) adapter.onVideoEnded = vi.fn((e: number, cb: () => void) => ended.set(e, cb))

  const queue = [...serves]
  const getAds = vi.fn(async (_ids: string[]) => (queue.length > 1 ? queue.shift()! : queue[0] ?? null))
  const postEvents = vi.fn(opts.post ?? (async () => ({ ok: true, status: 200 })))
  const host = new AdHost({ adapter, getAds, postEvents, now: () => t })
  const storage = VirviStorageImpl.create()
  const sm = new SceneManager(adapter, storage, new EventBus(), host)

  const frame = () => [...systems].forEach((s) => s(0.016))
  const advance = (ms: number) => {
    t += ms
    frame()
  }
  /** The live, non-label entity placed at this x (the ad space or screen itself). */
  const entityAt = (x: number): number => {
    const hits = adapter.setTransform.mock.calls
      .filter(([e, tr]: any) => tr.position.x === x && !destroyed.has(e) && !texted.has(e))
      .map((c: any) => c[0])
    return hits[hits.length - 1]
  }
  const showing = (e: number) => [...media].reverse().find((m) => m.e === e) ?? null
  const hasPlane = (e: number) => adapter.setPlaneRenderer.mock.calls.some((c: any) => c[0] === e)
  const hasCollider = (e: number) => adapter.setCollider.mock.calls.some((c: any) => c[0] === e)
  const hasClick = (e: number) => adapter.onPointerDown.mock.calls.some((c: any) => c[0] === e)
  const labels = () => [...texted].filter((e) => !destroyed.has(e))
  const end = (e: number) => ended.get(e)!()

  return { adapter, host, sm, getAds, postEvents, frame, advance, entityAt, showing, hasPlane, hasCollider, hasClick, labels, end }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

const ad = (adId: string, kind: 'image' | 'video' = 'image'): AdItem => ({
  adId,
  creativeId: `c-${adId}`,
  kind,
  url: `https://cdn.example/${adId}.${kind === 'image' ? 'png' : 'mp4'}`,
  clickUrl: `https://brand.example/${adId}`,
  house: false,
})

const space = (sk: string, x: number, extra: Record<string, unknown> = {}, scale = { x: 1.6, y: 0.9, z: 1 }) => ({
  sk,
  name: sk,
  enabled: true,
  shape: '16:9',
  formats: 'both',
  instances: [{ sk: `${sk}-i`, enabled: true, position: { x, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, scale, withCollisions: true }],
  ...extra,
})

const screen = (sk: string, x: number, extra: Record<string, unknown> = {}) => ({
  sk,
  name: sk,
  enabled: true,
  enableLiveStream: true,
  liveSrc: 'https://live/a.m3u8',
  offType: 1,
  offImageSrc: 'https://img/off.png',
  playlist: [],
  instances: [{ sk: `${sk}-i`, enabled: true, position: { x, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 3.2, y: 1.8, z: 1 } }],
  ...extra,
})

const serve = (spaces: Record<string, { paused?: boolean; ads: AdItem[] }>): AdServeResponse => ({
  spaces: Object.fromEntries(Object.entries(spaces).map(([k, v]) => [k, { paused: v.paused ?? false, ads: v.ads }])),
})

describe('AdSpaceManager', () => {
  it('ad space with nothing to show hides itself', async () => {
    const s = setup([serve({ s1: { ads: [] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1)] } })
    await s.host.refresh()
    const e = s.entityAt(1)
    expect(e).toBeDefined()
    expect(s.hasPlane(e)).toBe(false)
    expect(s.hasCollider(e)).toBe(false)
    expect(s.hasClick(e)).toBe(false)
    expect(s.showing(e)).toBeNull()
    expect(s.labels()).toEqual([])
  })

  it('shows its fallback image when it has one', async () => {
    const s = setup([serve({ s1: { ads: [] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1, { fallbackImageSrc: 'https://img/fallback.png' })] } })
    await s.host.refresh()
    const e = s.entityAt(1)
    expect(s.hasPlane(e)).toBe(true)
    expect(s.showing(e)).toMatchObject({ kind: 'image', src: 'https://img/fallback.png' })
    expect(s.hasClick(e)).toBe(false)
    expect(s.labels()).toEqual([])
  })

  it('stream going live stops video ads and ending it restores them', async () => {
    const s = setup([serve({ both: { ads: [ad('v1', 'video'), ad('i1')] }, vonly: { ads: [ad('v2', 'video')] } })])
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { videos: [screen('tv', 9)], adSpaces: [space('both', 1), space('vonly', 2, { formats: 'video' })] },
    })
    await s.host.refresh()
    const bothVideo = s.entityAt(1)
    expect(s.showing(bothVideo)).toMatchObject({ kind: 'video', src: ad('v1', 'video').url })
    expect(s.showing(s.entityAt(2))).toMatchObject({ kind: 'video', src: ad('v2', 'video').url })
    expect(s.sm.isStreamLive()).toBe(false)

    s.sm.handleVideoStatus({ elementId: 'tv', status: 'live', url: 'https://live/now.m3u8' })
    expect(s.sm.isStreamLive()).toBe(true)
    // the both space drops its video at once (the player goes with the old entity) and shows its image ad
    expect(s.adapter.destroyEntity).toHaveBeenCalledWith(bothVideo)
    expect(s.showing(s.entityAt(1))).toMatchObject({ kind: 'image', src: ad('i1').url })
    // the video-only space has nothing it may show and no fallback: hidden
    const hidden = s.entityAt(2)
    expect(s.hasPlane(hidden)).toBe(false)
    expect(s.hasCollider(hidden)).toBe(false)
    expect(s.showing(hidden)).toBeNull()

    s.sm.handleVideoStatus({ elementId: 'tv', status: 'offline' })
    expect(s.sm.isStreamLive()).toBe(false)
    expect(s.showing(s.entityAt(2))).toMatchObject({ kind: 'video', src: ad('v2', 'video').url })
    // the image ad finishes its turn, then the video ad comes back
    s.advance(AD_LIMITS.imageSeconds * 1000)
    expect(s.showing(s.entityAt(1))).toMatchObject({ kind: 'video', src: ad('v1', 'video').url })
  })

  it('a video-only space with a fallback shows it while a stream is live', async () => {
    const s = setup([serve({ vonly: { ads: [ad('v2', 'video')] } })])
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { videos: [screen('tv', 9)], adSpaces: [space('vonly', 2, { formats: 'video', fallbackImageSrc: 'https://img/fb.png' })] },
    })
    await s.host.refresh()
    s.sm.handleVideoStatus({ elementId: 'tv', status: 'live' })
    expect(s.showing(s.entityAt(2))).toMatchObject({ kind: 'image', src: 'https://img/fb.png' })
  })

  it('enabling a live stream through a preset update stops video ads', async () => {
    const s = setup([serve({ both: { ads: [ad('v1', 'video'), ad('i1')] } })])
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { videos: [screen('tv', 9, { isLive: true, enableLiveStream: false })], adSpaces: [space('both', 1)] },
    })
    await s.host.refresh()
    expect(s.showing(s.entityAt(1))).toMatchObject({ kind: 'video' })

    s.sm.handlePresetUpdate({ action: 'update', element: 'video', elementData: { sk: 'tv', enableLiveStream: true } })
    expect(s.sm.isStreamLive()).toBe(true)
    expect(s.showing(s.entityAt(1))).toMatchObject({ kind: 'image', src: ad('i1').url })
  })

  it('deleting the live screen brings video ads back at once', async () => {
    const s = setup([serve({ vonly: { ads: [ad('v2', 'video')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen('tv', 9)], adSpaces: [space('vonly', 2, { formats: 'video' })] } })
    await s.host.refresh()
    s.sm.handleVideoStatus({ elementId: 'tv', status: 'live' })
    expect(s.hasPlane(s.entityAt(2))).toBe(false)

    s.sm.handlePresetUpdate({ action: 'delete', element: 'video', id: 'tv' })
    expect(s.sm.isStreamLive()).toBe(false)
    expect(s.showing(s.entityAt(2))).toMatchObject({ kind: 'video', src: ad('v2', 'video').url })
  })

  it('a disabled screen does not count as a live stream', async () => {
    const s = setup([serve({ vonly: { ads: [ad('v2', 'video')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen('tv', 9)], adSpaces: [space('vonly', 2, { formats: 'video' })] } })
    await s.host.refresh()
    s.sm.handleVideoStatus({ elementId: 'tv', status: 'live' })
    s.sm.handlePresetUpdate({ action: 'update', element: 'video', elementData: { sk: 'tv', enabled: false } })
    expect(s.sm.isStreamLive()).toBe(false)
    expect(s.showing(s.entityAt(2))).toMatchObject({ kind: 'video', src: ad('v2', 'video').url })
  })

  it('a preset change never leaves a video ad playing while a stream is live', async () => {
    const s = setup([serve({ ads: { ads: [ad('v1', 'video'), ad('i1')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen('ads', 8, { offType: 4 })] } })
    await s.host.refresh()
    expect(s.showing(s.entityAt(8))).toMatchObject({ kind: 'video' })

    // the ads-mode screen comes before the live screen in the new preset
    s.sm.handlePresetChange({ scenePreset: { videos: [screen('ads', 8, { offType: 4 }), screen('tv', 9, { isLive: true })] } })
    expect(s.sm.isStreamLive()).toBe(true)
    expect(s.showing(s.entityAt(8))).toMatchObject({ kind: 'image', src: ad('i1').url })
  })

  it('a video ad that never reports its end gives up its slot after two minutes', async () => {
    const s = setup([serve({ a: { ads: [ad('v', 'video')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('a', 1, { formats: 'video' })] } })
    await s.host.refresh()
    expect(s.adapter.createVideoPlayer).toHaveBeenCalledTimes(1)
    s.advance(120_000 - 1)
    expect(s.adapter.createVideoPlayer).toHaveBeenCalledTimes(1)
    s.advance(1)
    // finished and released: the next pick gets a slot again
    expect(s.adapter.createVideoPlayer).toHaveBeenCalledTimes(2)
    expect(s.host.videoSlot()).toBe(true) // one of two in use
    expect(s.host.videoSlot()).toBe(false)
  })

  it('serve failure shows fallback and retries on next refresh', async () => {
    const s = setup([null, serve({ s1: { ads: [ad('i1')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1, { fallbackImageSrc: 'https://img/fallback.png' })] } })
    await s.host.start()
    expect(s.getAds).toHaveBeenCalledTimes(1)
    expect(s.getAds).toHaveBeenLastCalledWith(['s1'])
    expect(s.showing(s.entityAt(1))).toMatchObject({ src: 'https://img/fallback.png' })

    // no retry before the refresh interval
    s.advance(AD_LIMITS.serveRefreshMs - 1)
    await settle()
    expect(s.getAds).toHaveBeenCalledTimes(1)

    s.advance(1)
    await settle()
    expect(s.getAds).toHaveBeenCalledTimes(2)
    expect(s.showing(s.entityAt(1))).toMatchObject({ kind: 'image', src: ad('i1').url })
    expect(s.labels()).toHaveLength(1)
  })

  it('treats a malformed serve response as a failure', async () => {
    const s = setup([{} as any])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1)] } })
    await s.host.refresh()
    expect(s.hasPlane(s.entityAt(1))).toBe(false)
  })

  it('video ads are muted and limited to two per scene', async () => {
    const vids = { ads: [ad('v', 'video')] }
    const s = setup([serve({ a: vids, b: vids, c: vids })])
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { adSpaces: [space('a', 1, { formats: 'video' }), space('b', 2, { formats: 'video' }), space('c', 3, { formats: 'video' })] },
    })
    await s.host.refresh()
    expect(s.adapter.createVideoPlayer).toHaveBeenCalledTimes(AD_LIMITS.maxVideoAdsPerScene)
    for (const [, o] of s.adapter.createVideoPlayer.mock.calls) expect(o).toMatchObject({ volume: 0, loop: false, playing: true })
    expect(s.showing(s.entityAt(3))).toBeNull()

    // a finished video gives its slot back; the next one plays again within the limit
    s.end(s.entityAt(1))
    expect(s.adapter.createVideoPlayer).toHaveBeenCalledTimes(AD_LIMITS.maxVideoAdsPerScene + 1)
    expect(s.showing(s.entityAt(1))).toMatchObject({ kind: 'video' })
  })

  it('a video-only space waiting for a video slot gets one within imageSeconds of it freeing', async () => {
    const vids = { ads: [ad('v', 'video')] }
    const s = setup([serve({ a: vids, b: vids, c: vids })])
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { adSpaces: [space('a', 1, { formats: 'video' }), space('b', 2, { formats: 'video' }), space('c', 3, { formats: 'video' })] },
    })
    await s.host.start()
    expect(s.showing(s.entityAt(3))).toBeNull()
    s.sm.handlePresetUpdate({ action: 'delete', element: 'ad_space', id: 'a' })
    s.advance(AD_LIMITS.imageSeconds * 1000)
    expect(s.showing(s.entityAt(3))).toMatchObject({ kind: 'video' })
  })

  it('an adapter without onVideoEnded never plays video ads', async () => {
    const s = setup([serve({ a: { ads: [ad('v', 'video'), ad('i')] } })], { noVideoEnded: true })
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('a', 1)] } })
    await s.host.refresh()
    expect(s.adapter.createVideoPlayer).not.toHaveBeenCalled()
    expect(s.showing(s.entityAt(1))).toMatchObject({ kind: 'image', src: ad('i').url })
  })

  it('an instance smaller than 0.5 m on its short side shows no ads', async () => {
    const ads = { ads: [ad('i1')] }
    const s = setup([serve({ small: ads, big: ads })])
    s.sm.handlePresetUpdate({
      action: 'init',
      // 0.8 m wide at 16:9 is 0.45 m tall; 0.5 m square is just big enough
      scenePreset: { adSpaces: [space('small', 1, {}, { x: 0.8, y: 5, z: 1 }), space('big', 2, { shape: '1:1' }, { x: 0.5, y: 0.1, z: 1 })] },
    })
    await s.host.refresh()
    expect(s.hasPlane(s.entityAt(1))).toBe(false)
    expect(s.showing(s.entityAt(2))).toMatchObject({ src: ad('i1').url })
  })

  it("the plane's height follows its width and shape, so ads are never stretched", async () => {
    const s = setup([serve({ wide: { ads: [] }, tall: { ads: [] }, sq: { ads: [] }, portrait: { ads: [] } })])
    const unit = { x: 1, y: 1, z: 1 }
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: {
        adSpaces: [
          space('wide', 1, {}, { x: 1.6, y: 1.6, z: 1 }),
          space('tall', 2, { shape: '2:5' }, unit),
          space('sq', 3, { shape: '1:1' }, { x: 2, y: 0.3, z: 1 }),
          space('portrait', 4, { shape: '9:16' }, unit),
        ],
      },
    })
    const scaleAt = (x: number) => s.adapter.setTransform.mock.calls.filter((c: any) => c[0] === s.entityAt(x)).at(-1)[1].scale
    expect(scaleAt(1)).toEqual({ x: 1.6, y: 0.9, z: 1 })
    expect(scaleAt(2)).toEqual({ x: 1, y: 2.5, z: 1 })
    expect(scaleAt(3)).toEqual({ x: 2, y: 2, z: 1 })
    expect(scaleAt(4)).toEqual({ x: 1, y: 16 / 9, z: 1 })

    // a scale change keeps the shape's proportions; so does a shape change
    s.sm.handlePresetUpdate({ action: 'update', element: 'ad_space', instance: true, instanceData: { sk: 'wide-i', scale: { x: 3.2, y: 1, z: 1 } } })
    expect(scaleAt(1)).toEqual({ x: 3.2, y: 1.8, z: 1 })
    s.sm.handlePresetUpdate({ action: 'update', element: 'ad_space', elementData: { sk: 'wide', shape: '1:1' } })
    expect(scaleAt(1)).toEqual({ x: 3.2, y: 3.2, z: 1 })
    // in-world moving previews with the same proportions
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('p', 5)] } })
    const e = s.entityAt(5)
    const manager = (s.sm as any).managers.ad_space
    manager.previewTransform('p-i', { position: { x: 6, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1.6, y: 7, z: 1 } })
    expect(s.adapter.setTransform.mock.calls.filter((c: any) => c[0] === e).at(-1)[1].scale).toEqual({ x: 1.6, y: 0.9, z: 1 })
  })

  it('a shape change re-serves the space at once', async () => {
    const s = setup([serve({ s1: { ads: [ad('wide')] } }), serve({ s1: { ads: [ad('square')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1)] } })
    await s.host.start()
    expect(s.showing(s.entityAt(1))).toMatchObject({ src: ad('wide').url })
    s.sm.handlePresetUpdate({ action: 'upsert', element: 'ad_space', elementData: space('s1', 1, { shape: '1:1' }) })
    s.frame()
    await settle()
    expect(s.getAds).toHaveBeenCalledTimes(2)
    expect(s.showing(s.entityAt(1))).toMatchObject({ src: ad('square').url })
  })

  it('paused space shows fallback or hides', async () => {
    const paused = { paused: true, ads: [ad('i1')] }
    const s = setup([serve({ fb: paused, none: paused })])
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { adSpaces: [space('fb', 1, { fallbackImageSrc: 'https://img/fb.png' }), space('none', 2)] },
    })
    await s.host.refresh()
    expect(s.showing(s.entityAt(1))).toMatchObject({ src: 'https://img/fb.png' })
    expect(s.hasPlane(s.entityAt(2))).toBe(false)
    expect(s.labels()).toEqual([])
  })

  it('image ads rotate every imageSeconds and carry an "Ad" label', async () => {
    const s = setup([serve({ s1: { ads: [ad('a'), ad('b')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1)] } })
    await s.host.refresh()
    const e = s.entityAt(1)
    expect(s.showing(e)).toMatchObject({ src: ad('a').url })
    expect(s.adapter.setText).toHaveBeenCalledWith(expect.anything(), 'Ad', { fontSize: 1 })
    s.advance(AD_LIMITS.imageSeconds * 1000 - 1)
    expect(s.showing(e)).toMatchObject({ src: ad('a').url })
    s.advance(1)
    expect(s.showing(e)).toMatchObject({ src: ad('b').url })
  })

  it('clicking an ad opens its link and records a click', async () => {
    const s = setup([serve({ s1: { ads: [ad('i1')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1)] } })
    await s.host.start()
    s.frame() // the tracker counts only once a tick has placed the player in the scene
    const e = s.entityAt(1)
    const [, pointerOpts, onClick] = s.adapter.onPointerDown.mock.calls.find((c: any) => c[0] === e)
    expect(pointerOpts).toMatchObject({ hoverText: 'Open link' })
    const [, enter, leave, maxDistance] = s.adapter.onPointerHover.mock.calls.find((c: any) => c[0] === e)
    expect(maxDistance).toBe(AD_LIMITS.hoverMaxDistanceM)

    onClick({})
    enter()
    leave()
    expect(s.adapter.openUrl).toHaveBeenCalledWith('https://brand.example/i1')
    await s.host.tracker.flush()
    const sent = s.postEvents.mock.calls.flatMap((c: any) => c[0].events)
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adId: 'i1', elementId: 's1', level: 'scene' }),
        expect.objectContaining({ adId: 'i1', elementId: 's1', level: 'click' }),
        expect.objectContaining({ adId: 'i1', elementId: 's1', level: 'look' }),
      ]),
    )
    expect(s.postEvents.mock.calls[0][0]).toMatchObject({ v: 1, sessionId: expect.any(String) })
  })

  it('a batch the server rejects with a 4xx is dropped; a 5xx keeps it for later', async () => {
    let status = 400
    const s = setup([serve({ s1: { ads: [ad('i1')] } })], { post: async () => ({ ok: false, status }) })
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1)] } })
    await s.host.start()
    s.frame()
    await s.host.tracker.flush()
    expect(s.postEvents).toHaveBeenCalledTimes(1)
    await s.host.tracker.flush()
    expect(s.postEvents).toHaveBeenCalledTimes(1) // dropped, nothing left to send

    status = 503
    s.adapter.onPointerDown.mock.calls.at(-1)[2]({})
    await s.host.tracker.flush()
    await s.host.tracker.flush()
    expect(s.postEvents).toHaveBeenCalledTimes(3) // kept and retried
  })

  it('deleting an ad space destroys its entities and stops serving it', async () => {
    const s = setup([serve({ s1: { ads: [ad('i1')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1)] } })
    await s.host.refresh()
    const e = s.entityAt(1)
    s.sm.handlePresetUpdate({ action: 'delete', element: 'ad_space', id: 's1' })
    expect(s.adapter.destroyEntity).toHaveBeenCalledWith(e)
    expect(s.labels()).toEqual([])
    await s.host.refresh()
    expect(s.getAds).toHaveBeenCalledTimes(1) // nothing attached: no serve call
  })
})

describe('frequency cap in the scene', () => {
  /** A moving camera at (x, 1, -5) looking along +Z, so only spaces placed at that x are on screen. */
  const lookAt = (s: ReturnType<typeof setup>, x: number) => {
    let n = 0
    s.adapter.getCameraPose.mockImplementation(() => ({ position: { x, y: 1, z: -5 - (n++ % 2) * 0.1 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }))
  }
  /** Run the scene a second at a time; the ad on the space at x each second ('HIDDEN' when none). */
  const watch = (s: ReturnType<typeof setup>, x: number, seconds: number) => {
    const out: string[] = []
    for (let i = 0; i < seconds; i++) {
      s.advance(1000)
      const e = s.entityAt(x)
      const m = s.showing(e)
      out.push(s.hasPlane(e) && m && s.labels().length > 0 ? m.src.split('/').pop()! : 'HIDDEN')
    }
    return out
  }

  it('a house ad space is never blanked by the cap', async () => {
    const s = setup([serve({ s1: { ads: [{ ...ad('h1'), house: true }] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1)] } })
    lookAt(s, 1)
    await s.host.start()
    expect(watch(s, 1, 280).filter((x) => x !== 'h1.png')).toEqual([])
  })

  it('a capped partner ad repeats rather than blanking its space', async () => {
    const s = setup([serve({ s1: { ads: [ad('p1')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1)] } })
    lookAt(s, 1)
    await s.host.start()
    expect(watch(s, 1, 280).filter((x) => x !== 'p1.png')).toEqual([])
  })

  it('only showings the visitor saw count against the cap, across every space', async () => {
    const s = setup([serve({ s1: { ads: [ad('a'), ad('b')] }, s2: { ads: [ad('a')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { adSpaces: [space('s1', 1), space('s2', 40)] } })
    lookAt(s, 40) // s2 on screen, s1 not
    await s.host.start()
    const s2 = watch(s, 40, 280)
    expect(s2.filter((x) => x !== 'a.png')).toEqual([])
    // a was seen freqCapPerHour times on s2 within about a minute; s1 (never seen) then shows only b
    const s1 = watch(s, 1, 60)
    expect(s1.filter((x) => x !== 'b.png')).toEqual([])
  })
})

describe('video screens in ad modes', () => {
  it('ads mode shows ads as a 16:9 both space on the screen', async () => {
    const s = setup([serve({ tv: { ads: [ad('i1')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen('tv', 9, { offType: 4 })] } })
    await s.host.refresh()
    expect(s.getAds).toHaveBeenLastCalledWith(['tv'])
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'image', src: ad('i1').url })
    expect(s.labels()).toHaveLength(1)

    // its own stream takes over (live branch first)
    s.sm.handleVideoStatus({ elementId: 'tv', status: 'live', url: 'https://live/now.m3u8' })
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'video', src: 'https://live/now.m3u8' })
    expect(s.labels()).toEqual([])
  })

  it('playlist + ads plays an ad after each playlist video, then resumes the playlist', async () => {
    const s = setup([serve({ tv: { ads: [ad('va', 'video'), ad('i1')] } })])
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { videos: [screen('tv', 9, { offType: 5, playlist: ['https://v/p1.mp4', 'https://v/p2.mp4'], volume: 50 })] },
    })
    await s.host.refresh()
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'video', src: 'https://v/p1.mp4', opts: { volume: 0.5 } })

    s.end(s.entityAt(9))
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'video', src: ad('va', 'video').url, opts: { volume: 0, loop: false } })
    expect(s.labels()).toHaveLength(1)

    s.end(s.entityAt(9))
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'video', src: 'https://v/p2.mp4', opts: { volume: 0.5 } })
    expect(s.labels()).toEqual([])

    s.end(s.entityAt(9))
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'image', src: ad('i1').url })
    s.advance(AD_LIMITS.imageSeconds * 1000)
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'video', src: 'https://v/p1.mp4' })
  })

  it('playlist + ads resumes the playlist when a video ad never reports its end', async () => {
    const s = setup([serve({ tv: { ads: [ad('va', 'video')] } })])
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { videos: [screen('tv', 9, { offType: 5, playlist: ['https://v/p1.mp4', 'https://v/p2.mp4'] })] },
    })
    await s.host.refresh()
    s.end(s.entityAt(9))
    expect(s.showing(s.entityAt(9))).toMatchObject({ src: ad('va', 'video').url })
    s.advance(120_000)
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'video', src: 'https://v/p2.mp4' })
  })

  it('playlist + ads with no ad to show continues the playlist', async () => {
    const s = setup([serve({ tv: { ads: [] } })])
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { videos: [screen('tv', 9, { offType: 5, playlist: ['https://v/p1.mp4', 'https://v/p2.mp4'] })] },
    })
    await s.host.refresh()
    s.end(s.entityAt(9))
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'video', src: 'https://v/p2.mp4' })
  })

  it('playlist + ads with an empty playlist rotates ads like ads mode', async () => {
    const s = setup([serve({ tv: { ads: [ad('a'), ad('b')] } })])
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen('tv', 9, { offType: 5, playlist: [] })] } })
    await s.host.refresh()
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'image', src: ad('a').url })
    s.advance(AD_LIMITS.imageSeconds * 1000)
    expect(s.showing(s.entityAt(9))).toMatchObject({ kind: 'image', src: ad('b').url })
  })

  it('playlist mode now advances to the next video when one ends', () => {
    const s = setup()
    s.sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { videos: [screen('tv', 9, { offType: 2, playlist: ['https://v/p1.mp4', 'https://v/p2.mp4'] })] },
    })
    const e = s.entityAt(9)
    expect(s.showing(e)).toMatchObject({ src: 'https://v/p1.mp4', opts: { loop: false } })
    s.end(e)
    expect(s.showing(e)).toMatchObject({ src: 'https://v/p2.mp4' })
    s.end(e)
    expect(s.showing(e)).toMatchObject({ src: 'https://v/p1.mp4' })
  })

  it('playlist mode plays three videos in turn, loops to the first, and a move keeps its place', () => {
    const s = setup()
    const list = ['https://v/p1.mp4', 'https://v/p2.mp4', 'https://v/p3.mp4']
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen('tv', 9, { offType: 2, playlist: list })] } })
    const e = s.entityAt(9)
    const seen = [s.showing(e)!.src]
    for (let i = 0; i < 3; i++) {
      s.end(e)
      seen.push(s.showing(e)!.src)
    }
    expect(seen).toEqual([...list, list[0]])
    s.end(e) // now on p2
    const moved = screen('tv', 10, { offType: 2, playlist: list })
    s.sm.handlePresetUpdate({ action: 'upsert', element: 'video', elementData: moved })
    expect(s.showing(s.entityAt(10))).toMatchObject({ src: 'https://v/p2.mp4' })
  })

  it('playlist mode with one video loops it in the player', () => {
    const s = setup()
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen('tv', 9, { offType: 2, playlist: ['https://v/p1.mp4'] })] } })
    const e = s.entityAt(9)
    expect(s.showing(e)).toMatchObject({ src: 'https://v/p1.mp4', opts: { loop: true } })
    s.end(e)
    expect(s.showing(e)).toMatchObject({ src: 'https://v/p1.mp4', opts: { loop: true } })
  })

  it('playlist mode with an empty playlist plays nothing', () => {
    const s = setup()
    s.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [screen('tv', 9, { offType: 2, playlist: [] })] } })
    expect(s.adapter.createVideoPlayer).not.toHaveBeenCalled()
  })
})
