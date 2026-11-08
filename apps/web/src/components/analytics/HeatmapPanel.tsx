'use client'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { HeatmapData, LayoutItem, LiveData } from '@/lib/analytics/types'
import { cellsFor3d, flattenCells, floorLabel, floorsOf, floorSummary, heatView, type HeatMetric } from '@/lib/analytics/heat'
import { placeLayout } from '@/lib/analytics/layout'
import { formatDuration } from '@/lib/analytics/labels'
import { hasWebGL } from '@/lib/webgl'
import { ParcelMap } from './ParcelMap'
import { full } from './format'

// three.js loads only when someone opens 3D, so the analytics page's first load doesn't grow.
const Heatmap3D = dynamic(() => import('./Heatmap3D'), {
  ssr: false,
  loading: () => <div className="h-[420px] w-full animate-pulse rounded-lg border border-gray-800 bg-gray-950" aria-label="Loading the 3D heatmap" />,
})

const segment = (on: boolean) =>
  `rounded-md px-3 py-1 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${on ? 'bg-blue-600 text-white' : 'text-gray-300 hover:text-white'}`

const fmt = (v: number, metric: HeatMetric) => (metric === 'dwell' ? formatDuration(v) : `${full(v)} visit${v === 1 ? '' : 's'}`)

/** The Heatmap section's body (LIV-85): the 2D bird's-eye map for every plan, and the 3D view for paid plans. */
export function HeatmapPanel({ parcels, baseParcel, kind, data, metric, live, layout }: {
  parcels: string[]; baseParcel: string | null; kind: string
  data: HeatmapData; metric: HeatMetric; live?: LiveData['positions']; layout: LayoutItem[] | null
}) {
  const [chosen, setChosen] = useState<'2d' | '3d' | null>(null)
  // Unknown until mounted (the server render has no WebGL to ask): 2D meanwhile, without the no-WebGL note.
  const [webgl, setWebgl] = useState<boolean | null>(null)
  useEffect(() => setWebgl(hasWebGL()), [])
  const [failed, setFailed] = useState(false)
  const [lockNote, setLockNote] = useState(false)
  const [floor, setFloor] = useState<number | 'all'>('all')
  const placed = useMemo(() => (layout ? placeLayout(layout) : null), [layout])
  const flat = useMemo(() => flattenCells(data.cells), [data.cells])
  const v = heatView({ heatmap3d: data.heatmap3d, webgl: !!webgl && !failed, cells: data.cells, chosen })
  const note = webgl === null ? null : failed && v.view === '2d' && chosen !== '2d' ? "3D couldn't start in this browser, so here's the 2D map." : v.note
  const floors = useMemo(() => floorsOf(data.cells), [data.cells])
  const drawn = useMemo(() => cellsFor3d(data.cells, metric), [data.cells, metric])
  const summary = useMemo(() => floorSummary(data.cells.filter((c) => (metric === 'dwell' ? c.dwellSec : c.visits) > 0), metric), [data.cells, metric])
  const shownFloor = floor !== 'all' && !floors.includes(floor) ? 'all' : floor

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Heatmap view" className="inline-flex rounded-lg bg-gray-800 p-1">
          <button type="button" aria-pressed={v.view === '2d'} onClick={() => { setChosen('2d'); setLockNote(false) }} className={segment(v.view === '2d')}>2D</button>
          {v.locked ? (
            <button
              type="button"
              aria-pressed={false}
              aria-describedby={lockNote ? 'heatmap-3d-locked' : undefined}
              title="3D heatmap is on paid plans"
              onClick={() => setLockNote((n) => !n)}
              className={`${segment(false)} inline-flex items-center gap-1`}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
                <path d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z" />
              </svg>
              3D<span className="sr-only"> (on paid plans)</span>
            </button>
          ) : (
            <button type="button" aria-pressed={v.view === '3d'} onClick={() => { setChosen('3d'); setFailed(false) }} className={segment(v.view === '3d')}>3D</button>
          )}
        </div>
        {v.view === '3d' && floors.length > 1 && (
          <label className="flex items-center gap-2 text-sm text-gray-300">
            Floor
            <select
              value={String(shownFloor)}
              onChange={(e) => setFloor(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white outline-none [color-scheme:dark] focus:border-blue-400"
            >
              <option value="all">All floors</option>
              {floors.map((f) => <option key={f} value={f}>{floorLabel(f)}</option>)}
            </select>
          </label>
        )}
      </div>
      {v.locked && lockNote && (
        <p id="heatmap-3d-locked" className="mb-3 text-sm text-gray-400" role="status">
          3D heatmap is on paid plans.{' '}
          <Link href="/settings" className="text-blue-400 hover:text-blue-300 hover:underline">Upgrade</Link>
        </p>
      )}
      {note && <p className="mb-3 text-sm text-gray-400" role="status">{note}</p>}

      {v.view === '3d' ? (
        <>
          <Heatmap3D
            parcels={parcels}
            baseParcel={baseParcel}
            kind={kind}
            cells={drawn.cells}
            max={drawn.max}
            metric={metric}
            floor={shownFloor}
            live={live}
            models={placed?.models ?? []}
            onFailed={() => setFailed(true)}
          />
          <p className="mt-2 text-xs text-gray-400">
            {full(summary.cells)} heat cell{summary.cells === 1 ? '' : 's'} by {metric === 'dwell' ? 'time spent' : 'visits'}
            {summary.max > 0 && `, max ${fmt(summary.max, metric)}`}
            {summary.floors.length > 0 && `. Busiest floors: ${summary.floors.slice(0, 3).map((f) => `${floorLabel(f.level)} (${fmt(f.total, metric)})`).join(', ')}`}.
            {drawn.hidden > 0 && ` The ${full(drawn.hidden)} faintest cells aren't drawn, to keep the view smooth.`}
            {summary.heightless > 0 && ' Days from before heights were recorded are drawn at ground level (height not recorded).'}
          </p>
        </>
      ) : (
        <div className="mx-auto max-w-xl">
          <ParcelMap parcels={parcels} baseParcel={baseParcel} cells={flat} metric={metric} layout={placed} />
        </div>
      )}
    </div>
  )
}
