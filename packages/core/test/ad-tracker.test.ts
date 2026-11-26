import { describe, it, expect, vi } from 'vitest'
import { AD_LIMITS } from '@virvixr/shared'
import type { AdEvent } from '@virvixr/shared'
import { AdTracker } from '../src/ads/tracker.js'

const identity = { x: 0, y: 0, z: 0, w: 1 }
const camera = { position: { x: 0, y: 0, z: 0 }, rotation: identity }
const spaces = { s1: { position: { x: 0, y: 0, z: 10 }, shortSideM: 4 } }

const settle = () => new Promise((r) => setTimeout(r, 0))

function setup(sendImpl?: (e: AdEvent[]) => Promise<boolean>) {
  let t = 1_000_000
  const sent: AdEvent[][] = []
  const send = vi.fn(async (events: AdEvent[]) => {
    sent.push(events)
    return sendImpl ? sendImpl(events) : true
  })
  const onSeen = vi.fn()
  const tracker = new AdTracker({ send, now: () => t, onSeen })
  const advance = (ms: number) => { t += ms }
  const tick = (o: Partial<{ inScene: boolean; moved: boolean; camera: typeof camera | null }> = {}) =>
    tracker.tick({ inScene: true, moved: true, camera, spaces, ...o })
  const all = () => sent.flat()
  return { tracker, send, sent, all, advance, tick, onSeen, now: () => t }
}

