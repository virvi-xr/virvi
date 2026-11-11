import { describe, it, expect } from 'vitest'
import { HEATMAP_BAND_M, feetHeight, heightBand, bandRangeM } from '@virvixr/shared'

describe('heatmap height bands', () => {
  it('bands are 2 m', () => {
    expect(HEATMAP_BAND_M).toBe(2)
  })

  it('Decentraland reports the avatar about 0.9 m above its feet: ground is band 0, a 3 m floor band 1', () => {
    expect(feetHeight(0.88, 'parcels')).toBeCloseTo(-0.02)
    expect(heightBand(0.88, 'parcels')).toBe(0)
    expect(heightBand(0.9, 'world')).toBe(0)
    expect(heightBand(0.9 + 1.5, 'parcels')).toBe(0) // a jump stays on the ground floor
    expect(heightBand(3.9, 'parcels')).toBe(1)
    expect(heightBand(6.9, 'preview')).toBe(3)
    expect(heightBand(0, 'parcels')).toBe(0) // nothing is below the ground in Decentraland
    expect(heightBand(-5, 'world')).toBe(0)
  })

  it('Hyperfy reports the feet: ground is band 0, a 3 m floor band 1', () => {
    expect(feetHeight(0, 'hyperfy')).toBe(0)
    expect(heightBand(0, 'hyperfy')).toBe(0)
    expect(heightBand(-0.3, 'hyperfy')).toBe(0)
    expect(heightBand(3, 'hyperfy')).toBe(1)
    expect(heightBand(-3, 'hyperfy')).toBe(-2)
  })

  it('AR reports the head: standing and seated visitors are both band 0', () => {
    expect(heightBand(1.75, 'ar')).toBe(0)
    expect(heightBand(1.1, 'ar')).toBe(0)
    expect(heightBand(4.6, 'ar')).toBe(1)
  })

  it('a band covers 2 m of feet height, starting 0.4 m below its nominal floor', () => {
    expect(bandRangeM(0)).toEqual({ from: -0.4, to: 1.6 })
    expect(bandRangeM(1)).toEqual({ from: 1.6, to: 3.6 })
  })
})
