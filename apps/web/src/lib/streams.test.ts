import { describe, expect, it } from 'vitest'
import { streamForSource, streamOptionLabel } from './streams'

const main = { id: 's1', name: 'Main Stage', hlsPlaylistUrl: 'https://cdn.virvi.io/streams/abc/playlist.m3u8', live: true, mine: false }
const cam = { id: 's2', name: 'Editor Cam', hlsPlaylistUrl: 'https://cdn.virvi.io/streams/def/playlist.m3u8', live: false, mine: true }

describe('streamForSource', () => {
  it('finds the Virvi stream a screen plays, so it can show its name', () => {
    expect(streamForSource(main.hlsPlaylistUrl, [cam, main])).toBe(main)
    expect(streamForSource(` ${main.hlsPlaylistUrl} `, [main])).toBe(main)
  })
  it('a custom URL or no URL matches no stream', () => {
    expect(streamForSource('https://other.example/live.m3u8', [main, cam])).toBeNull()
    expect(streamForSource('', [main])).toBeNull()
    expect(streamForSource(undefined, null)).toBeNull()
  })
})

describe('streamOptionLabel', () => {
  it('names the stream, its status, and whose it is', () => {
    expect(streamOptionLabel(main)).toBe('Main Stage (live)')
    expect(streamOptionLabel(cam)).toBe('Editor Cam (offline, yours)')
  })
})
