'use client'
import { useMemo, useState, type ReactNode } from 'react'
import type { HeatCell, LiveData } from '@/lib/analytics/types'
import { mapBounds, parcelRects, toSvg, type MapBounds } from '@/lib/analytics/parcel-map'
import { cellValue, colourStep, HEAT_STEPS, maxOf, type HeatMetric } from '@/lib/analytics/heat-scale'
import { formatDuration } from '@/lib/analytics/labels'
import { full } from './format'

const W = 480

const fmt = (v: number, metric: HeatMetric) => (metric === 'dwell' ? formatDuration(v) : `${full(v)} visit${v === 1 ? '' : 's'}`)

/** The map's frame, for layers drawn on it: SVG units are W wide, `k` per metre. */
export interface MapGeometry { W: number; height: number; k: number; bounds: MapBounds; px: (x: number) => number; py: (z: number) => number }

/** Extra layers (the heatmap's bird's-eye layout, LIV-85), so the Here-now map doesn't carry them. */
export interface MapLayers {
  /** Scene points the map must cover when there are no parcels. */
  points: Array<{ x: number; z: number }>
  /** HTML between the parcel tiles and the heat (the top-down render), covering the map. */
  canvas?: (g: MapGeometry) => ReactNode
  /** SVG under the heat cells, and over them. */
  belowHeat?: (g: MapGeometry) => ReactNode
  aboveHeat?: (g: MapGeometry) => ReactNode
  /** HTML over everything (a hover label), positioned in % of the map. */
  tooltip?: ReactNode
  heatOpacity?: number
  summary?: string
  caption?: ReactNode
  onLeave?: () => void
}

/**
 * Scene-relative map (metres, base parcel SW corner at origin, +z north): parcel tiles,
 * optional 1 m heat cells, optional live position dots, optional extra layers. Shared by Heatmap and Here-now.
 */
export function ParcelMap({ parcels, baseParcel, cells, metric = 'dwell', live, layers }: {
  parcels: string[]; baseParcel: string | null; cells?: HeatCell[]; metric?: HeatMetric; live?: LiveData['positions']; layers?: MapLayers
}) {
  const [hover, setHover] = useState<number | null>(null)
  const heat = useMemo(() => (cells ?? []).filter((c) => cellValue(c, metric) > 0), [cells, metric])
  const dots = live ?? []
  const bounds = mapBounds(parcels, baseParcel, [...heat, ...dots, ...(layers?.points ?? [])])
  const { height, px, py } = toSvg(bounds, W)
  const k = W / (bounds.maxX - bounds.minX) // px per metre
  const g: MapGeometry = { W, height, k, bounds, px, py }
  const tiles = parcelRects(parcels, baseParcel)
  const max = maxOf(heat, (c) => cellValue(c, metric))
  const h = hover !== null ? heat[hover] : null
  const metricLabel = metric === 'dwell' ? 'Time spent' : 'Visits'
  const tileFont = Math.max(8, Math.min(12, (k * 16) / 5))

  const summary = [
    `Map of ${tiles.length || 1} parcel tile${tiles.length === 1 ? '' : 's'}`,
    layers?.summary,
    cells && `${heat.length} heat cells by ${metricLabel.toLowerCase()}${max ? `, max ${fmt(max, metric)}` : ''}`,
    live && `${dots.length} visitor${dots.length === 1 ? '' : 's'} here now`,
  ].filter(Boolean).join('; ')

  return (
    <figure className="relative m-0">
      <div className="relative" style={{ aspectRatio: `${W} / ${height}` }} onPointerLeave={() => { setHover(null); layers?.onLeave?.() }}>
        <svg viewBox={`0 0 ${W} ${height}`} width="100%" className="absolute inset-0 block h-full w-full" aria-hidden="true">
          {(tiles.length ? tiles : [{ label: '', x: bounds.minX, z: bounds.minZ, size: 16 }]).map((t) => (
            <g key={t.label || 'tile'}>
              <rect
                x={px(t.x)} y={py(t.z + t.size)} width={t.size * k} height={t.size * k}
                strokeWidth={1} shapeRendering="crispEdges"
                style={{ fill: 'var(--chart-surface)', stroke: 'var(--chart-tile)' }}
              />
              {t.label && (
                <text x={px(t.x) + 4} y={py(t.z + t.size) + 4} dy="1em" fontSize={tileFont} style={{ fill: 'var(--chart-text-muted)' }}>
                  {t.label}
                </text>
              )}
            </g>
          ))}
        </svg>
        {layers?.canvas?.(g)}
        <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={summary} className="pointer-events-none absolute inset-0 block h-full w-full">
          {layers?.belowHeat?.(g)}
          <g opacity={layers?.heatOpacity ?? 1}>
            {heat.map((c, i) => (
              <rect
                key={`${c.x},${c.z}`}
                x={px(c.x)} y={py(c.z + 1)} width={k} height={k}
                shapeRendering="crispEdges"
                className="pointer-events-auto"
                style={{ fill: `var(--heat-${colourStep(cellValue(c, metric), max)})` }}
                onPointerEnter={() => { setHover(i); layers?.onLeave?.() }}
              />
            ))}
          </g>
          {h && (
            <rect x={px(h.x)} y={py(h.z + 1)} width={k} height={k} fill="none" strokeWidth={1.5} style={{ stroke: 'var(--chart-text)' }} />
          )}
          {layers?.aboveHeat?.(g)}
          {dots.map((d, i) => (
            <circle key={i} cx={px(d.x)} cy={py(d.z)} r={5} strokeWidth={2} style={{ fill: 'var(--chart-2)', stroke: 'var(--chart-surface)' }} />
          ))}
        </svg>
        {h && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 rounded-md bg-gray-800 px-3 py-2 text-xs shadow-lg ring-1 ring-white/10 whitespace-nowrap"
            style={{
              left: `${((px(h.x) + k / 2) / W) * 100}%`,
              top: `${(py(h.z + 1) / height) * 100}%`,
              transform: px(h.x) > W / 2 ? 'translate(calc(-100% - 8px), -100%)' : 'translate(8px, -100%)',
            }}
          >
            <p className="text-sm font-semibold text-white">{fmt(cellValue(h, metric), metric)}</p>
            <p className="text-gray-400">{metric === 'dwell' ? `${full(h.visits)} visit${h.visits === 1 ? '' : 's'}` : `${formatDuration(h.dwellSec)} spent`}</p>
            <p className="text-gray-400">x {h.x} m, z {h.z} m</p>
          </div>
        )}
        {!h && layers?.tooltip}
      </div>
      {(cells || live) && (
        <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
          {cells && (
            <span className="flex items-center gap-1.5">
              {metricLabel}: less
              {Array.from({ length: HEAT_STEPS }, (_, i) => (
                <span key={i} aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `var(--heat-${i})` }} />
              ))}
              more
            </span>
          )}
          {live && (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--chart-2)' }} />
              Visitor now
            </span>
          )}
          {layers?.caption}
        </figcaption>
      )}
    </figure>
  )
}
