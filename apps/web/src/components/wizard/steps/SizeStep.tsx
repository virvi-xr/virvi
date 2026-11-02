'use client'
import { useState, type Dispatch } from 'react'
import { dclBudget, plotParcels, type Plot } from '@virvixr/shared'
import { clampSide, MAX_PLOT_SIDE, plotLabel, PLOT_CHOICES, storageLine } from '@/lib/wizard/helpers'
import { GUIDE_PLOT, stateBudget, type WizardAction, type WizardState } from '@/lib/wizard/state'

const n = (v: number) => v.toLocaleString('en-US')
const plotOf = (width: number, depth: number): Plot => ({ width, depth, base: { x: 0, y: 0 } })

export function SizeStep({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const dcl = state.destinations.dcl
  const current = state.plot ?? (dcl ? null : GUIDE_PLOT)
  const isPreset = (p: Plot | null) => !!p && p.width === p.depth && (PLOT_CHOICES as readonly number[]).includes(p.width)
  const [custom, setCustom] = useState(() => !!current && !isPreset(current))
  const [w, setW] = useState(current?.width ?? 4)
  const [d, setD] = useState(current?.depth ?? 4)

  const setCustomSize = (width: number, depth: number) => {
    setW(width)
    setD(depth)
    dispatch({ type: 'setPlot', plot: plotOf(clampSide(width), clampSide(depth)) })
  }
  const choice = 'rounded-md border px-3 py-2.5 text-left text-sm'
  const on = 'border-blue-400 bg-blue-400/10 text-white'
  const off = 'border-gray-800 bg-gray-950 text-gray-300 hover:border-gray-700'

  const budget = current && dcl ? dclBudget(plotParcels(current).length) : null
  const storage = dcl?.storage
  const room = state.roomSet

  return (
    <div className="space-y-4">
      {!dcl && !room && <p className="text-sm text-gray-400">Used as a guide for placing things. Hyperfy and Virvi AR have no hard edges.</p>}
      {room ? (
        <div className="rounded-md border border-blue-400 bg-blue-400/10 px-3 py-2.5 text-sm">
          <span className="block font-medium text-white">{plotLabel(room.plot)}</span>
          <span className="block text-gray-400">Sized to fit your scan</span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Plot size">
            {PLOT_CHOICES.map((s) => {
              const chosen = !custom && current?.width === s && current?.depth === s
              return (
                <button key={s} type="button" role="radio" aria-checked={chosen} className={`${choice} ${chosen ? on : off}`}
                  onClick={() => { setCustom(false); dispatch({ type: 'setPlot', plot: plotOf(s, s) }) }}>
                  <span className="block font-medium">{s}×{s}</span>
                  <span className="block text-xs text-gray-500">{s * 16} m</span>
                </button>
              )
            })}
            <button type="button" role="radio" aria-checked={custom} className={`${choice} ${custom ? on : off}`}
              onClick={() => { setCustom(true); setCustomSize(w, d) }}>
              <span className="block font-medium">Custom</span>
              <span className="block text-xs text-gray-500">up to {MAX_PLOT_SIDE}×{MAX_PLOT_SIDE}</span>
            </button>
          </div>
          {custom && (
            <div className="flex items-center gap-2 text-sm text-gray-300">
              <label className="flex items-center gap-1.5">
                Width
                <input type="number" min={1} max={MAX_PLOT_SIDE} value={w} onChange={(e) => setCustomSize(Number(e.target.value), d)}
                  className="w-16 rounded-md border border-gray-800 bg-gray-950 px-2 py-1.5 text-white outline-none focus:border-blue-400" />
              </label>
              <span>×</span>
              <label className="flex items-center gap-1.5">
                Depth
                <input type="number" min={1} max={MAX_PLOT_SIDE} value={d} onChange={(e) => setCustomSize(w, Number(e.target.value))}
                  className="w-16 rounded-md border border-gray-800 bg-gray-950 px-2 py-1.5 text-white outline-none focus:border-blue-400" />
              </label>
              <span className="text-gray-500">parcels</span>
            </div>
          )}
        </>
      )}
      {budget && current && (
        <div className="space-y-1 rounded-md border border-gray-800 bg-gray-950 px-3 py-2.5 text-sm text-gray-300">
          <p>
            {current.width * 16} × {current.depth * 16} m fits about <span className="text-white">{n(budget.entities)} items</span>. Decentraland
            recommends staying under <span className="text-white">{n(budget.triangles)} triangles</span>.
          </p>
          {room?.triangles != null && <p className="text-gray-400">Your room uses about {n(room.triangles)} triangles of that.</p>}
          {storage && <p className="text-gray-400">{storageLine(stateBudget(state).bytes.used, storage)}</p>}
        </div>
      )}
      {state.lastDropped > 0 && (
        <p className="text-sm text-yellow-300" role="status">Left out {state.lastDropped} {state.lastDropped === 1 ? 'item' : 'items'} to fit this plot.</p>
      )}
    </div>
  )
}
