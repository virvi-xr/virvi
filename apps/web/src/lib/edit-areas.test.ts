import { describe, expect, it } from 'vitest'
import { areaFields, areaFromFields, areaLine, blankArea, tenantNote } from './edit-areas'

describe('tenant areas (LIV-32)', () => {
  it('turns the four fields into an area, or says why not', () => {
    expect(areaFromFields({ minX: '0', maxX: '16', minZ: '-8', maxZ: '8' })).toEqual({ ok: true, value: { minX: 0, maxX: 16, minZ: -8, maxZ: 8 } })
    expect(areaFromFields(blankArea())).toEqual({ ok: false, error: 'An area needs minX, maxX, minZ and maxZ in metres.' })
    expect(areaFromFields({ minX: '16', maxX: '0', minZ: '0', maxZ: '1' })).toEqual({ ok: false, error: 'Each minimum must be smaller than its maximum.' })
    expect(areaFields({ minX: 0, maxX: 16.5, minZ: 0, maxZ: 8 })).toEqual({ minX: '0', maxX: '16.5', minZ: '0', maxZ: '8' })
  })
  it('reads the area in the Roles list and on the scene page', () => {
    expect(areaLine({ minX: 0, maxX: 16, minZ: 0, maxZ: 16 })).toBe('Only inside x 0 to 16, z 0 to 16')
    expect(tenantNote([{ minX: 0, maxX: 16, minZ: 0, maxZ: 16 }])).toMatch(/^You can add, move and remove items inside your area \(x 0 to 16, z 0 to 16\)\./)
    expect(tenantNote([])).toMatch(/no longer valid/)
  })
})
