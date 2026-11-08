'use client'
import { useEffect, useState } from 'react'
import { FRAME_STYLE_HINTS, FRAME_SWATCHES, FRAME_THICKNESS, type FrameSettings } from '@virvixr/shared'
import { FRAME_CHOICES, frameChoiceOf, frameFormOf, frameSaved, frameSummary, pickFrameChoice, thicknessFrom } from '@/lib/frames'

const BTN = 'rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50'

/**
 * A frame around the picture or screen (LIV-129): None, Thin, Classic or Gallery, its colour and thickness.
 * Every copy of the item gets it; it shows in-world as soon as it's saved.
 */
export function FrameField({ properties, onSave }: {
  properties: Record<string, any>
  /** Saves the element's properties whole (the frame with the rest). */
  onSave: (properties: Record<string, unknown>) => Promise<void> | void
}) {
  const saved = properties.frame
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<FrameSettings>(() => frameFormOf(saved))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const savedKey = JSON.stringify(saved ?? null)
  useEffect(() => { if (!editing) setForm(frameFormOf(saved)) }, [savedKey, editing]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const r = frameSaved(properties, form)
    if (!r.ok) return setError(r.error)
    setBusy(true)
    setError('')
    try {
      await onSave(r.properties)
      setEditing(false)
    } catch (e: any) {
      setError(e?.body?.message || e?.message || 'Could not save the frame')
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <span>Frame: <span className="text-gray-200">{frameSummary(saved)}</span></span>
        <button type="button" className={BTN} onClick={() => { setForm(frameFormOf(saved)); setError(''); setEditing(true) }}>Edit</button>
      </div>
    )
  }

  const choice = frameChoiceOf(form)
  return (
    <div className="space-y-3 rounded-md border border-gray-800 bg-gray-950 p-3 text-sm text-gray-300">
      <div className="space-y-1">
        <div role="radiogroup" aria-label="Frame style" className="flex flex-wrap gap-1">
          {FRAME_CHOICES.map((c) => (
            <button key={c.choice} type="button" role="radio" aria-checked={choice === c.choice}
              onClick={() => setForm((f) => pickFrameChoice(f, c.choice))}
              className={`rounded-md border px-3 py-1 text-xs ${choice === c.choice ? 'border-blue-500 bg-blue-600/20 text-white' : 'border-gray-700 text-gray-300 hover:border-gray-500'}`}>
              {c.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500">{form.enabled ? FRAME_STYLE_HINTS[form.style] : 'No frame: the picture shows on its own, as before.'}</p>
      </div>
      {form.enabled && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500">Colour</span>
            {FRAME_SWATCHES.map((s) => (
              <button key={s.color} type="button" title={s.label} aria-label={s.label} aria-pressed={form.color === s.color}
                onClick={() => setForm((f) => ({ ...f, color: s.color }))}
                className={`h-6 w-6 rounded border ${form.color === s.color ? 'border-blue-400 ring-2 ring-blue-500' : 'border-gray-600'}`}
                style={{ backgroundColor: s.color }} />
            ))}
            <label className="flex items-center gap-1 text-xs text-gray-500">Any colour
              <input type="color" value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value.toLowerCase() }))}
                className="h-6 w-8 cursor-pointer rounded border border-gray-700 bg-gray-950" />
            </label>
          </div>
          <label className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500">Thickness</span>
            <input type="range" min={FRAME_THICKNESS.min} max={FRAME_THICKNESS.max} step={FRAME_THICKNESS.step} value={form.thickness}
              onChange={(e) => { const t = thicknessFrom(e.target.value); if (t !== null) setForm((f) => ({ ...f, thickness: t })) }}
              className="w-40 accent-blue-500" />
            <span className="w-10 text-xs text-gray-200">{form.thickness}%</span>
            <span className="text-xs text-gray-500">of the shorter side, so it stays in proportion when you resize</span>
          </label>
        </>
      )}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={busy} onClick={() => void save()}>Save</button>
        <button type="button" className={BTN} onClick={() => { setEditing(false); setError('') }}>Cancel</button>
      </div>
    </div>
  )
}
