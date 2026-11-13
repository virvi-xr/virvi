import { describe, it, expect } from 'vitest'
import { WHEEL_MAX_NAMES } from '@virvixr/shared'
import { POINTER_ANGLE, angleAt, drumRows, sliceAtPointer, sliceCentre, spinPlan, wheelSlices, winnerSlice } from '../src/raffle/wheel.js'

const mod360 = (a: number) => ((a % 360) + 360) % 360

describe('spinPlan', () => {
  it("ends with the winner's slice centred under the pointer", () => {
    const plan = spinPlan(10, 3, 8000)
    const last = plan.at(-1)!
    expect(last.atMs).toBe(8000)
    expect(mod360(sliceCentre(3, 10) + last.angle)).toBeCloseTo(POINTER_ANGLE, 6)
    expect(sliceAtPointer(last.angle, 10)).toBe(3)
  })

  it('starts at rest, turns several times and only slows down', () => {
    const plan = spinPlan(10, 3, 8000)
    expect(plan[0]).toEqual({ atMs: 0, angle: 0 })
    expect(plan.at(-1)!.angle).toBeGreaterThan(3 * 360)
    const steps = plan.slice(1).map((k, i) => k.angle - plan[i].angle)
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThanOrEqual(steps[i - 1] + 1e-9)
  })

  it('angleAt interpolates and holds the last angle after the end', () => {
    const plan = spinPlan(7, 0, 1000)
    expect(angleAt(plan, -5)).toBe(0)
    expect(angleAt(plan, 5000)).toBe(plan.at(-1)!.angle)
    const mid = angleAt(plan, 500)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(plan.at(-1)!.angle)
  })
})

describe('wheelSlices', () => {
  it('caps the names at the wheel size and labels the rest "+N more"', () => {
    const names = Array.from({ length: 70 }, (_, i) => `n${i}`)
    const slices = wheelSlices(names, 10)
    expect(slices.filter((s) => !s.more)).toHaveLength(WHEEL_MAX_NAMES)
    expect(WHEEL_MAX_NAMES).toBe(60)
    // The 10 names that didn't fit join the 10 the server left out
    expect(slices.at(-1)).toEqual({ label: '+20 more', more: true })
    expect(slices).toHaveLength(61)
  })

  it('reads "+N more" as the last slice from the server count', () => {
    const slices = wheelSlices(['a', 'b'], 10)
    expect(slices.map((s) => s.label)).toEqual(['a', 'b', '+10 more'])
  })

  it('has no more slice when every name fits', () => {
    expect(wheelSlices(['a', 'b'], 0)).toEqual([{ label: 'a', more: false }, { label: 'b', more: false }])
  })

  it('finds the winner among the name slices', () => {
    const slices = wheelSlices(['a', 'b', 'c'], 4)
    expect(winnerSlice(slices, 'c')).toBe(2)
    expect(winnerSlice(slices, 'zz')).toBe(0)
  })
})

describe('drumRows', () => {
  it('puts the slice under the pointer at offset 0 once landed', () => {
    const plan = spinPlan(10, 3, 8000)
    const rows = drumRows(plan.at(-1)!.angle, 10, 2)
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 5])
    expect(rows.find((r) => r.index === 3)!.offset).toBeCloseTo(0, 6)
  })
})
