'use client'
import { useEffect, useState } from 'react'
import { formatElapsed, typicalHint, type WaitStep } from '@/lib/studio-wait'

/**
 * The wait before the agent's first progress line: each step with a tick when done, a spinner while current and dimmed
 * before, the time since the prompt was sent, and the usual wait when the server knows it.
 */
export default function WaitSteps({ steps, since, typicalSec }: { steps: WaitStep[]; since: number; typicalSec?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const hint = typicalHint(typicalSec)
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
      <p className="mt-1.5 text-xs text-gray-500" aria-live="off">
        <span className="tabular-nums">{formatElapsed((now - since) / 1000)}</span>
        {hint && <span> · {hint}</span>}
      </p>
    </div>
  )
}
