'use client'
import { useEffect, useState } from 'react'
import { CheckIcon } from '@/components/icons'
import type { LineState, Phase } from '@/lib/wizard/run'

/** Upload and Decentraland's check are one request; after this long uploading, say it's being checked. */
const CHECKING_AFTER_MS = 5_000

/** The phase to show: `uploading` turns into `checking` once it has lasted a few seconds. */
export function useShownPhase(phase: Phase): Phase {
  const [uploadingAt, setUploadingAt] = useState<number | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (phase !== 'uploading') return setUploadingAt(null)
    setUploadingAt(Date.now())
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [phase])
  return phase === 'uploading' && uploadingAt !== null && Date.now() - uploadingAt > CHECKING_AFTER_MS ? 'checking' : phase
}

/** The deploy's plain steps (from `progressLines`): the wizard, the deploy page and the publish page. */
export function ProgressLines({ lines }: { lines: Array<{ label: string; state: LineState }> }) {
  return (
    <ol className="space-y-1.5" aria-label="Deploy progress">
      {lines.map((l) => (
        <li key={l.label} className={`flex items-center gap-2 ${l.state === 'todo' ? 'text-gray-500' : l.state === 'failed' ? 'text-red-300' : l.state === 'active' ? 'text-white' : 'text-gray-400'}`}>
          <span className="flex h-4 w-4 items-center justify-center">
            {l.state === 'done' ? <CheckIcon size={14} className="text-green-400" />
              : l.state === 'active' ? <span className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
              : l.state === 'failed' ? <span className="h-2 w-2 rounded-full bg-red-400" />
              : <span className="h-1.5 w-1.5 rounded-full bg-gray-700" />}
          </span>
          {l.label}
        </li>
      ))}
    </ol>
  )
}
