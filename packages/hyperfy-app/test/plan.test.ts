import { describe, expect, it } from 'vitest'
import type { SerializedScene } from '@virvixr/shared'
import { diffPlans, planScene } from '../src/plan.js'

const v = (x: number, y: number, z: number) => ({ x, y, z })
const inst = (sk: string, extra: Record<string, unknown> = {}) => ({
  sk,
  enabled: true,
  position: v(1, 2, 3),
  rotation: v(0, 0, 0),
  scale: v(4, 2, 1),
  ...extra,
})
const scene = (parts: Partial<SerializedScene>): SerializedScene => ({
  videos: [],
  images: [],
  models: [],
  sounds: [],
  ...parts,
})
const video = (extra: Record<string, unknown> = {}, instances = [inst('i1')]) => ({
  sk: 'v1',
  enabled: true,
  volume: 0.5,
  isLive: false,
  enableLiveStream: true,
  liveSrc: 'https://live.example/stream.m3u8',
  offType: 0,
  playlist: ['https://cdn.example/a.mp4', 'https://cdn.example/b.mp4'],
  offImageSrc: 'https://cdn.example/off.png',
  instances,
  ...extra,
})

describe('planScene', () => {
  it('live video shows liveSrc', () => {
    const [item] = planScene(scene({ videos: [video({ isLive: true })] }))
    expect(item).toMatchObject({
      key: 'v1:i1',
      kind: 'video',
      src: 'https://live.example/stream.m3u8',
      volume: 0.5,
      width: 4,
      height: 2,
    })
    expect(item.transform.position).toEqual([1, 2, -3])
  })

  it('keeps the element name and the Virvi transform for editing', () => {
    const [item] = planScene(scene({ videos: [video({ name: 'Screen', isLive: true })] }))
    expect(item.name).toBe('Screen')
    expect(item.virvi).toEqual({ position: v(1, 2, 3), rotation: v(0, 0, 0), scale: v(4, 2, 1) })
    const [unnamed] = planScene(scene({ videos: [video({ isLive: true })] }))
    expect(unnamed.name).toBe('')
  })

  it('playlist mode starts on the first video and carries the whole playlist, unlooped', () => {
    const [item] = planScene(scene({ videos: [video({ offType: 2 })] }))
    expect(item).toMatchObject({
      kind: 'video',
      src: 'https://cdn.example/a.mp4',
      loop: false,
      playlist: ['https://cdn.example/a.mp4', 'https://cdn.example/b.mp4'],
    })
  })

  it('a one-video playlist loops that video', () => {
    const [item] = planScene(scene({ videos: [video({ offType: 2, playlist: ['https://cdn.example/a.mp4'] })] }))
    expect(item).toMatchObject({ src: 'https://cdn.example/a.mp4', loop: true, playlist: ['https://cdn.example/a.mp4'] })
  })

  it('a playlist skips videos it cannot play; an empty one shows nothing', () => {
    const list = ['https://cdn.example/a.webm', 'https://cdn.example/b.mp4', 'https://cdn.example/c.m3u8']
    const [item] = planScene(scene({ videos: [video({ offType: 2, playlist: list })] }))
    expect(item).toMatchObject({ src: 'https://cdn.example/b.mp4', loop: false, playlist: list.slice(1) })
    expect(planScene(scene({ videos: [video({ offType: 2, playlist: [] })] }))).toEqual([])
  })

  it('only playlist mode carries a playlist', () => {
    const [live] = planScene(scene({ videos: [video({ isLive: true })] }))
    expect(live.playlist).toEqual([])
  })

  it('off image mode becomes an image item', () => {
    const [item] = planScene(scene({ videos: [video({ offType: 1 })] }))
    expect(item).toMatchObject({ kind: 'image', src: 'https://cdn.example/off.png', width: 4, height: 2 })
  })

  it('ad modes and none show nothing', () => {
    for (const offType of [0, 3, 4, 5]) {
      expect(planScene(scene({ videos: [video({ offType })] }))).toEqual([])
    }
  })

  it('disabled elements and instances are skipped', () => {
    const s = scene({
      videos: [video({ offType: 2, enabled: false })],
      images: [
        {
          sk: 'im1',
          enabled: true,
          textureSrc: 'https://cdn.example/p.png',
          instances: [inst('a', { enabled: false }), inst('b')],
        },
      ],
    })
    expect(planScene(s).map((i) => i.key)).toEqual(['im1:b'])
  })

  it('plan skips unsupported media and keeps the rest', () => {
    const s = scene({
      images: [
        { sk: 'gif', enabled: true, textureSrc: 'https://cdn.example/a.gif', instances: [inst('i')] },
        { sk: 'empty', enabled: true, textureSrc: '', instances: [inst('i')] },
        { sk: 'ok', enabled: true, textureSrc: 'https://cdn.example/a.JPG?x=1', instances: [inst('i')] },
        { sk: 'webp', enabled: true, textureSrc: 'https://cdn.example/a.webp', instances: [inst('i')] },
      ],
      videos: [
        video({ sk: 'webm', offType: 2, playlist: ['https://cdn.example/a.webm'] }),
        video({ sk: 'live', isLive: true, liveSrc: 'https://live.example/x.m3u8' }),
      ],
      models: [
        { sk: 'm', enabled: true, modelSrc: 'https://cdn.example/m.glb', instances: [inst('i')] },
        { sk: 'nomodel', enabled: true, instances: [inst('i')] },
      ],
      sounds: [{ sk: 's', enabled: true, audioSrc: 'https://cdn.example/s.mp3', volume: 0.3, instances: [inst('i')] }],
    })
    const items = planScene(s)
    expect(items.map((i) => i.key).sort()).toEqual(['live:i1', 'm:i', 'ok:i', 's:i', 'webp:i'])
    expect(items.find((i) => i.key === 's:i')).toMatchObject({ kind: 'audio', loop: true, volume: 0.3 })
    expect(items.find((i) => i.key === 'm:i')).toMatchObject({ kind: 'model', src: 'https://cdn.example/m.glb' })
  })

  it('external click events carry their url', () => {
    const s = scene({
      images: [
        {
          sk: 'im',
          enabled: true,
          textureSrc: 'https://cdn.example/p.png',
          clickEvent: { type: 1, externalLink: 'https://el.example/' },
          instances: [
            inst('a'),
            inst('b', { clickEvent: { type: 1, externalLink: 'https://inst.example/' } }),
            inst('c', { clickEvent: { type: 4, moveTo: { position: v(0, 0, 0) } } }),
          ],
        },
      ],
    })
    const urls = Object.fromEntries(planScene(s).map((i) => [i.key, i.clickUrl]))
    expect(urls).toEqual({ 'im:a': 'https://el.example/', 'im:b': 'https://inst.example/', 'im:c': null })
  })

  it('an instance click of type NONE falls back to the element click', () => {
    const s = scene({
      images: [
        {
          sk: 'im',
          enabled: true,
          textureSrc: 'https://cdn.example/p.png',
          clickEvent: { type: 1, externalLink: 'https://el.example/' },
          instances: [
            inst('none', { clickEvent: { type: 0, externalLink: '' } }),
            inst('untyped', { clickEvent: { externalLink: 'https://x.example/' } }),
            inst('own', { clickEvent: { type: 1, externalLink: 'https://inst.example/' } }),
          ],
        },
      ],
    })
    const urls = Object.fromEntries(planScene(s).map((i) => [i.key, i.clickUrl]))
    expect(urls).toEqual({ 'im:none': 'https://el.example/', 'im:untyped': 'https://el.example/', 'im:own': 'https://inst.example/' })
  })

  it('plans without the URL global (not a Hyperfy sandbox global)', () => {
    // Hyperfy's compartment has no URL constructor: read as undefined, and record any read at all.
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'URL')!
    let touched = false
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      get: () => {
        touched = true
        return undefined
      },
    })
    try {
      const s = scene({
        images: [
          { sk: 'q', enabled: true, textureSrc: 'https://cdn.example/a.png?v=2#top', instances: [inst('i')] },
          { sk: 'gif', enabled: true, textureSrc: 'https://cdn.example/a.gif?x=.png', instances: [inst('i')] },
        ],
      })
      touched = false
      const keys = planScene(s).map((i) => i.key)
      const read = touched
      expect(keys).toEqual(['q:i'])
      expect(read).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'URL', saved)
    }
  })

  it('null scene plans nothing', () => {
    expect(planScene(null)).toEqual([])
  })
})

describe('diffPlans', () => {
  it('reports adds, removes and changed items only', () => {
    const prev = planScene(
      scene({
        images: [
          { sk: 'a', enabled: true, textureSrc: 'https://c.example/a.png', instances: [inst('1')] },
          { sk: 'b', enabled: true, textureSrc: 'https://c.example/b.png', instances: [inst('1')] },
          { sk: 'c', enabled: true, textureSrc: 'https://c.example/c.png', instances: [inst('1')] },
        ],
      }),
    )
    const next = planScene(
      scene({
        images: [
          { sk: 'a', enabled: true, textureSrc: 'https://c.example/a.png', instances: [inst('1')] },
          { sk: 'b', enabled: true, textureSrc: 'https://c.example/b2.png', instances: [inst('1')] },
          { sk: 'd', enabled: true, textureSrc: 'https://c.example/d.png', instances: [inst('1')] },
        ],
      }),
    )
    const d = diffPlans(prev, next)
    expect(d.add.map((i) => i.key)).toEqual(['d:1'])
    expect(d.remove).toEqual(['c:1'])
    expect(d.update.map((i) => i.key)).toEqual(['b:1'])
  })
})
