import { describe, expect, it } from 'vitest'
import { mediaLabel, mediaNamesKey, urlFilename } from './media-names'

const intro = 'https://cdn.virvi.io/9b2d1c4e-0f6a-4a51-9a8e-2f1c3b4d5e6f/3cb079fe-bc44-4ebf-87db-459e003c7c3f.mp4'
const outro = 'https://cdn.virvi.io/9b2d1c4e-0f6a-4a51-9a8e-2f1c3b4d5e6f/0d6f6a1e-6c1b-4b7e-8c1a-1e2f3a4b5c6d.mp4'
const pasted = 'https://example.com/clips/My%20Clip.mp4'

describe('mediaLabel', () => {
  it('a playlist built from library assets shows their names', () => {
    const lookup = { names: { [intro]: 'Intro trailer.mp4', [outro]: 'Outro.mp4' }, missing: [] }
    expect([intro, outro].map((u) => mediaLabel(u, lookup).label)).toEqual(['Intro trailer.mp4', 'Outro.mp4'])
  })
  it("a pasted URL with no library asset shows the URL's filename", () => {
    expect(mediaLabel(pasted, { names: {}, missing: [] })).toEqual({ label: 'My Clip.mp4', missing: false })
  })
  it('a deleted upload shows "Missing video"', () => {
    expect(mediaLabel(intro, { names: {}, missing: [intro] })).toEqual({ label: 'Missing video', missing: true })
    expect(mediaLabel(intro, { names: {}, missing: [intro] }, 'Missing image').label).toBe('Missing image')
  })
  it('before the lookup answers (or if it fails), shows the filename', () => {
    expect(mediaLabel(pasted, null).label).toBe('My Clip.mp4')
  })
})

describe('urlFilename', () => {
  it('drops the query and keeps a malformed escape as is', () => {
    expect(urlFilename('https://x.dev/a/b.mp4?token=1#t')).toBe('b.mp4')
    expect(urlFilename('https://x.dev/a/%E0%A4%A.mp4')).toBe('%E0%A4%A.mp4')
    expect(urlFilename('')).toBe('')
  })
})

describe('mediaNamesKey', () => {
  it('ignores order, repeats and blanks, so reordering a playlist does not look up again', () => {
    expect(mediaNamesKey([outro, intro, intro, ''])).toBe(mediaNamesKey([intro, outro]))
    expect(mediaNamesKey([])).toBe('')
  })
})
