import { describe, expect, it } from 'vitest'
import type { WizardAsset } from '../api'
import { canAdvance, initialState, stateBudget, wizardReducer, type WizardState } from './state'

const asset = (id: string, tris = 100, dim = 1): WizardAsset => ({
  id, name: id, thumbnailUrl: null, cdnUrl: null, dimensions: { x: dim, y: 1, z: dim }, triangleCount: tris, fileSizeBytes: 10,
})
const dcl = { world: 'a.dcl.eth', wallet: '0x1', hasScene: false, footprint: null }
const withPlot = (over: Partial<WizardState> = {}): WizardState =>
  wizardReducer(
    { ...wizardReducer(initialState, { type: 'setDcl', dcl }), ...over },
    { type: 'setPlot', plot: { width: 1, depth: 1, base: { x: 0, y: 0 } } },
  )

describe('applyTheme', () => {
  it('keeps every item however many triangles (12 x 1,500 tris on 1x1)', () => {
    const s = wizardReducer(withPlot(), {
      type: 'applyTheme', themeId: 't',
      items: Array.from({ length: 12 }, (_, i) => ({ asset: asset('a', 1500), x: 0.1 + i * 0.07, z: 0.5, rotationY: 0 })),
    })
    expect(s.items).toHaveLength(12)
    expect(s.lastDropped).toBe(0)
    expect(s.themeId).toBe('t')
  })
  it('keeps what fits the item limit and records the drop (182 on 1x1)', () => {
    const s = wizardReducer(withPlot(), {
      type: 'applyTheme', themeId: 't',
      items: Array.from({ length: 182 }, () => ({ asset: asset('a', 1), x: 0.5, z: 0.5, rotationY: 0 })),
    })
    expect(s.items).toHaveLength(180)
    expect(s.lastDropped).toBe(2)
  })
})

describe('applyTheme without Decentraland limits', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ asset: asset('a', 1500), x: 0.1 + i * 0.07, z: 0.5, rotationY: 0 }))
  it('keeps every item for a Hyperfy-only user', () => {
    const h = wizardReducer(initialState, { type: 'setHyperfy', hyperfy: { kind: 'self', name: 'w' } })
    const s = wizardReducer(h, { type: 'applyTheme', themeId: 't', items: many })
    expect(s.items).toHaveLength(12)
    expect(s.lastDropped).toBe(0)
  })
  it('keeps every item when dcl is set but no plot yet', () => {
    const d = wizardReducer(initialState, { type: 'setDcl', dcl })
    expect(wizardReducer(d, { type: 'applyTheme', themeId: 't', items: many }).items).toHaveLength(12)
  })
  it('setPlot does not drop items without a dcl destination', () => {
    let s = wizardReducer(initialState, { type: 'setHyperfy', hyperfy: { kind: 'self', name: 'w' } })
    s = wizardReducer(s, { type: 'applyTheme', themeId: 't', items: many })
    s = wizardReducer(s, { type: 'setPlot', plot: { width: 1, depth: 1, base: { x: 0, y: 0 } } })
    expect(s.items).toHaveLength(12)
  })
})

describe('addAsset', () => {
  it('places a free item near the centre', () => {
    const s = wizardReducer(withPlot(), { type: 'addAsset', asset: asset('a') })
    expect(s.items).toHaveLength(1)
    expect(s.items[0].x).toBeCloseTo(8, 0)
  })
  it('adds an item over the triangle budget, and the budget warns', () => {
    const s = wizardReducer(withPlot(), { type: 'addAsset', asset: asset('big', 10_001) })
    expect(s.items).toHaveLength(1)
    expect(s.notice).toBeNull()
    expect(stateBudget(s).warning).toMatch(/10,001 triangles, more than the 10,000 Decentraland recommends/)
  })
  it('adds a 1x1 building after switching a theme to Empty plot', () => {
    let s = wizardReducer(withPlot(), { type: 'applyTheme', themeId: 'park', items: [{ asset: asset('tree'), x: 0.5, z: 0.5, rotationY: 0 }] })
    s = wizardReducer(s, { type: 'applyTheme', themeId: 'empty', items: [] })
    s = wizardReducer(s, { type: 'addAsset', asset: asset('house', 3_000, 16) })
    expect(s.items).toHaveLength(1)
    expect(s.notice).toBeNull()
  })
  it('refuses when there is no room', () => {
    let s = withPlot()
    for (let i = 0; i < 40; i++) s = wizardReducer(s, { type: 'addAsset', asset: asset('b', 10, 4) })
    expect(s.items.length).toBeLessThan(40)
    expect(s.notice).toMatch(/free room/)
  })
  it('uses unique keys', () => {
    let s = withPlot()
    s = wizardReducer(s, { type: 'addAsset', asset: asset('a') })
    s = wizardReducer(s, { type: 'removeItem', key: s.items[0].key })
    s = wizardReducer(s, { type: 'addAsset', asset: asset('a') })
    s = wizardReducer(s, { type: 'addAsset', asset: asset('a') })
    expect(new Set(s.items.map((i) => i.key)).size).toBe(2)
  })
})