describe('AdTracker', () => {
  it('tracker emits scene once, screen after 1 s on screen, look with dwell, click', async () => {
    const { tracker, all, advance, tick } = setup()
    tick()
    tracker.showing('s1', 'el1', 'ad1')
    tick()
    advance(500)
    tick()
    await tracker.flush()
    expect(all().map((e) => e.level)).toEqual(['scene'])
    advance(600)
    tick()
    tracker.hoverStart('s1')
    advance(2500)
    tracker.hoverEnd('s1')
    tracker.click('s1')
    await tracker.flush()
    const events = all()
    expect(events.map((e) => e.level)).toEqual(['scene', 'screen', 'look', 'click'])
    for (const e of events) {
      expect(e.adId).toBe('ad1')
      expect(e.elementId).toBe('el1')
      expect(Number.isFinite(e.t)).toBe(true)
    }
    expect(events.find((e) => e.level === 'look')!.dwellMs).toBe(2500)
    expect(events.filter((e) => e.level !== 'look').every((e) => e.dwellMs === undefined)).toBe(true)
  })

  it('does not emit screen when the ad is off screen or interrupted', async () => {
    const { tracker, all, advance, tick } = setup()
    tracker.showing('s1', 'el1', 'ad1')
    tick({ camera: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 1, z: 0, w: 0 } } })
    advance(1500)
    tick({ camera: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 1, z: 0, w: 0 } } })
    await tracker.flush()
    expect(all().map((e) => e.level)).toEqual(['scene'])
    // looks at it for 600 ms, looks away, back for 600 ms: never continuous 1 s
    tick(); advance(600); tick()
    tick({ camera: null }); advance(100); tick({ camera: null })
    tick(); advance(600); tick()
    await tracker.flush()
    expect(all().map((e) => e.level)).toEqual(['scene'])
  })

  it('does not emit scene while the player is outside the scene', async () => {
    const { tracker, all, tick } = setup()
    tick({ inScene: false })
    tracker.showing('s1', 'el1', 'ad1')
    tick({ inScene: false })
    await tracker.flush()
    expect(all()).toEqual([])
    tick({ inScene: true })
    await tracker.flush()
    expect(all().map((e) => e.level)).toEqual(['scene'])
  })

  it('tracker emits each level once per session per ad', async () => {
    const { tracker, all, advance, tick } = setup()
    tick()
    for (let round = 0; round < 3; round++) {
      tracker.showing('s1', 'el1', 'ad1')
      tick()
      advance(1100)
      tick()
      tracker.hoverStart('s1')
      advance(300)
      tracker.hoverEnd('s1')
      tracker.click('s1')
      tracker.showing('s1', 'el1', null)
    }
    tracker.showing('s1', 'el1', 'ad2')
    tick()
    await tracker.flush()
    const keys = all().map((e) => `${e.adId}:${e.level}`)
    expect(keys.filter((k) => k.startsWith('ad1'))).toEqual(['ad1:scene', 'ad1:screen', 'ad1:look', 'ad1:click'])
    expect(keys).toContain('ad2:scene')
  })

  it('reports each showing as seen once it has been on screen for onScreenMinMs', () => {
    const { tracker, advance, tick, onSeen } = setup()
    tick()
    tracker.showing('s1', 'el1', 'ad1')
    tick()
    advance(AD_LIMITS.onScreenMinMs - 1)
    tick()
    expect(onSeen).not.toHaveBeenCalled()
    advance(1)
    tick()
    advance(5000)
    tick()
    expect(onSeen.mock.calls).toEqual([['s1', 'ad1']])
    // the same ad shown again is a new showing, though its screen event was already sent
    tracker.showing('s1', 'el1', 'ad1')
    tick()
    advance(AD_LIMITS.onScreenMinMs)
    tick()
    expect(onSeen.mock.calls).toEqual([['s1', 'ad1'], ['s1', 'ad1']])
    // off screen or idle: not seen
    const away = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 1, z: 0, w: 0 } }
    tracker.showing('s1', 'el1', 'ad2')
    tick({ camera: away })
    advance(5000)
    tick({ camera: away })
    advance(AD_LIMITS.idleMs)
    tick({ moved: false })
    advance(5000)
    tick({ moved: false })
    expect(onSeen).toHaveBeenCalledTimes(2)
  })

  it('tracks house ads like any other', async () => {
    const { tracker, all, tick } = setup()
    tick()
    tracker.showing('s1', 'el1', 'house-1')
    tick()
    await tracker.flush()
    expect(all().map((e) => e.adId)).toEqual(['house-1'])
  })

  it('emits nothing when no ad is showing', async () => {
    const { tracker, send, advance, tick } = setup()
    tracker.showing('s1', 'el1', null)
    tick(); advance(2000); tick()
    tracker.hoverStart('s1'); tracker.hoverEnd('s1'); tracker.click('s1')
    await tracker.flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('tracker stops emitting while idle and resumes on movement', async () => {
    const { tracker, all, advance, tick } = setup()
    tick()
    advance(AD_LIMITS.idleMs + 1)
    tick({ moved: false })
    tracker.showing('s1', 'el1', 'ad1')
    tracker.click('s1')
    advance(2000)
    tick({ moved: false })
    await tracker.flush()
    expect(all()).toEqual([])
    tick({ moved: true })
    await tracker.flush()
    expect(all().map((e) => e.level)).toEqual(['scene'])
    // screen needs a fresh continuous second after resuming
    advance(1100)
    tick({ moved: false })
    await tracker.flush()
    expect(all().map((e) => e.level)).toEqual(['scene', 'screen'])
  })

  it('tracker batches and keeps events after a failed send', async () => {
    let ok = false
    const { tracker, send, sent, tick } = setup(async () => ok)
    tick()
    // the 20th event reaches eventsFlushCount and triggers a flush, which fails
    for (let i = 0; i < AD_LIMITS.eventsFlushCount + 1; i++) {
      tracker.showing('s1', 'el1', `ad${i}`)
      tick()
    }
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(sent[0]).toHaveLength(AD_LIMITS.eventsFlushCount)
    // the failed events were kept, so the next flush sends all of them
    ok = true
    await tracker.flush()
    const retried = sent.slice(1).flat()
    expect(retried.map((e) => e.adId)).toEqual(Array.from({ length: AD_LIMITS.eventsFlushCount + 1 }, (_, i) => `ad${i}`))
    const before = send.mock.calls.length
    await tracker.flush()
    expect(send.mock.calls.length).toBe(before)
  })

  it('sends at most maxEventsPerBatch and keeps only the newest 200 after failures', async () => {
    let ok = false
    const { tracker, sent, tick } = setup(async () => ok)
    tick()
    for (let i = 0; i < 230; i++) {
      tracker.showing('s1', 'el1', `ad${i}`)
      tick()
    }
    await settle()
    sent.length = 0
    ok = true
    await tracker.flush()
    expect(sent.every((b) => b.length <= AD_LIMITS.maxEventsPerBatch)).toBe(true)
    const ids = sent.flat().map((e) => e.adId)
    expect(ids).toHaveLength(200)
    expect(ids[0]).toBe('ad30')
    expect(ids[199]).toBe('ad229')
  })

  it('flushes on the eventsFlushMs interval during tick', async () => {
    const { tracker, send, advance, tick } = setup()
    tick()
    tracker.showing('s1', 'el1', 'ad1')
    tick()
    expect(send).not.toHaveBeenCalled()
    advance(AD_LIMITS.eventsFlushMs + 1)
    tick()
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
  })

  describe('the visitor notice (GDPR notice)', () => {
    const gate = (g: { sending: boolean; declined: boolean }) => g

    it('held until the decision is attached, then sent once they accept', async () => {
      const { tracker, all, tick } = setup()
      tracker.hold()
      tick()
      tracker.showing('s1', 'el1', 'ad1')
      tracker.click('s1')
      await tracker.flush()
      expect(all()).toEqual([])
      const g = gate({ sending: false, declined: false })
      tracker.setConsent(g)
      await tracker.flush()
      expect(all()).toEqual([])
      g.sending = true
      await tracker.flush()
      expect(all().map((e) => e.level)).toEqual(['scene', 'click'])
    })

    it('a decline drops what was held and counts nothing more', async () => {
      const { tracker, all, tick, send } = setup()
      const g = gate({ sending: false, declined: false })
      tracker.setConsent(g)
      tick()
      tracker.showing('s1', 'el1', 'ad1')
      g.declined = true
      tracker.click('s1')
      tick()
      g.sending = true // even a gate that would send: a decline wins
      await tracker.flush()
      expect(all()).toEqual([])
      expect(send).not.toHaveBeenCalled()
    })

    it('with no notice (analytics off) ad views count as before', async () => {
      const { tracker, all, tick } = setup()
      tracker.hold()
      tracker.setConsent(null)
      tick()
      tracker.showing('s1', 'el1', 'ad1')
      await tracker.flush()
      expect(all().map((e) => e.level)).toEqual(['scene'])
    })
  })
})
