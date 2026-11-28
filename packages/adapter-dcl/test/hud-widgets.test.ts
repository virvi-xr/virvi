import { describe, it, expect } from 'vitest'
import { WidgetControlType as T } from '@virvixr/shared'
import { parseDatetime, sliderValue, widgetRows, widgetValueLabel, withWidgetValue } from '../src/widgets.js'

describe('HUD widgets panel (LIV-158)', () => {
  it('lists controls by name, without None or hidden ones', () => {
    const rows = widgetRows([
      { id: 'b', name: 'Lights', type: T.TOGGLE, value: true },
      { id: 'a', name: 'Doors open', type: T.DATETIME, value: '' },
      { id: 'c', name: 'Nothing', type: T.NONE, value: null },
      { id: 'd', name: 'Off', type: T.SLIDER, value: 3, enabled: false },
    ])
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('shows each type the way the dashboard does', () => {
    expect(widgetValueLabel({ type: T.TOGGLE, value: false })).toBe('Off')
    expect(widgetValueLabel({ type: T.SLIDER, value: undefined })).toBe('50')
    expect(widgetValueLabel({ type: T.SLIDER, value: 140 })).toBe('100')
    expect(widgetValueLabel({ type: T.TEXT, value: '' })).toBe('(empty)')
    expect(widgetValueLabel({ type: T.DATETIME, value: '2026-11-28T20:00' })).toBe('2026-11-28 20:00')
    expect(widgetValueLabel({ type: T.TRIGGER, value: 1764000000000 })).toBe('Pressed before')
    expect(widgetValueLabel({ type: T.SELECTOR, value: 'a, b' })).toBe('Nothing chosen') // an old selector: its value was its options
    expect(widgetValueLabel({ type: T.SELECTOR, value: 'b', options: ['a', 'b'] })).toBe('Chosen: b')
    expect(widgetValueLabel({ type: T.SELECTOR, value: '', options: [] })).toBe('No options yet: add them on the dashboard')
    expect(sliderValue('x')).toBe(50)
  })

  it('takes a date and time as the dashboard stores it', () => {
    expect(parseDatetime('2026-11-28 20:00')).toBe('2026-11-28T20:00')
    expect(parseDatetime(' 2026-11-28T09:05 ')).toBe('2026-11-28T09:05')
    expect(parseDatetime('2026-13-28 20:00')).toBeNull()
    expect(parseDatetime('tomorrow')).toBeNull()
  })

  it('keeps the other properties when the value changes', () => {
    expect(withWidgetValue({ controlType: 1, value: false, order: 2 }, true)).toEqual({ controlType: 1, value: true, order: 2 })
    // An old selector moves its comma list into options when a choice is made
    expect(withWidgetValue({ controlType: 3, value: 'Film 1, Film 2' }, 'Film 2')).toEqual({ controlType: 3, options: ['Film 1', 'Film 2'], value: 'Film 2' })
  })
})
