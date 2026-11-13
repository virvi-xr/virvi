import { describe, it, expect } from 'vitest'
import { checkInDelta, isPresent } from '../src/presence/attendance.js'

const T0 = new Date('2026-11-13T12:00:00Z')
const after = (ms: number) => new Date(T0.getTime() + ms)

describe('checkInDelta', () => {
  it('refuses a check-in 10 seconds after the last', () => {
    expect(checkInDelta(T0, after(10_000))).toEqual({ accepted: false, addSeconds: 0 })
  })
  it('adds the gap for a check-in 30 seconds after', () => {
    expect(checkInDelta(T0, after(30_000))).toEqual({ accepted: true, addSeconds: 30 })
  })
  it('caps the gap at 45 seconds', () => {
    expect(checkInDelta(T0, after(10 * 60_000))).toEqual({ accepted: true, addSeconds: 45 })
  })
  it('accepts the first check-in and adds nothing', () => {
    expect(checkInDelta(null, T0)).toEqual({ accepted: true, addSeconds: 0 })
  })
})

describe('isPresent', () => {
  const row = { lastSeenAt: T0, secondsPresent: 300 }
  it('is true when seen within the window and past the minimum', () => {
    expect(isPresent(row, after(59_000), 300)).toBe(true)
  })
  it('is false when last seen 61 seconds ago', () => {
    expect(isPresent(row, after(61_000), 300)).toBe(false)
  })
  it('is false under the minimum', () => {
    expect(isPresent({ lastSeenAt: T0, secondsPresent: 299 }, after(1_000), 300)).toBe(false)
  })
  it('is false when never seen', () => {
    expect(isPresent({ lastSeenAt: null, secondsPresent: 999 }, T0, 300)).toBe(false)
  })
})
