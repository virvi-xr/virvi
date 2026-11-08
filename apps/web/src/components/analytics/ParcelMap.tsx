'use client'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HeatCell, LiveData } from '@/lib/analytics/types'
import { mapBounds, parcelRects, toSvg } from '@/lib/analytics/parcel-map'
import { cellValue, colourStep, HEAT_STEPS, type HeatMetric } from '@/lib/analytics/heat'
import { iconFor, type PlacedIcon, type PlacedModel } from '@/lib/analytics/layout'
import { formatDuration } from '@/lib/analytics/labels'
import { hasWebGL } from '@/lib/webgl'
import { full } from './format'

// The top-down render of the scene's models: three.js, so it loads only for a linked scene with models.
const BirdsEyeModels = dynamic(() => import('./BirdsEyeModels'), { ssr: false })

const W = 480

const fmt = (v: number, metric: HeatMetric) => (metric === 'dwell' ? formatDuration(v) : `${full(v)} visit${v === 1 ? '' : 's'}`)

type Hover = { kind: 'cell'; i: number } | { kind: 'name'; name: string; left: number; top: number }

/**
 * Scene-relative map (metres, base parcel SW corner at origin, +z north): parcel tiles, optionally the linked scene's
 * layout from above (models rendered straight down, other elements as icons), 1 m heat cells and live position dots.
 * Shared by Heatmap and Here-now.
 */
export function ParcelMap({ parcels, baseParcel, cells, metric = 'dwell', live, layout }: {
  parcels: string[]; baseParcel: string | null; cells?: HeatCell[]; metric?: HeatMetric; live?: LiveData['positions']
  layout?: { models: PlacedModel[]; icons: PlacedIcon[] } | null
}) {
  const [hover, setHover] = useState<Hover | null>(null)
  const [webgl, setWebgl] = useState(false)
  useEffect(() => setWebgl(hasWebGL()), [])
  // Models drawn by the top-down render; the rest (loading, failed, no GLB, no WebGL) show their footprint.
  const [drawn, setDrawn] = useState<Set<string>>(() => new Set())
  const onDrawn = useCallback((id: string, ok: boolean) => setDrawn((d) => {
    if (d.has(id) === ok) return d
    const next = new Set(d)
    if (ok) next.add(id)
    else next.delete(id)
    return next
  }), [])
  const heat = useMemo(() => (cells ?? []).filter((c) => cellValue(c, metric) > 0), [cells, metric])
  const dots = live ?? []
  const models = layout?.models ?? []
  const icons = layout?.icons ?? []
  const layoutPoints = useMemo(() => [...models.flatMap((m) => m.footprint), ...icons], [models, icons])
  const bounds = mapBounds(parcels, baseParcel, [...heat, ...dots, ...layoutPoints])
  const { height, px, py } = toSvg(bounds, W)
  const k = W / (bounds.maxX - bounds.minX) // px per metre
  const tiles = parcelRects(parcels, baseParcel)
  const max = Math.max(0, ...heat.map((c) => cellValue(c, metric)))
  const h = hover?.kind === 'cell' ? heat[hover.i] : null
  const metricLabel = metric === 'dwell' ? 'Time spent' : 'Visits'
  const tileFont = Math.max(8, Math.min(12, (k * 16) / 5))
  const renderable = webgl ? models.filter((m) => m.src) : []
  const iconSize = Math.max(12, Math.min(18, k * 1.2))

  const summary = [
    `Map of ${tiles.length || 1} parcel tile${tiles.length === 1 ? '' : 's'}`,
    layout && (models.length || icons.length) && `the scene's layout from above: ${models.length} model${models.length === 1 ? '' : 's'} and ${icons.length} other element${icons.length === 1 ? '' : 's'}`,
    cells && `${heat.length} heat cells by ${metricLabel.toLowerCase()}${max ? `, max ${fmt(max, metric)}` : ''}`,
    live && `${dots.length} visitor${dots.length === 1 ? '' : 's'} here now`,
  ].filter(Boolean).join('; ')

  const nameAt = (name: string, x: number, z: number) => setHover({ kind: 'name', name, left: (px(x) / W) * 100, top: (py(z) / height) * 100 })

  return (
    <figure className="relative m-0">
      <div className="relative" style={{ aspectRatio: `${W} / ${height}` }} onPointerLeave={() => setHover(null)}>
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
        {renderable.length > 0 && (
          <BirdsEyeModels
            bounds={bounds}
            models={renderable}
            onDrawn={onDrawn}
            onHover={(name, left, top) => setHover(name ? { kind: 'name', name, left, top } : null)}
          />
        )}
        <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={summary} className="pointer-events-none absolute inset-0 block h-full w-full">
          {models.filter((m) => !drawn.has(m.id)).map((m) => (
            <polygon
              key={m.id}
              points={m.footprint.map((p) => `${px(p.x)},${py(p.z)}`).join(' ')}
              strokeWidth={1}
              className="pointer-events-auto"
              style={{ fill: 'rgba(138,145,156,0.25)', stroke: 'var(--chart-text-muted)' }}
              onPointerEnter={() => {
                const cx = m.footprint.reduce((a, p) => a + p.x, 0) / m.footprint.length
                const cz = Math.max(...m.footprint.map((p) => p.z))
                nameAt(m.name, cx, cz)
              }}
            />
          ))}
          <g opacity={models.length ? 0.8 : 1}>
            {heat.map((c, i) => (
              <rect
                key={`${c.x},${c.z}`}
                x={px(c.x)} y={py(c.z + 1)} width={k} height={k}
                shapeRendering="crispEdges"
                className="pointer-events-auto"
                style={{ fill: `var(--heat-${colourStep(cellValue(c, metric), max)})` }}
                onPointerEnter={() => setHover({ kind: 'cell', i })}
              />
            ))}
          </g>
          {h && (
            <rect x={px(h.x)} y={py(h.z + 1)} width={k} height={k} fill="none" strokeWidth={1.5} style={{ stroke: 'var(--chart-text)' }} />
          )}
          {icons.map((ic) => (
            <g
              key={ic.id}
              transform={`translate(${px(ic.x)} ${py(ic.z)})`}
              className="pointer-events-auto"
              onPointerEnter={() => nameAt(`${ic.name} (${iconFor(ic.type).label.toLowerCase()})`, ic.x, ic.z)}
            >
              <rect x={-iconSize / 2} y={-iconSize / 2} width={iconSize} height={iconSize} rx={3} strokeWidth={1} style={{ fill: 'var(--chart-surface)', stroke: 'var(--chart-text-muted)' }} />
              <text textAnchor="middle" dy="0.35em" fontSize={iconSize * 0.6} style={{ fill: 'var(--chart-text)' }}>{iconFor(ic.type).glyph}</text>
            </g>
          ))}
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
        {hover?.kind === 'name' && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 rounded-md bg-gray-800 px-2 py-1 text-xs text-white shadow-lg ring-1 ring-white/10 whitespace-nowrap"
            style={{ left: `${hover.left}%`, top: `${hover.top}%`, transform: hover.left > 50 ? 'translate(calc(-100% - 8px), -100%)' : 'translate(8px, -100%)' }}
          >
            {hover.name}
          </div>
        )}
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
          {icons.length > 0 && <span>Hover a model or icon for its name</span>}
        </figcaption>
      )}
    </figure>
  )
}
