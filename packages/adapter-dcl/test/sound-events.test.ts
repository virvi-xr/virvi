import { describe, it, expect } from 'vitest'
import { soundTransitions } from '../src/sound-events'

describe('sound plays for analytics (LIV-38)', () => {
  it('reports a start and a stop once each, and nothing while a sound keeps playing', () => {
    const prev = new Map<number, boolean>()
    expect(soundTransitions(prev, [[1, false], [2, true]])).toEqual([{ key: 2, state: 'play' }])
    expect(soundTransitions(prev, [[1, false], [2, true]])).toEqual([])
    expect(soundTransitions(prev, [[1, true], [2, false]])).toEqual([{ key: 1, state: 'play' }, { key: 2, state: 'stop' }])
  })

  it('forgets a sound that is gone, so it plays afresh if it comes back', () => {
    const prev = new Map<number, boolean>([[7, true]])
    expect(soundTransitions(prev, [])).toEqual([])
    expect(prev.size).toBe(0)
    expect(soundTransitions(prev, [[7, true]])).toEqual([{ key: 7, state: 'play' }])
  })
})
