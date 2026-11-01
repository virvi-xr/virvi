'use client'
import { STEP_LABELS, type Step } from '@/lib/studio'

/** The preview's steps: any can be opened at any time, and none has to be. */
export default function Steps({ steps, current, onPick }: { steps: Step[]; current: Step; onPick: (step: Step) => void }) {
  return (
    <div role="tablist" aria-label="Steps" className="flex flex-wrap gap-1 border-b border-gray-800 p-2">
      {steps.map((s, i) => (
        <button key={s} type="button" role="tab" aria-selected={current === s} onClick={() => onPick(s)}
          className={`flex shrink-0 items-center gap-1.5 rounded px-3 py-1.5 text-sm ${current === s ? 'bg-white/[0.08] text-white' : 'text-gray-400 hover:text-white'}`}>
          <span className="font-mono text-xs text-gray-500">{i + 1}</span>
          {STEP_LABELS[s]}
        </button>
      ))}
    </div>
  )
}
