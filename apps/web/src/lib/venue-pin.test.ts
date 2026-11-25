import { describe, expect, it } from 'vitest'
import { addressComplete, clampRadius, pinBody, shouldAutoSuggest, arcAvailable, ARC_PRINT_COPY, PIN_COPY, ARC_STYLES, OSM_ATTRIBUTION } from './venue-pin'

const loc = (over: object = {}) => ({ venue: '', address: '', city: '', country: '', pin: null, ...over })

describe('addressComplete', () => {
  it('needs a country plus a street or a city', () => {
    expect(addressComplete({ country: 'FR', city: 'Paris' })).toBe(true)
    expect(addressComplete({ country: 'FR', address: '1 Rue X' })).toBe(true)
    expect(addressComplete({ country: 'FR' })).toBe(false)
    expect(addressComplete({ city: 'Paris' })).toBe(false)
    expect(addressComplete({ country: '  ', city: 'Paris' })).toBe(false)
  })
})

describe('shouldAutoSuggest', () => {
  const before = loc({ country: 'FR' })
  const after = loc({ country: 'FR', city: 'Paris' })
  it('is true once, when the address first becomes complete with no pin', () => {
    expect(shouldAutoSuggest(before, after, false)).toBe(true)
  })
  it('is false when a suggestion already ran', () => { expect(shouldAutoSuggest(before, after, true)).toBe(false) })
  it('is false when a pin exists, so a placed or dragged pin is never replaced', () => {
    expect(shouldAutoSuggest(before, { ...after, pin: { lat: 1, lng: 2 } }, false)).toBe(false)
  })
  it('is false when it was already complete, or is still incomplete', () => {
    expect(shouldAutoSuggest(after, { ...after, city: 'Lyon' }, false)).toBe(false)
    expect(shouldAutoSuggest(loc(), before, false)).toBe(false)
  })
})

describe('radius and body', () => {
  it('clamps to 50-1000 and rounds; blank or junk is the 150 default', () => {
    expect(clampRadius(10)).toBe(50)
    expect(clampRadius(5000)).toBe(1000)
    expect(clampRadius(149.6)).toBe(150)
    expect(clampRadius(Number.NaN)).toBe(150)
  })
  it('sends the pin with its radius, or nothing', () => {
    expect(pinBody({ lat: 1, lng: 2 }, 300)).toEqual({ lat: 1, lng: 2, radiusM: 300 })
    expect(pinBody(null, 300)).toBeNull()
  })
  it('brings a longitude from a map panned past the date line back into -180..180', () => {
    expect(pinBody({ lat: 1, lng: 190 }, 150)?.lng).toBe(-170)
    expect(pinBody({ lat: 1, lng: -190 }, 150)?.lng).toBe(170)
    expect(pinBody({ lat: 1, lng: 540 }, 150)?.lng).toBe(-180)
    expect(pinBody({ lat: 1, lng: 2 }, 150)?.lng).toBe(2)
  })
  it('uses the exact copy', () => {
    expect(PIN_COPY.suggested).toBe("Suggested from the address. Drag it to the entrance if it's off.")
    expect(PIN_COPY.optional).toBe('The pin is optional. With no pin, anyone who has the ARC can check in from anywhere.')
    expect(OSM_ATTRIBUTION).toBe('&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors')
    expect(PIN_COPY.failed).toBe("Couldn't find that address on the map. Drop the pin yourself.")
    expect(ARC_STYLES).toEqual([{ value: 'normal', label: 'Black on white' }, { value: 'inverted', label: 'White on black' }])
  })
})

describe('the event ARC', () => {
  it('is for in-person BEATs that are paid, live or ended', () => {
    for (const status of ['paid', 'live', 'ended'] as const) expect(arcAvailable({ status, location: { type: 'in_person' } })).toBe(true)
    expect(arcAvailable({ status: 'draft', location: { type: 'in_person' } })).toBe(false)
    expect(arcAvailable({ status: 'cancelled', location: { type: 'in_person' } })).toBe(false)
    expect(arcAvailable({ status: 'live', location: { type: 'online' } })).toBe(false)
  })
  it('has the exact print copy', () => {
    expect(ARC_PRINT_COPY('Hall 7')).toBe('Print this ARC and put it up at Hall 7. Visitors scan it with the Virvi app to earn this BEAT.')
  })
})
