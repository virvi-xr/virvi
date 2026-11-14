'use client'
// Small shared BEAT pieces (LIV-11): the status and test badges, and the gate that hides everything while BEATs are off.
import type { ReactNode } from 'react'
import { Badge, Skeleton, type Tone } from '@/components/ui'
import { BEAT_FROZEN_NOTE, BEAT_TEST_BADGE, BEATS_UNAVAILABLE, STATUS_LABELS, type BeatAvailability, type BeatStatus } from '@/lib/beats'
import { useBeatAvailability } from '@/lib/use-beats'

const TONE: Record<BeatStatus, Tone> = { draft: 'neutral', paid: 'info', live: 'success', ended: 'neutral', cancelled: 'danger' }

export function BeatBadges({ status, test }: { status: BeatStatus; test: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone={TONE[status]}>{STATUS_LABELS[status]}</Badge>
      {test && <Badge tone="warning">{BEAT_TEST_BADGE}</Badge>}
    </span>
  )
}

/** On a frozen BEAT's page: Edit is never offered then, so this says why. */
export function FrozenNote({ frozen }: { frozen: boolean }) {
  return frozen ? <p className="text-sm text-gray-400">{BEAT_FROZEN_NOTE}</p> : null
}

/** Renders `children` with the availability once BEATs are on; while they're off, says so and nothing else. */
export function BeatsGate({ children }: { children: (a: BeatAvailability) => ReactNode }) {
  const a = useBeatAvailability()
  if (!a) return <Skeleton />
  if (!a.enabled) return <p className="text-sm text-gray-400">{BEATS_UNAVAILABLE}</p>
  return <>{children(a)}</>
}
