import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearDraft, DRAFT_KEY, loadDraft, saveDraft } from './draft'
import { initialState, wizardReducer } from './state'

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
    removeItem: (k: string) => { m.delete(k) },
    map: m,
  }
}

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const state = wizardReducer(wizardReducer(initialState, { type: 'setName', name: 'Ramen Bar' }), { type: 'setDclLater', on: true })

afterEach(() => { vi.unstubAllGlobals() })

describe('wizard drafts', () => {
  it('loadDraft returns the saved state', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    saveDraft(state, NOW)
    expect(s.map.has(DRAFT_KEY)).toBe(true)
    expect(DRAFT_KEY).toBe('virvi.wizard.draft')
    expect(loadDraft(NOW + DAY)).toEqual(state)
  })
  it('returns null when there is none, or it is unparsable', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    expect(loadDraft(NOW)).toBeNull()
    s.setItem(DRAFT_KEY, '{nope')
    expect(loadDraft(NOW)).toBeNull()
    s.setItem(DRAFT_KEY, JSON.stringify({ v: 1, at: NOW }))
    expect(loadDraft(NOW)).toBeNull()
  })
  it('drops a 15-day-old draft', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW)
    expect(loadDraft(NOW + 13 * DAY)).toEqual(state)
    expect(loadDraft(NOW + 15 * DAY)).toBeNull()
  })
  it('drops another version', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    saveDraft(state, NOW)
    const saved = JSON.parse(s.getItem(DRAFT_KEY)!)
    s.setItem(DRAFT_KEY, JSON.stringify({ ...saved, v: saved.v + 1 }))
    expect(loadDraft(NOW)).toBeNull()
  })
  it('clearDraft removes it', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW)
    clearDraft()
    expect(loadDraft(NOW)).toBeNull()
  })
  it('survives storage that throws', () => {
    const boom = () => { throw new Error('blocked') }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom })
    expect(() => saveDraft(state, NOW)).not.toThrow()
    expect(loadDraft(NOW)).toBeNull()
    expect(() => clearDraft()).not.toThrow()
  })
  it('survives no storage at all', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => saveDraft(state, NOW)).not.toThrow()
    expect(loadDraft(NOW)).toBeNull()
    expect(() => clearDraft()).not.toThrow()
  })
})
