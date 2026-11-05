import { describe, expect, it } from 'vitest'
import type { ShowingInstance } from '@virvixr/shared'
import { newSeekState, scheduledSign, scheduledView, seekAction, signLayout, virviClockOffset, SHOWING_SETTLE_MS } from '../src/showings.js'

const T0 = Date.UTC(2026, 10, 5, 19, 0)
const show = (over: Partial<ShowingInstance> = {}): ShowingInstance => ({
  showingId: 's1',
  startsAt: T0,
  title: 'Film',
  items: [
    { url: 'https://x/trailer.mp4', duration: 60, kind: 'ad' },
    { url: 'https://x/film.mp4', duration: 5400, kind: 'video' },
  ],
  ...over,
})
const HOLD = 'https://x/poster.png'

describe('scheduledView', () => {
  it('shows the holding image between showings', () => {
    expect(scheduledView([show()], T0 - 1000, HOLD)).toEqual({ key: `between:${HOLD}`, type: 'image', src: HOLD })
  })

  it('shows nothing between showings when the screen has no holding image', () => {
    expect(scheduledView([show()], T0 - 1000, '')).toEqual({ key: 'between:', type: 'none' })
    expect(scheduledView([], T0, '')).toMatchObject({ type: 'none' })
  })

  it('a visitor who arrives mid-film gets the film at the shared second', () => {
    const v = scheduledView([show()], T0 + (60 + 754.5) * 1000, HOLD)
    expect(v).toMatchObject({ type: 'video', src: 'https://x/film.mp4', duration: 5400 })
    expect(v.type === 'video' && v.offset).toBeCloseTo(754.5)
  })

  it('the key changes from the trailer to the film, and when the next showing of the same programme starts', () => {
    const a = scheduledView([show()], T0 + 30_000, HOLD).key
    const b = scheduledView([show()], T0 + 90_000, HOLD).key
    const later = show({ startsAt: T0 + 86_400_000 })
    const c = scheduledView([show(), later], later.startsAt + 90_000, HOLD).key
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('the key changes when an edit swaps the video at the same place in the programme', () => {
    const edited = show({ items: [show().items[0], { url: 'https://x/recut.mp4', duration: 5400 }] })
    expect(scheduledView([show()], T0 + 90_000, HOLD).key).not.toBe(scheduledView([edited], T0 + 90_000, HOLD).key)
  })

  it('goes back to the holding image once the showing ends', () => {
    expect(scheduledView([show()], T0 + 5460_000, HOLD).type).toBe('image')
  })
})

describe('virviClockOffset', () => {
  it("is Virvi's clock minus the world's shared clock, in ms", () => {
    expect(virviClockOffset(T0, 120.5)).toBe(T0 - 120_500)
  })
})

describe('seekAction', () => {
  const NOW = 1_000_000
  const playing = (time: number) => ({ playing: true, time, duration: 5400 })

  it('waits for the video to load, then seeks once to where the show is', () => {
    const st = newSeekState()
    expect(seekAction(st, NOW, 100, 5400, { playing: false, time: 0, duration: 0 })).toBe(false)
    expect(seekAction(st, NOW, 100, 5400, { playing: true, time: 0, duration: 5400 })).toBe(true)
    expect(st).toMatchObject({ seeked: true, seekAt: NOW, seeks: 0 })
  })

  it('re-seeks a player that has slipped more than 2 s, after it has had time to settle', () => {
    const st = newSeekState()
    seekAction(st, NOW, 100, 5400, playing(0))
    expect(seekAction(st, NOW + 10_000, 110, 5400, playing(104))).toBe(false) // settling
    const t = NOW + SHOWING_SETTLE_MS + 1
    expect(seekAction(st, t, 130, 5400, playing(129))).toBe(false) // within 2 s
    expect(seekAction(st, t + 5_000, 135, 5400, playing(131))).toBe(true)
    expect(st.seeks).toBe(1)
  })

  it('checks at most every 5 s, gives up after 3 re-seeks, and leaves the last 10 s alone', () => {
    const st = newSeekState()
    seekAction(st, NOW, 0, 5400, playing(0))
    let t = NOW
    let seeks = 0
    for (let i = 0; i < 6; i++) {
      t += SHOWING_SETTLE_MS + 1
      if (seekAction(st, t, 1000 + i * 100, 5400, playing(0))) seeks++
      expect(seekAction(st, t + 1000, 1000 + i * 100, 5400, playing(0))).toBe(false)
    }
    expect(seeks).toBe(3)
    const end = newSeekState()
    seekAction(end, NOW, 0, 5400, playing(0))
    expect(seekAction(end, NOW + SHOWING_SETTLE_MS + 1, 5395, 5400, playing(5300))).toBe(false)
  })

  it('does not re-seek a paused player (autoplay blocked)', () => {
    const st = newSeekState()
    seekAction(st, NOW, 0, 5400, playing(0))
    expect(seekAction(st, NOW + SHOWING_SETTLE_MS + 1, 100, 5400, { playing: false, time: 0, duration: 5400 })).toBe(false)
  })
})

describe('scheduledSign', () => {
  it('counts down to the next showing on the holding image', () => {
    expect(scheduledSign([show()], T0 - 90_000)).toBe('Next: Film\nin 1:30')
  })
  it('counts down to the feature during the ads before it, then names the film briefly', () => {
    expect(scheduledSign([show()], T0 + 15_000)).toBe('Film starts in 0:45')
    expect(scheduledSign([show()], T0 + 65_000)).toBe('Now showing: Film')
    expect(scheduledSign([show()], T0 + 600_000)).toBeNull()
  })
  it('says nothing with nothing scheduled', () => {
    expect(scheduledSign([], T0)).toBeNull()
  })
})

describe('signLayout', () => {
  it('spans the screen, sits near its bottom edge and just in front, with text in proportion', () => {
    expect(signLayout(4, 2)).toEqual({ width: 400, height: 64, fontSize: 20, position: [0, -0.7, 0.02] })
  })
  it('keeps the text readable on tiny screens and in proportion on huge ones', () => {
    expect(signLayout(0.5, 0.3).fontSize).toBe(10)
    expect(signLayout(0.5, 0.3).width).toBe(200)
    expect(signLayout(20, 12).fontSize).toBe(50)
  })
})
