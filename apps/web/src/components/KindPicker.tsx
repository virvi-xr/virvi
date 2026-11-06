'use client'
import { KIND_CHOICES, type StudioKind } from '@/lib/studio'

/** What are you making? The Studio's kind chips, shared by the new-design form and the public try page. */
export function KindPicker({ value, onChange, name = 'kind' }: { value: StudioKind; onChange: (k: StudioKind) => void; name?: string }) {
  return (
    <div role="radiogroup" className="inline-flex rounded-md border border-gray-800 p-0.5 text-sm">
      {KIND_CHOICES.map(([k, label]) => (
        <label key={k} className={`cursor-pointer rounded px-3 py-1.5 ${value === k ? 'bg-white/[0.06] text-white' : 'text-gray-400 hover:text-white'}`}>
          <input type="radio" name={name} className="sr-only" value={k} checked={value === k} onChange={() => onChange(k)} />
          {label}
        </label>
      ))}
    </div>
  )
}
