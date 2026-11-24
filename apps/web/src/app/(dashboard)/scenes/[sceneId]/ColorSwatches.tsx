'use client'
import { FRAME_SWATCHES } from '@virvixr/shared'

/**
 * A colour picked from the frame swatches or any colour (#rrggbb). Frames (LIV-129) and giveaway kiosks' booth colours
 * use it.
 */
export function ColorSwatches({ value, onChange, label = 'Colour' }: { value: string; onChange: (hex: string) => void; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="text-xs text-gray-500">{label}</span>
      {FRAME_SWATCHES.map((s) => (
        <button key={s.color} type="button" title={s.label} aria-label={s.label} aria-pressed={value === s.color}
          onClick={() => onChange(s.color)}
          className={`h-6 w-6 rounded border ${value === s.color ? 'border-blue-400 ring-2 ring-blue-500' : 'border-gray-600'}`}
          style={{ backgroundColor: s.color }} />
      ))}
      <label className="flex items-center gap-1 text-xs text-gray-500">Any colour
        <input type="color" value={value} onChange={(e) => onChange(e.target.value.toLowerCase())} aria-label={`${label}: any colour`}
          className="h-6 w-8 cursor-pointer rounded border border-gray-700 bg-gray-950" />
      </label>
    </div>
  )
}
