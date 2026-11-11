import { describe, it, expect } from 'vitest'
import { PLACEMENTS_FILE, decodePlacements, encodePlacements, type Placement } from '@virvixr/shared'

const at = (i: string, over: Partial<Placement> = {}): Placement => ({
  instanceId: i, elementId: 'e1', src: 'models/virvi/Chair.glb',
  position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, collisions: false, ...over,
})

describe('the deployed placements snapshot (LIV-134)', () => {
  it('lives at virvi/placements.json', () => {
    expect(PLACEMENTS_FILE).toBe('virvi/placements.json')
  })

  it('round-trips, grouping copies under their model and leaving out default rotation and scale', () => {
    const list = [
      at('i1'),
      at('i2', { rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 }, collisions: true }),
      at('i3', { elementId: 'e2', src: 'models/virvi/Table.glb', position: { x: 0, y: 0, z: 0 } }),
    ]
    const text = encodePlacements(list)
    expect(JSON.parse(text)).toEqual({
      v: 1,
      models: [
        { e: 'e1', src: 'models/virvi/Chair.glb', at: [{ i: 'i1', p: [1, 0, 2] }, { i: 'i2', p: [1, 0, 2], r: [0, 90, 0], s: [2, 2, 2], c: 1 }] },
        { e: 'e2', src: 'models/virvi/Table.glb', at: [{ i: 'i3' }] },
      ],
    })
    expect(decodePlacements(text)).toEqual(list)
  })

  it('reads nothing from a file that is not a v1 snapshot, and skips copies it cannot place', () => {
    for (const bad of ['', 'not json', 'null', '[]', '{"v":2,"models":[]}', '{"v":1}']) expect(decodePlacements(bad)).toEqual([])
    const text = JSON.stringify({
      v: 1,
      models: [
        { e: 'e1', src: 'models/virvi/a.glb', at: [{ i: 'ok', p: [1, 2, 3] }, { p: [1, 2, 3] }, { i: 'badp', p: [1, 'x', 3] }, { i: 'short', s: [1, 1] }] },
        { e: 'e2', at: [{ i: 'nosrc' }] },
        { e: 'e3', src: 'https://cdn.example/x.glb', at: [{ i: 'url' }] },
        'junk',
      ],
    })
    expect(decodePlacements(text).map((p) => p.instanceId)).toEqual(['ok'])
  })
})
