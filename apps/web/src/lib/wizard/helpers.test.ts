import { describe, it, expect } from 'vitest'
import { clampSide, hostingChoice, normalizeWorldName, plotLabel, storageLine, toWizardAsset } from './helpers'

const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1', name: 'Oak', isPublic: true, packId: 'nature', cdnUrl: 'https://cdn.example/oak.glb', triangleCount: 1200,
  fileSizeBytes: 2048, thumbnailUrl: null, dimensions: { width: 2, height: 5, depth: 3 }, ...over,
})

describe('toWizardAsset', () => {
  it('maps a catalog row, with width/height/depth as x/y/z', () => {
    expect(toWizardAsset(row())).toEqual({
      id: 'a1', name: 'Oak', thumbnailUrl: null, cdnUrl: 'https://cdn.example/oak.glb',
      dimensions: { x: 2, y: 5, z: 3 }, triangleCount: 1200, fileSizeBytes: 2048,
    })
  })

  it('leaves out what the wizard cannot place', () => {
    expect(toWizardAsset(row({ triangleCount: null }))).toBeNull()
    expect(toWizardAsset(row({ isPublic: false }))).toBeNull()
    expect(toWizardAsset(row({ packId: null }))).toBeNull()
    expect(toWizardAsset(row({ cdnUrl: null }))).toBeNull()
    expect(toWizardAsset(row({ dimensions: null }))?.dimensions).toBeNull()
  })
})

describe('copy helpers', () => {
  it('normalises typed World names', () => {
    expect(normalizeWorldName(' Cafe ')).toBe('cafe.dcl.eth')
    expect(normalizeWorldName('cafe.dcl.eth')).toBe('cafe.dcl.eth')
    expect(normalizeWorldName('Vitalik.ETH')).toBe('vitalik.eth')
    expect(normalizeWorldName('  ')).toBe('')
  })

  it('labels plots and storage', () => {
    expect(plotLabel({ width: 1, depth: 1 })).toBe('1×1 parcel')
    expect(plotLabel({ width: 2, depth: 3 })).toBe('2×3 parcels')
    expect(storageLine(3 * 1_048_576, { maxAllowedBytes: 100 * 1_048_576, usedBytes: 20 * 1_048_576 })).toBe(
      'This scene uses about 3.0 MB of your 80 MB left.',
    )
  })

  it('keeps custom sides between 1 and 10', () => {
    expect(clampSide(0)).toBe(1)
    expect(clampSide(12)).toBe(10)
    expect(clampSide(4.4)).toBe(4)
    expect(clampSide(NaN)).toBe(1)
  })
})

describe('hostingChoice', () => {
  const free = { used: 0, limit: 1, hostingAvailable: true }
  it('a trial needs an account, even when the slots say hosting is available', () => {
    expect(hostingChoice(true, free)).toBe('needs_account')
    expect(hostingChoice(true, null)).toBe('needs_account')
  })
  it('an account can host while it has a slot', () => {
    expect(hostingChoice(false, free)).toBe('available')
    expect(hostingChoice(false, { used: 5, limit: null, hostingAvailable: true })).toBe('available')
    expect(hostingChoice(false, { used: 1, limit: 1, hostingAvailable: true })).toBe('used_up')
    expect(hostingChoice(false, { used: 0, limit: 1, hostingAvailable: false })).toBe('unavailable')
    expect(hostingChoice(false, null)).toBe('loading')
  })
})
