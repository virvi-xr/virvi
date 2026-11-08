import { describe, it, expect } from 'vitest'
import {
  HEAT_STEPS, colourStep, flattenCells, floorOf, hasHeightVariation, floorSummary, cellsFor3d, floorLabel, floorsOf, heatView, cellBox,
} from './heat'
import type { HeatCell } from './types'

const c = (x: number, z: number, cellY: number | null | undefined, dwellSec: number, visits = 1): HeatCell => ({ x, z, cellY, dwellSec, visits })

describe('heat cells', () => {
  it('six colour steps, as the 2D map has always used', () => {
    expect(HEAT_STEPS).toBe(6)
    expect(colourStep(1, 60)).toBe(0)
    expect(colourStep(10, 60)).toBe(1)
    expect(colourStep(60, 60)).toBe(5)
  })

  it('flattening sums every floor (and the height-less days) into one 2D cell', () => {
    expect(flattenCells([c(1, 1, 0, 10, 1), c(1, 1, 1, 20, 2), c(1, 1, null, 5, 1), c(2, 1, 0, 1, 1)])).toEqual([
      { x: 1, z: 1, dwellSec: 35, visits: 4 },
      { x: 2, z: 1, dwellSec: 1, visits: 1 },
    ])
  })

  it('a cell without a height is on the ground floor; height varies only with two floors', () => {
    expect(floorOf(c(0, 0, null, 1))).toBe(0)
    expect(floorOf(c(0, 0, undefined, 1))).toBe(0)
    expect(hasHeightVariation([c(0, 0, 0, 1), c(1, 0, null, 1)])).toBe(false)
    expect(hasHeightVariation([c(0, 0, 0, 1), c(1, 0, 1, 1)])).toBe(true)
    expect(hasHeightVariation([c(0, 0, undefined, 1)])).toBe(false)
    expect(floorsOf([c(0, 0, 2, 1), c(0, 0, null, 1), c(1, 0, 0, 1)])).toEqual([0, 2])
  })

  it('floors are labelled by the feet heights they cover', () => {
    expect(floorLabel(0)).toBe('Ground level')
    expect(floorLabel(1)).toBe('1.6–3.6 m up')
    expect(floorLabel(-1)).toBe('0.4–2.4 m below')
  })

  it('summary: cell count, maximum and the busiest floors by the chosen metric', () => {
    const cells = [c(0, 0, 0, 10, 5), c(1, 0, 0, 10, 1), c(0, 0, 1, 50, 1), c(0, 0, null, 5, 1)]
    expect(floorSummary(cells, 'dwell')).toEqual({ cells: 4, max: 50, floors: [{ level: 1, total: 50 }, { level: 0, total: 25 }], heightless: 1 })
    expect(floorSummary(cells, 'visits').floors).toEqual([{ level: 0, total: 7 }, { level: 1, total: 1 }])
  })

  it('3D draws every cell with a value; above the cap it drops the faintest steps first', () => {
    const many = Array.from({ length: 10 }, (_, i) => c(i, 0, 0, i === 9 ? 60 : 1))
    expect(cellsFor3d([...many, c(0, 1, 0, 0)], 'dwell')).toMatchObject({ hidden: 0 })
    expect(cellsFor3d([...many, c(0, 1, 0, 0)], 'dwell').cells).toHaveLength(10)
    const capped = cellsFor3d(many, 'dwell', 5)
    expect(capped.cells.map((x) => x.x)).toEqual([9])
    expect(capped.hidden).toBe(9)
  })

  it('a cell box spans its band of feet height; a height-less cell is a thin tile on the ground', () => {
    expect(cellBox(c(3, 4, 1, 1))).toEqual({ x: 3.5, z: 4.5, bottom: 1.6, height: 2 })
    expect(cellBox(c(3, 4, 0, 1))).toEqual({ x: 3.5, z: 4.5, bottom: 0, height: 1.6 })
    expect(cellBox(c(3, 4, null, 1))).toEqual({ x: 3.5, z: 4.5, bottom: 0, height: 0.1 })
  })

  it('view: free plans are locked to 2D; paid default to 3D only with height variation; no WebGL falls back with a note', () => {
    const flat = [c(0, 0, 0, 1)]
    const tall = [c(0, 0, 0, 1), c(0, 0, 1, 1)]
    expect(heatView({ heatmap3d: false, webgl: true, cells: tall, chosen: '3d' })).toEqual({ view: '2d', locked: true, note: null })
    expect(heatView({ heatmap3d: true, webgl: true, cells: flat, chosen: null })).toEqual({ view: '2d', locked: false, note: null })
    expect(heatView({ heatmap3d: true, webgl: true, cells: tall, chosen: null })).toEqual({ view: '3d', locked: false, note: null })
    expect(heatView({ heatmap3d: true, webgl: true, cells: tall, chosen: '2d' })).toEqual({ view: '2d', locked: false, note: null })
    expect(heatView({ heatmap3d: true, webgl: false, cells: flat, chosen: null })).toEqual({ view: '2d', locked: false, note: null })
    expect(heatView({ heatmap3d: true, webgl: false, cells: tall, chosen: null })).toMatchObject({ view: '2d', note: expect.stringMatching(/WebGL/) })
    expect(heatView({ heatmap3d: true, webgl: false, cells: tall, chosen: '3d' })).toMatchObject({ view: '2d', note: expect.stringMatching(/WebGL/) })
  })
})
