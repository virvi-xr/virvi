import { describe, it, expect } from 'vitest'
import { REPORT_REASONS } from './asset-sharing'
import { canReport, canManage, shareErrorMessage, sharedNote } from './asset-sharing'

describe('sharing a model (LIV-20)', () => {
  it('only the owner manages a model, and never a catalog one', () => {
    expect(canManage({ mine: true, packId: null })).toBe(true)
    expect(canManage({ mine: false, packId: null })).toBe(false)
    expect(canManage({ mine: true, packId: 'p' })).toBe(false)
  })

  it('anyone else can report a shared model; not their own, a private one or the catalog', () => {
    expect(canReport({ mine: false, isPublic: true, packId: null })).toBe(true)
    expect(canReport({ mine: true, isPublic: true, packId: null })).toBe(false)
    expect(canReport({ mine: false, isPublic: false, packId: null })).toBe(false)
    expect(canReport({ mine: false, isPublic: true, packId: 'p' })).toBe(false)
  })

  it('says what a shared model allows, under its license', () => {
    expect(sharedNote({ isPublic: true, license: 'cc-by-4.0' })).toMatch(/credit/)
    expect(sharedNote({ isPublic: true, license: 'proprietary' })).toBeNull()
    expect(sharedNote({ isPublic: false, license: 'cc-by-4.0' })).toBeNull()
  })

  it('turns refusals into what to do next', () => {
    expect(shareErrorMessage({ body: { error: 'rights_not_confirmed' } })).toMatch(/right to share/)
    expect(shareErrorMessage({ body: { error: 'taken_down', message: 'Virvi took it down' } })).toBe('Virvi took it down')
    expect(shareErrorMessage({ message: 'Network down' })).toBe('Network down')
    expect(shareErrorMessage(null)).toBe('That didn’t work. Try again.')
  })

  it('every report reason has a label', () => {
    expect(REPORT_REASONS.map(([k]) => k)).toEqual(['copyright', 'offensive', 'private_info', 'broken', 'spam', 'other'])
  })
})
