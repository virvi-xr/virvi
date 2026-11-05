import { describe, it, expect } from 'vitest'
import { screensFromPreset, screenSourceLabel, streamOptionLabel, withLiveSource, type HUDStream } from '../src/streams.js'

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
      { id: 'v1', name: 'Big screen', liveSrc: 'https://live/main.m3u8', liveOn: true },
      { id: 'v2', name: 'Video screen', liveSrc: '', liveOn: false },
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
