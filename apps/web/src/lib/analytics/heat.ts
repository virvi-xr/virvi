// Heat cells for the 2D and 3D heatmaps (LIV-85). Cells carry a floor band (`cellY`, see heatmap-height in
// @virvixr/shared) on paid plans; null for days rolled up before heights were recorded, absent on free plans.
// The module itself, not the package index: @virvixr/shared is CommonJS, so the index would bring all of it along.
import { bandRangeM } from '@virvixr/shared/dist/heatmap-height.js'
import type { HeatCell } from './types'

import { cellValue, colourStep, HEAT_STEPS, maxOf, type HeatMetric } from './heat-scale'

export { cellValue, colourStep, HEAT_STEPS, maxOf, type HeatMetric }
/** Above this many cells the 3D view drops the faintest colour steps. */
export const MAX_3D_CELLS = 20_000


/**
 * For 3D: a cell from days before heights were recorded and a ground-floor cell at the same spot become one ground
 * cell with the summed value (flagged), so a hot spot across the backfill boundary isn't split into two cooler boxes.
 * A height-less cell with no ground cell beside it stays as it is.
 */
export function mergeGround(cells: HeatCell[]): HeatCell[] {
  const out: Array<HeatCell & { _null?: boolean; _ground?: boolean }> = []
  const at = new Map<string, HeatCell & { _null?: boolean; _ground?: boolean }>()
  for (const c of cells) {
    if (c.cellY !== 0 && c.cellY !== null) {
      out.push(c)
      continue
    }
    const k = `${c.x},${c.z}`
    let m = at.get(k)
    if (!m) {
      m = { x: c.x, z: c.z, cellY: c.cellY, dwellSec: 0, visits: 0 }
      at.set(k, m)
      out.push(m)
    }
    m.dwellSec += c.dwellSec
    m.visits += c.visits
    if (c.cellY === null) m._null = true
    else m._ground = true
  }
  return out.map((c) => {
    if (!('_null' in c) && !('_ground' in c)) return c
    const { _null, _ground, ...cell } = c
    return _null && _ground ? { ...cell, cellY: 0, partlyHeightless: true } : cell
  })
}

/** The floor a cell is drawn on: a cell without a height is at ground level. */
export const floorOf = (c: HeatCell) => c.cellY ?? 0

/** The 2D map: every floor summed into one cell per x/z. */
export function flattenCells(cells: HeatCell[]): HeatCell[] {
  const out = new Map<string, HeatCell>()
  for (const c of cells) {
    const k = `${c.x},${c.z}`
    const prev = out.get(k)
    if (prev) {
      prev.dwellSec += c.dwellSec
      prev.visits += c.visits
    } else out.set(k, { x: c.x, z: c.z, dwellSec: c.dwellSec, visits: c.visits })
  }
  return [...out.values()].sort((a, b) => a.x - b.x || a.z - b.z)
}

export function floorsOf(cells: HeatCell[]): number[] {
  return [...new Set(cells.map(floorOf))].sort((a, b) => a - b)
}

export const hasHeightVariation = (cells: HeatCell[]) => floorsOf(cells).length > 1

export function floorLabel(level: number): string {
  if (level === 0) return 'Ground level'
  const r = bandRangeM(level)
  return level > 0 ? `${r.from}–${r.to} m up` : `${-r.to}–${-r.from} m below`
}

export function floorSummary(cells: HeatCell[], metric: HeatMetric) {
  const totals = new Map<number, number>()
  for (const c of cells) totals.set(floorOf(c), (totals.get(floorOf(c)) ?? 0) + cellValue(c, metric))
  return {
    cells: cells.length,
    max: maxOf(cells, (c) => cellValue(c, metric)),
    floors: [...totals].map(([level, total]) => ({ level, total })).sort((a, b) => b.total - a.total || a.level - b.level),
    heightless: cells.filter((c) => c.cellY === null || c.partlyHeightless).length,
  }
}

/** The cells the 3D view draws: those with a value, dropping the faintest steps while there are more than `cap`. */
export function cellsFor3d(cells: HeatCell[], metric: HeatMetric, cap = MAX_3D_CELLS): { cells: HeatCell[]; max: number; hidden: number } {
  const lit = cells.filter((c) => cellValue(c, metric) > 0)
  const max = maxOf(lit, (c) => cellValue(c, metric))
  let shown = lit
  for (let step = 1; shown.length > cap && step < HEAT_STEPS; step++) shown = lit.filter((c) => colourStep(cellValue(c, metric), max) >= step)
  // Still too many in the hottest step alone: keep the hottest cells.
  if (shown.length > cap) shown = [...shown].sort((a, b) => cellValue(b, metric) - cellValue(a, metric)).slice(0, cap)
  return { cells: shown, max, hidden: lit.length - shown.length }
}

/** Where a cell's box sits in scene metres: its x/z centre and the feet heights of its band (ground starts at 0). */
export function cellBox(c: HeatCell): { x: number; z: number; bottom: number; height: number } {
  const centre = { x: c.x + 0.5, z: c.z + 0.5 }
  if (c.cellY === null || c.cellY === undefined) return { ...centre, bottom: 0, height: 0.1 }
  const r = bandRangeM(c.cellY)
  const bottom = c.cellY === 0 ? 0 : r.from
  return { ...centre, bottom, height: Math.round((r.to - bottom) * 100) / 100 }
}

export const NO_WEBGL_NOTE = "3D needs WebGL, which this browser doesn't have, so here's the 2D map."

/** Which view to show: free plans only get 2D; paid default to 3D when there's more than one floor. */
export function heatView(o: { heatmap3d: boolean; webgl: boolean; cells: HeatCell[]; chosen: '2d' | '3d' | null }): {
  view: '2d' | '3d'; locked: boolean; note: string | null
} {
  if (!o.heatmap3d) return { view: '2d', locked: true, note: null }
  const want = o.chosen ?? (hasHeightVariation(o.cells) ? '3d' : '2d')
  if (want === '3d' && !o.webgl) return { view: '2d', locked: false, note: NO_WEBGL_NOTE }
  return { view: want, locked: false, note: null }
}

/** The heat ramp as colours for three.js: mirrors --heat-0..5 in styles/globals.css. */
export const HEAT_COLOURS = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb']
/** Live positions: mirrors --chart-2. */
export const LIVE_COLOUR = '#d95926'
