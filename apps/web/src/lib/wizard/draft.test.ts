import { afterEach, describe, expect, it, vi } from 'vitest'
import { adoptDraft, adoptDraftOnSignIn, clearDraft, DRAFT_KEY, loadDraft, saveDraft } from './draft'
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
const T = 'trial-1'
const NOW = 1_800_000_000_000
const state = wizardReducer(wizardReducer(initialState, { type: 'setName', name: 'Ramen Bar' }), { type: 'setDclLater', on: true })

afterEach(() => { vi.unstubAllGlobals() })

describe('wizard drafts', () => {
  it('loadDraft returns the saved state', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    saveDraft(state, NOW, T)
    expect(s.map.has(DRAFT_KEY)).toBe(true)
    expect(DRAFT_KEY).toBe('virvi.wizard.draft')
    expect(loadDraft(NOW + DAY, T)).toEqual(state)
  })
  it('returns null when there is none, or it is unparsable', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    expect(loadDraft(NOW, T)).toBeNull()
    s.setItem(DRAFT_KEY, '{nope')
    expect(loadDraft(NOW, T)).toBeNull()
    s.setItem(DRAFT_KEY, JSON.stringify({ v: 1, at: NOW }))
    expect(loadDraft(NOW, T)).toBeNull()
  })
  it('drops a 15-day-old draft', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, T)
    expect(loadDraft(NOW + 13 * DAY, T)).toEqual(state)
    expect(loadDraft(NOW + 15 * DAY, T)).toBeNull()
  })
  it('drops another version', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    saveDraft(state, NOW, T)
    const saved = JSON.parse(s.getItem(DRAFT_KEY)!)
    s.setItem(DRAFT_KEY, JSON.stringify({ ...saved, v: saved.v + 1 }))
    expect(loadDraft(NOW, T)).toBeNull()
  })
  it('clearDraft removes it', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, T)
    clearDraft()
    expect(loadDraft(NOW, T)).toBeNull()
  })
  it('survives storage that throws', () => {
    const boom = () => { throw new Error('blocked') }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom })
    expect(() => saveDraft(state, NOW, T)).not.toThrow()
    expect(loadDraft(NOW, T)).toBeNull()
    expect(() => clearDraft()).not.toThrow()
  })
  it('survives no storage at all', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => saveDraft(state, NOW, T)).not.toThrow()
    expect(loadDraft(NOW, T)).toBeNull()
    expect(() => clearDraft()).not.toThrow()
  })
})

describe('draft owner', () => {
  it('loads for its owner', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, T)
    expect(loadDraft(NOW, T)).toEqual(state)
  })
  it('another user ignores it, and it is cleared', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    saveDraft(state, NOW, T)
    expect(loadDraft(NOW, 'acct-9')).toBeNull()
    expect(s.map.has(DRAFT_KEY)).toBe(false)
  })
  it('a draft without an owner is dropped', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    s.setItem(DRAFT_KEY, JSON.stringify({ v: 2, at: NOW, state }))
    expect(loadDraft(NOW, T)).toBeNull()
  })
  it('an unconverted trial, then another account signs in: not shown', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, T)
    // Plain sign-in, no trial carried along: nothing is adopted
    adoptDraftOnSignIn({ id: T, trial: true }, { id: 'acct-9' }, false)
    expect(loadDraft(NOW, 'acct-9')).toBeNull()
  })
  it('a trial converted in place (same id) keeps its draft', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, T)
    adoptDraftOnSignIn({ id: T, trial: true }, { id: T }, true)
    expect(loadDraft(NOW, T)).toEqual(state)
  })
  it('a trial merged into an existing account (new id) hands its draft over', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, T)
    adoptDraftOnSignIn({ id: T, trial: true }, { id: 'acct-9' }, true)
    expect(loadDraft(NOW, 'acct-9')).toEqual(state)
    expect(loadDraft(NOW, T)).toBeNull()
  })
  it('adoptDraft moves only the named owner\'s draft', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, 'trial-2')
    adoptDraft(T, 'acct-9')
    expect(loadDraft(NOW, 'trial-2')).toEqual(state)
  })
  it('a sign-in that was not from a trial adopts nothing', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, T)
    adoptDraftOnSignIn({ id: 'acct-1' }, { id: 'acct-9' }, true)
    adoptDraftOnSignIn(null, { id: 'acct-9' }, true)
    expect(loadDraft(NOW, 'acct-9')).toBeNull()
  })
  it('saving again keeps the creation time: the 14 days do not slide', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, T)
    saveDraft(state, NOW + 10 * DAY, T)
    expect(loadDraft(NOW + 15 * DAY, T)).toBeNull()
  })
  it("never overwrites another owner's draft (a late save from the trial after it was handed to the account)", () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, T)
    adoptDraft(T, 'acct-9')
    saveDraft({ ...state, name: 'stale' }, NOW, T)
    expect(loadDraft(NOW, 'acct-9')).toEqual(state)
  })
  it('a new owner starts fresh once the old draft is gone', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveDraft(state, NOW, 'trial-2')
    expect(loadDraft(NOW + 10 * DAY, T)).toBeNull()
    saveDraft(state, NOW + 10 * DAY, T)
    expect(loadDraft(NOW + 15 * DAY, T)).toEqual(state)
  })
})
