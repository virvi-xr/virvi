import { describe, it, expect } from 'vitest'
import { barLabel, topWithOther } from './breakdown'

describe('topWithOther', () => {
  it('sorts descending, keeps the top n and sums the rest as Other', () => {
    const counts = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i + 1]))
    const out = topWithOther(counts, 8)
    expect(out).toHaveLength(9)
    expect(out[0]).toEqual({ key: 'k9', value: 10 })
    expect(out.at(-1)).toEqual({ key: 'Other', value: 1 + 2 })
  })
  it('no Other row when everything fits; empty input → empty list; zero counts dropped', () => {
    expect(topWithOther({ a: 2, b: 1 })).toEqual([{ key: 'a', value: 2 }, { key: 'b', value: 1 }])
    expect(topWithOther({})).toEqual([])
    expect(topWithOther({ a: 0, b: 3 })).toEqual([{ key: 'b', value: 3 }])
  })
})

describe('barLabel', () => {
  it('uses the server label for a key, else the key itself', () => {
    const labels = { 'urn:decentraland:matic:collections-v2:0xab:0': 'Cool Dance' }
    expect(barLabel('urn:decentraland:matic:collections-v2:0xab:0', labels)).toBe('Cool Dance')
    expect(barLabel('Other', labels)).toBe('Other')
    expect(barLabel('wave', undefined)).toBe('wave')
  })
})
