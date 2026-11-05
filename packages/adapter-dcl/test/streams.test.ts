import { describe, it, expect } from 'vitest'
import { offImageChoices, offImageLabel, screensFromPreset, screenSourceLabel, streamOptionLabel, withLiveSource, withOffImage, type HUDStream } from '../src/streams.js'

const streams: HUDStream[] = [
  { id: 's1', name: 'Main Stage', hlsPlaylistUrl: 'https://live/main.m3u8', live: true, mine: false },
  { id: 's2', name: 'Editor Cam', hlsPlaylistUrl: 'https://live/cam.m3u8', live: false, mine: true },
]

describe('screensFromPreset', () => {
  it('lists the video screens with their live source and whether live is on', () => {
    const preset = {
      elements: [
        { id: 'v1', type: 'video', name: 'Big screen', properties: { liveSrc: ' https://live/main.m3u8 ', enableLiveStream: true } },
        { id: 'i1', type: 'image', name: 'Poster', properties: {} },
        { id: 'v2', type: 'video', name: '', properties: null },
      ],
    }
    expect(screensFromPreset(preset)).toEqual([
      { id: 'v1', name: 'Big screen', liveSrc: 'https://live/main.m3u8', liveOn: true, offImageSrc: '', scheduled: false },
      { id: 'v2', name: 'Video screen', liveSrc: '', liveOn: false, offImageSrc: '', scheduled: false },
    ])
    expect(screensFromPreset(null)).toEqual([])
  })
})

describe('labels', () => {
  it('name the stream a screen plays, as the dashboard does', () => {
    expect(screenSourceLabel({ liveSrc: 'https://live/main.m3u8' }, streams)).toBe('Main Stage (live)')
    expect(screenSourceLabel({ liveSrc: 'https://live/cam.m3u8' }, streams)).toBe('Editor Cam (offline, yours)')
    expect(screenSourceLabel({ liveSrc: 'https://elsewhere/x.m3u8' }, streams)).toBe('Custom link')
    expect(screenSourceLabel({ liveSrc: '' }, streams)).toBe('No stream')
    expect(streamOptionLabel(streams[1])).toBe('Editor Cam (offline, yours)')
  })
})

describe('withLiveSource', () => {
  it('changes only the live source, keeping every other property (the server replaces them all)', () => {
    const props = { liveSrc: 'old', offType: 2, playlist: ['a'], enableLiveStream: false }
    expect(withLiveSource(props, 'https://live/cam.m3u8')).toEqual({ liveSrc: 'https://live/cam.m3u8', offType: 2, playlist: ['a'], enableLiveStream: false })
    expect(withLiveSource(null, 'u')).toEqual({ liveSrc: 'u' })
    expect(props.liveSrc).toBe('old')
  })
})

describe('off image (LIV-54)', () => {
  const item = (extra: Record<string, unknown>) => ({
    id: 'a', kind: 'media', name: 'Poster.png', contentType: 'image/png', url: 'https://cdn/poster.png', sizeBytes: 1,
    bookingId: null, createdAt: '', status: 'ready', error: null, ...extra,
  }) as any

  it('reads each screen’s off image', () => {
    const preset = { elements: [{ id: 'v1', type: 'video', name: 'S', properties: { offImageSrc: ' https://cdn/poster.png ' } }, { id: 'v2', type: 'video', name: 'T', properties: {} }] }
    expect(screensFromPreset(preset).map((s) => s.offImageSrc)).toEqual(['https://cdn/poster.png', ''])
  })

  it('offers the ready images in the scene library', () => {
    expect(offImageChoices([
      item({ id: 'a' }),
      item({ id: 'b', name: 'Clip.mp4', contentType: 'video/mp4', url: 'https://cdn/clip.mp4' }),
      item({ id: 'c', status: 'processing', url: '' }),
      item({ id: 'd', kind: 'model', name: 'Chair.glb', contentType: 'model/gltf-binary', url: 'https://cdn/chair.glb' }),
      item({ id: 'e', name: 'Bg.jpg', contentType: 'image/jpeg', url: 'https://cdn/bg.jpg' }),
    ])).toEqual([
      { id: 'a', name: 'Poster.png', url: 'https://cdn/poster.png' },
      { id: 'e', name: 'Bg.jpg', url: 'https://cdn/bg.jpg' },
    ])
  })

  it('names the off image by its library name', () => {
    const images = [{ id: 'a', name: 'Poster.png', url: 'https://cdn/poster.png' }]
    expect(offImageLabel({ offImageSrc: 'https://cdn/poster.png' }, images)).toBe('Off image: Poster.png')
    expect(offImageLabel({ offImageSrc: 'https://elsewhere/x.png' }, images)).toBe('Off image: from a link')
    expect(offImageLabel({ offImageSrc: '' }, images)).toBe('No off image')
  })

  it('sets or clears the off image and keeps the other properties', () => {
    expect(withOffImage({ liveSrc: 'x', offType: 1 }, 'https://cdn/poster.png')).toEqual({ liveSrc: 'x', offType: 1, offImageSrc: 'https://cdn/poster.png' })
    // Cleared to '' rather than dropped: the in-world update only applies keys that are present
    expect(withOffImage({ offImageSrc: 'https://cdn/poster.png' }, '')).toEqual({ offImageSrc: '' })
  })
})
