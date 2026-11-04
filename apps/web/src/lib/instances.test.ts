import { describe, expect, it } from 'vitest'
import { deleteAllInstancesPrompt, deleteElementPrompt, withoutElement, withoutInstancesOf } from './instances'

describe('deleteAllInstancesPrompt', () => {
  it('says how many instances will be removed and that the element stays', () => {
    expect(deleteAllInstancesPrompt(3)).toBe("Delete all 3 instances? The element stays. This can't be undone.")
    expect(deleteAllInstancesPrompt(1)).toBe("Delete 1 instance? The element stays. This can't be undone.")
  })
})

describe('withoutInstancesOf', () => {
  const scene = {
    name: 'S',
    presets: [
      { id: 'p1', elements: [
        { id: 'a', name: 'A', instances: [{ id: 'a1' }, { id: 'a2' }] },
        { id: 'b', name: 'B', instances: [{ id: 'b1' }] },
      ] },
      { id: 'p2', elements: [{ id: 'c', name: 'C', instances: [{ id: 'c1' }] }] },
    ],
  }
  it("empties one element's instances and keeps the element and everything else", () => {
    const next = withoutInstancesOf(scene, 'a')!
    expect(next.presets[0].elements.map((e) => [e.id, e.instances.map((i) => i.id)])).toEqual([['a', []], ['b', ['b1']]])
    expect(next.presets[1].elements[0].instances).toEqual([{ id: 'c1' }])
    expect(next.name).toBe('S')
    expect(scene.presets[0].elements[0].instances).toHaveLength(2) // not mutated
  })
  it('passes a scene that has not loaded through', () => {
    expect(withoutInstancesOf(null, 'a')).toBeNull()
  })
})

describe('deleteElementPrompt', () => {
  it('names the element and says its instances go with it', () => {
    expect(deleteElementPrompt('Image 1', 0)).toBe("Delete Image 1? This can't be undone.")
    expect(deleteElementPrompt('Lobby screen', 1)).toBe("Delete Lobby screen and its 1 instance? This can't be undone.")
    expect(deleteElementPrompt('Chair', 4)).toBe("Delete Chair and its 4 instances? This can't be undone.")
  })
})

describe('withoutElement', () => {
  const scene = {
    name: 'S',
    presets: [
      { id: 'p1', elements: [{ id: 'a', instances: [] }, { id: 'b', instances: [] }] },
      { id: 'p2', elements: [{ id: 'c', instances: [] }] },
    ],
  }
  it('drops one element from whichever preset holds it and keeps the rest', () => {
    const next = withoutElement(scene, 'a')!
    expect(next.presets.map((p) => p.elements.map((e) => e.id))).toEqual([['b'], ['c']])
    expect(next.name).toBe('S')
    expect(scene.presets[0].elements).toHaveLength(2) // not mutated
  })
  it('passes a scene that has not loaded through', () => {
    expect(withoutElement(null, 'a')).toBeNull()
  })
})
