'use client'
import { DESIGN_CHOICES, type DesignChoice } from '@/lib/studio'

/** What are you making? The Studio's choice chips (Wearable, Emote, Building, Decor), shared by the new-design form and the public try page. */
export function KindPicker({ value, onChange, name = 'kind' }: { value: DesignChoice; onChange: (c: DesignChoice) => void; name?: string }) {
  return (
    <div role="radiogroup" className="inline-flex flex-wrap rounded-md border border-gray-800 p-0.5 text-sm">
      {DESIGN_CHOICES.map(([c, label]) => (
        <label key={c} className={`cursor-pointer rounded px-3 py-1.5 ${value === c ? 'bg-white/[0.06] text-white' : 'text-gray-400 hover:text-white'}`}>
          <input type="radio" name={name} className="sr-only" value={c} checked={value === c} onChange={() => onChange(c)} />
          {label}
        </label>
      ))}
    </div>
  )
}
