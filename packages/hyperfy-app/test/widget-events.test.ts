import { describe, it, expect } from 'vitest'
import { widgetEvents } from '../src/widget-events.js'

/** LIV-158: the Virvi app tells the world's other apps about widgets. */
const w = (sk: string, over: Record<string, unknown> = {}) => ({ sk, name: sk, enabled: true, controlType: 1, value: false, ...over })

describe('widgetEvents', () => {
  it('sends every widget first, then only changes, clicks for Triggers, and removals', () => {
    const first = widgetEvents(null, { widgets: [w('lights'), w('fire', { controlType: 5, value: 0 }), w('film', { controlType: 3, options: ['A', 'B'], value: 'A', customId: 'picker' })] })
    expect(first.changes.map((e) => e.id)).toEqual(['lights', 'fire', 'film'])
    expect(first.changes[2]).toMatchObject({ customId: 'picker', options: ['A', 'B'], value: 'A' })
    expect(first.clicks).toEqual([])

    const second = widgetEvents(first.next, { widgets: [w('lights', { value: true }), w('fire', { controlType: 5, value: 1 })] })
    expect(second.changes.map((e) => [e.id, e.value, e.removed ?? false])).toEqual([['lights', true, false], ['fire', 1, false], ['film', null, true]])
    expect(second.clicks.map((e) => e.id)).toEqual(['fire'])

    expect(widgetEvents(second.next, { widgets: [w('lights', { value: true }), w('fire', { controlType: 5, value: 1 })] }).changes).toEqual([])
  })

  it('skips hidden widgets and ones with no control', () => {
    expect(widgetEvents(null, { widgets: [w('a', { enabled: false }), w('b', { controlType: 0 })] }).changes).toEqual([])
    expect(widgetEvents(null, null).changes).toEqual([])
  })
})
