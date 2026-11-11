'use client'
// The heatmap's bird's-eye layout (LIV-85): the linked scene's models rendered straight down under the heat (falling
// back to their footprints), and its other elements as small icons, each named on hover. Layers for ParcelMap.
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MapLayers } from './ParcelMap'
import type { PlacedIcon, PlacedModel } from '@/lib/analytics/layout'
import { iconFor } from '@/lib/analytics/icons'
import { hasWebGL } from '@/lib/webgl'

// three.js: loaded only for a linked scene with models.
const BirdsEyeModels = dynamic(() => import('./BirdsEyeModels'), { ssr: false })

type NameHover = { name: string; left: number; top: number }

export function useBirdsEyeLayers(placed: { models: PlacedModel[]; icons: PlacedIcon[] } | null): MapLayers | undefined {
  const [webgl, setWebgl] = useState(false)
  useEffect(() => setWebgl(hasWebGL()), [])
  const [hover, setHover] = useState<NameHover | null>(null)
  // Models the top-down render has drawn; the rest (loading, failed, no GLB, no WebGL) show their footprint.
  const [drawn, setDrawn] = useState<Set<string>>(() => new Set())
  const onDrawn = useCallback((id: string, ok: boolean) => setDrawn((d) => {
    if (d.has(id) === ok) return d
    const next = new Set(d)
    if (ok) next.add(id)
    else next.delete(id)
    return next
  }), [])
  const onModelHover = useCallback((name: string | null, left: number, top: number) => setHover(name ? { name, left, top } : null), [])
  const models = placed?.models
  const icons = placed?.icons
  const renderable = useMemo(() => (webgl && models ? models.filter((m) => m.src) : []), [webgl, models])
  const points = useMemo(() => [...(models ?? []).flatMap((m) => m.footprint), ...(icons ?? [])], [models, icons])
  if (!models || !icons || (!models.length && !icons.length)) return undefined

  return {
    points,
    heatOpacity: models.length ? 0.8 : 1,
    summary: `the scene's layout from above: ${models.length} model${models.length === 1 ? '' : 's'} and ${icons.length} other element${icons.length === 1 ? '' : 's'}`,
    caption: <span>Hover a model or icon for its name</span>,
    onLeave: () => setHover(null),
    canvas: (g) => renderable.length > 0 && <BirdsEyeModels bounds={g.bounds} models={renderable} onDrawn={onDrawn} onHover={onModelHover} />,
    belowHeat: (g) => models.filter((m) => !drawn.has(m.id)).map((m) => (
      <polygon
        key={m.id}
        points={m.footprint.map((p) => `${g.px(p.x)},${g.py(p.z)}`).join(' ')}
        strokeWidth={1}
        className="pointer-events-auto"
        style={{ fill: 'rgba(138,145,156,0.25)', stroke: 'var(--chart-text-muted)' }}
        onPointerEnter={() => {
          const x = m.footprint.reduce((a, p) => a + p.x, 0) / m.footprint.length
          const z = Math.max(...m.footprint.map((p) => p.z))
          setHover({ name: m.name, left: (g.px(x) / g.W) * 100, top: (g.py(z) / g.height) * 100 })
        }}
      />
    )),
    aboveHeat: (g) => {
      const size = Math.max(12, Math.min(18, g.k * 1.2))
      return icons.map((ic) => (
        <g
          key={ic.id}
          transform={`translate(${g.px(ic.x)} ${g.py(ic.z)})`}
          className="pointer-events-auto"
          onPointerEnter={() => setHover({ name: `${ic.name} (${iconFor(ic.type).label.toLowerCase()})`, left: (g.px(ic.x) / g.W) * 100, top: (g.py(ic.z) / g.height) * 100 })}
        >
          <rect x={-size / 2} y={-size / 2} width={size} height={size} rx={3} strokeWidth={1} style={{ fill: 'var(--chart-surface)', stroke: 'var(--chart-text-muted)' }} />
          <text textAnchor="middle" dy="0.35em" fontSize={size * 0.6} style={{ fill: 'var(--chart-text)' }}>{iconFor(ic.type).glyph}</text>
        </g>
      ))
    },
    tooltip: hover && (
      <div
        role="status"
        className="pointer-events-none absolute z-10 rounded-md bg-gray-800 px-2 py-1 text-xs text-white shadow-lg ring-1 ring-white/10 whitespace-nowrap"
        style={{ left: `${hover.left}%`, top: `${hover.top}%`, transform: hover.left > 50 ? 'translate(calc(-100% - 8px), -100%)' : 'translate(8px, -100%)' }}
      >
        {hover.name}
      </div>
    ),
  }
}