describe('moveItem / rotateItem / setPlot', () => {
  it('clamps a move outside the plot', () => {
    let s = wizardReducer(withPlot(), { type: 'addAsset', asset: asset('a') })
    s = wizardReducer(s, { type: 'moveItem', key: s.items[0].key, x: -50, z: 500 })
    expect(s.items[0]).toMatchObject({ x: 0.5, z: 15.5 })
  })
  it('rotates by 90', () => {
    let s = wizardReducer(withPlot(), { type: 'addAsset', asset: asset('a') })
    for (let i = 0; i < 4; i++) s = wizardReducer(s, { type: 'rotateItem', key: s.items[0].key })
    expect(s.items[0].rotationY).toBe(0)
  })
  it('shrinking the plot clamps items and keeps them all, whatever their triangles', () => {
    let s = withPlot()
    s = wizardReducer(s, { type: 'setPlot', plot: { width: 3, depth: 1, base: { x: 0, y: 0 } } })
    s = wizardReducer(s, { type: 'applyTheme', themeId: null, items: Array.from({ length: 10 }, () => ({ asset: asset('a', 2500), x: 0.9, z: 0.5, rotationY: 0 })) })
    expect(s.items).toHaveLength(10)
    s = wizardReducer(s, { type: 'setPlot', plot: { width: 1, depth: 1, base: { x: 0, y: 0 } } })
    expect(s.items).toHaveLength(10)
    expect(s.lastDropped).toBe(0)
    expect(s.items.every((i) => i.x <= 15.5)).toBe(true)
    expect(s.spawn).toEqual({ x: 8, z: 1 })
  })
})

describe('canAdvance', () => {
  it('needs a destination at where', () => {
    expect(canAdvance(initialState)).toBe(false)
    expect(canAdvance(wizardReducer({ ...initialState, name: 'S' }, { type: 'setAr', ar: { name: 'x' } }))).toBe(true)
  })
  it('needs a plot at size when dcl is set; hyperfy-only does not', () => {
    const d = wizardReducer({ ...initialState, step: 'size' }, { type: 'setDcl', dcl })
    expect(canAdvance(d)).toBe(false)
    expect(canAdvance(wizardReducer(d, { type: 'setPlot', plot: { width: 1, depth: 1, base: { x: 0, y: 0 } } }))).toBe(true)
    const h = wizardReducer({ ...initialState, step: 'size' }, { type: 'setHyperfy', hyperfy: { kind: 'self', name: 'w' } })
    expect(canAdvance(h)).toBe(true)
  })
  it('never blocks assets/arrange for triangles', () => {
    const s: WizardState = { ...withPlot({ step: 'assets' }), items: [{ key: 'k', asset: asset('a', 20_000), x: 8, z: 8, rotationY: 0 }] }
    expect(canAdvance(s)).toBe(true)
    expect(canAdvance({ ...s, step: 'arrange' })).toBe(true)
  })
  it('hyperfy-only placement uses the 2x2 guide plot', () => {
    let s = wizardReducer(initialState, { type: 'setHyperfy', hyperfy: { kind: 'self', name: 'w' } })
    s = wizardReducer(s, { type: 'addAsset', asset: asset('a', 50_000, 20) })
    expect(s.items).toHaveLength(1)
    expect(canAdvance({ ...s, step: 'assets' })).toBe(true)
  })
})

describe('scene name', () => {
  const named = (name: string, s: WizardState = initialState) => wizardReducer(s, { type: 'setName', name })

  it('starts empty: no silent default', () => {
    expect(initialState.name).toBe('')
  })
  it('the first step needs a non-blank name as well as a destination', () => {
    const withAr = wizardReducer(initialState, { type: 'setAr', ar: { name: 'x' } })
    expect(canAdvance(withAr)).toBe(false)
    expect(canAdvance(named('   ', withAr))).toBe(false)
    expect(canAdvance(named('Moon', withAr))).toBe(true)
    expect(canAdvance(named('Moon'))).toBe(false)
  })
  it('a Hyperfy world and an AR space start with the scene name and follow it while untouched', () => {
    let s = named('Moo')
    s = wizardReducer(s, { type: 'setHyperfy', hyperfy: { kind: 'self', name: '' } })
    s = wizardReducer(s, { type: 'setAr', ar: { name: '' } })
    expect(s.destinations.hyperfy?.name).toBe('Moo')
    expect(s.destinations.ar?.name).toBe('Moo')
    s = named('Moon base', s)
    expect(s.destinations.hyperfy?.name).toBe('Moon base')
    expect(s.destinations.ar?.name).toBe('Moon base')
  })
  it('a field the user edits keeps its own value; the other still follows', () => {
    let s = named('Moon')
    s = wizardReducer(s, { type: 'setHyperfy', hyperfy: { kind: 'self', name: '' } })
    s = wizardReducer(s, { type: 'setAr', ar: { name: '' } })
    s = wizardReducer(s, { type: 'setHyperfyName', name: 'My Hyperfy' })
    s = named('Moon base', s)
    expect(s.destinations.hyperfy?.name).toBe('My Hyperfy')
    expect(s.destinations.ar?.name).toBe('Moon base')
    s = wizardReducer(s, { type: 'setArName', name: 'Lobby' })
    s = named('Moon base 2', s)
    expect(s.destinations.ar?.name).toBe('Lobby')
  })
  it('changing the Hyperfy kind keeps the name and whether it was edited', () => {
    let s = named('Moon')
    s = wizardReducer(s, { type: 'setHyperfy', hyperfy: { kind: 'self', name: '' } })
    s = wizardReducer(s, { type: 'setHyperfy', hyperfy: { kind: 'hosted', name: 'Moon' } })
    s = named('Moon 2', s)
    expect(s.destinations.hyperfy).toEqual({ kind: 'hosted', name: 'Moon 2' })
  })
  it('turning a destination off and on again starts it from the scene name', () => {
    let s = named('Moon')
    s = wizardReducer(s, { type: 'setAr', ar: { name: '' } })
    s = wizardReducer(s, { type: 'setArName', name: 'Lobby' })
    s = wizardReducer(s, { type: 'setAr', ar: null })
    s = wizardReducer(s, { type: 'setAr', ar: { name: '' } })
    expect(s.destinations.ar?.name).toBe('Moon')
    s = named('Moon 2', s)
    expect(s.destinations.ar?.name).toBe('Moon 2')
  })
})

