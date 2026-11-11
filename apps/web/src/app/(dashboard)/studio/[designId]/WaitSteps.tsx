'use client'
import { useEffect, useState } from 'react'
import { waitProgress, type WaitStep } from '@/lib/studio-wait'

/**
 * The wait before the agent's first progress line: each step with a tick when done, a spinner while current and dimmed
 * before, and a bar of how much of the usual wait is left (the time left, when the server knows the usual wait).
 */
export default function WaitSteps({ steps, since, typicalSec }: { steps: WaitStep[]; since: number; typicalSec?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const { fraction, left } = waitProgress((now - since) / 1000, typicalSec, steps)
  return (
    <div className="not-italic">
      <ol className="space-y-1">
        {steps.map((s) => (
          <li key={s.key} className={`flex items-center gap-2 ${s.state === 'todo' ? 'text-gray-600' : s.state === 'done' ? 'text-gray-400' : 'text-gray-200'}`}
            aria-current={s.state === 'current' ? 'step' : undefined}>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
              {s.state === 'done' ? (
                <svg viewBox="0 0 16 16" className="h-4 w-4 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3.5 8.5l3 3 6-7" /></svg>
              ) : s.state === 'current' ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
              ) : (
                <span className="h-2 w-2 rounded-full border border-gray-600" />
              )}
            </span>
            <span>{s.label}{s.state === 'done' && <span className="sr-only"> (done)</span>}</span>
          </li>
        ))}
      </ol>
      <div className="mt-2 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-gray-800" role="progressbar" aria-label="Getting ready"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} aria-valuetext={left ?? undefined}>
        <div className="h-full rounded-full bg-blue-400 transition-[width] duration-1000 ease-linear" style={{ width: `${fraction * 100}%` }} />
      </div>
      {left && <p className="mt-1 text-xs text-gray-500" aria-live="off">{left}</p>}
    </div>
  )
}
