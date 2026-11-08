import { describe, it, expect } from 'vitest'
import { toLayoutItem, clearCopiesPrompt, clearedMessage, withCopies } from '../src/layout.js'

describe('toLayoutItem', () => {
  it('counts the element’s copies from its instances', () => {
    const el = { id: 'e1', name: 'Poster', type: 'image', enabled: true, instances: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    expect(toLayoutItem(el)).toEqual({ id: 'e1', name: 'Poster', type: 'image', enabled: true, copies: 3, click: null, frame: null })
  })

  it('keeps the previous count when the response has no instances (an element update returns the row only)', () => {
    const before = toLayoutItem({ id: 'e1', name: 'Poster', type: 'image', instances: [{ id: 'a' }, { id: 'b' }] })
    expect(toLayoutItem({ id: 'e1', name: 'Poster', type: 'image', enabled: false }, before)).toMatchObject({ enabled: false, copies: 2 })
    expect(toLayoutItem({ id: 'e2', name: 'New', type: 'model' })).toMatchObject({ enabled: true, copies: 0 })
  })
})

describe('withCopies', () => {
  it('sets one element’s count and leaves the others', () => {
    const list = [toLayoutItem({ id: 'e1', name: 'A', type: 'image', instances: [{}, {}] }), toLayoutItem({ id: 'e2', name: 'B', type: 'model', instances: [{}] })]
    expect(withCopies(list, 'e1', 0).map((el) => el.copies)).toEqual([0, 1])
  })
})

describe('messages', () => {
  it('ask before removing every copy, and say the element stays', () => {
    expect(clearCopiesPrompt({ name: 'Poster', copies: 3 })).toBe("Remove all 3 copies of Poster? The element stays. This can't be undone.")
    expect(clearCopiesPrompt({ name: '', copies: 1 })).toBe("Remove the only copy of Unnamed? The element stays. This can't be undone.")
  })

  it('report how many went', () => {
    expect(clearedMessage('Poster', 3)).toBe('Removed 3 copies of Poster')
    expect(clearedMessage('Poster', 1)).toBe('Removed 1 copy of Poster')
    expect(clearedMessage('Poster', 0)).toBe('Poster had no copies left')
  })
})