describe('scene name longer than a Hyperfy name may be', () => {
  it('the following Hyperfy name stops at 100 characters', () => {
    let s = wizardReducer(initialState, { type: 'setHyperfy', hyperfy: { kind: 'self', name: '' } })
    s = wizardReducer(s, { type: 'setName', name: 'x'.repeat(120) })
    expect(s.destinations.hyperfy?.name).toHaveLength(100)
  })
})

describe('room set', () => {
  const scanPlot = { width: 2, depth: 1, base: { x: 0, y: 0 } }
  const chosen = (s: WizardState = wizardReducer(initialState, { type: 'setDcl', dcl })) =>
    wizardReducer(s, { type: 'setRoomSet', scanId: 'scan-1', plot: scanPlot })

  it('setRoomSet sets the plot to the scan plot, with default options', () => {
    const s = chosen()
    expect(s.plot).toEqual(scanPlot)
    expect(s.roomSet).toMatchObject({ scanId: 'scan-1', plot: scanPlot, options: { style: 'plain', wallColor: '#E8E6E1', floorColor: '#B9A68C', ceiling: false, furniture: false } })
    expect(s.spawn).toEqual({ x: 16, z: 1 })
  })
  it('ignores setPlot while a room set is chosen', () => {
    const s = wizardReducer(chosen(), { type: 'setPlot', plot: { width: 3, depth: 3, base: { x: 0, y: 0 } } })
    expect(s.plot).toEqual(scanPlot)
  })
  it('clearRoomSet restores free plot choice', () => {
    let s = wizardReducer(chosen(), { type: 'clearRoomSet' })
    expect(s.roomSet).toBeNull()
    s = wizardReducer(s, { type: 'setPlot', plot: { width: 3, depth: 3, base: { x: 0, y: 0 } } })
    expect(s.plot).toEqual({ width: 3, depth: 3, base: { x: 0, y: 0 } })
  })
  it('stateBudget includes the set\'s triangles once the preview has counted them', () => {
    let s = wizardReducer(chosen(), { type: 'addAsset', asset: asset('a', 100) })
    expect(stateBudget(s).triangles.used).toBe(100)
    s = wizardReducer(s, { type: 'setRoomSetTriangles', scanId: 'scan-1', triangles: 1_234 })
    expect(stateBudget(s).triangles.used).toBe(1_334)
    // A count for a scan no longer chosen is ignored
    s = wizardReducer(s, { type: 'setRoomSetTriangles', scanId: 'other', triangles: 9 })
    expect(stateBudget(s).triangles.used).toBe(1_334)
  })
  it('stateBudget counts the room as one entity', () => {
    const s = wizardReducer(chosen(), { type: 'addAsset', asset: asset('a', 100) })
    expect(stateBudget(s).entities.used).toBe(2)
  })
  it('adds an item that takes the room past the triangle budget, with a warning', () => {
    let s = wizardReducer(chosen(), { type: 'setRoomSetTriangles', scanId: 'scan-1', triangles: 19_950 })
    s = wizardReducer(s, { type: 'addAsset', asset: asset('a', 100) })
    expect(s.items).toHaveLength(1)
    expect(stateBudget(s).warning).toMatch(/^This scene has 20,050 triangles/)
  })
  it('changing options keeps the scan and its plot', () => {
    const s = wizardReducer(chosen(), { type: 'setRoomSetOptions', options: { style: 'house', ceiling: true } })
    expect(s.roomSet?.options).toMatchObject({ style: 'house', ceiling: true, wallColor: '#E8E6E1' })
    expect(s.plot).toEqual(scanPlot)
  })
  it('canAdvance at the size step is true with a room set and no manual plot', () => {
    expect(canAdvance({ ...chosen(), step: 'size' })).toBe(true)
  })
})
