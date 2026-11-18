import { describe, it, expect } from 'vitest'
import { readLogRanges, smallerRange } from '../src/services/log-ranges.js'

const capped = (max: number, calls: [number, number][]) => async (a: number, b: number) => {
  calls.push([a, b])
  if (b - a + 1 > max) throw new Error(`eth_getLogs requests with up to a ${max} block range`)
  return [a]
}

describe('readLogRanges', () => {
  it('reads the whole range in one call when the provider allows it', async () => {
    const calls: [number, number][] = []
    expect(await readLogRanges(10, 109, 5000, capped(10_000, calls))).toEqual({ items: [10], lastBlock: 109 })
    expect(calls).toEqual([[10, 109]])
  })

  it('shrinks to the next smaller range when refused and keeps that size', async () => {
    const calls: [number, number][] = []
    const r = await readLogRanges(1, 250, 5000, capped(100, calls))
    expect(r.lastBlock).toBe(250)
    expect(r.items).toEqual([1, 101, 201])
    // 5000 and 500 refused once each, then 100 for every chunk
    expect(calls).toEqual([[1, 250], [1, 250], [1, 100], [101, 200], [201, 250]])
  })

  it('stops after maxChunks and reports how far it got', async () => {
    const r = await readLogRanges(1, 1000, 10, capped(10, []), 3)
    expect(r.lastBlock).toBe(30)
  })

  it('throws any other error, and a refusal below the smallest range', async () => {
    await expect(readLogRanges(1, 50, 5000, async () => { throw new Error('server unreachable') })).rejects.toThrow('server unreachable')
    await expect(readLogRanges(1, 50, 5000, capped(5, []))).rejects.toThrow(/up to a 5 block range/)
    expect(smallerRange(10)).toBeNull()
  })
})
