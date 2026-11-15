'use client'
// Small shared BEAT pieces (LIV-11): the status and test badges, and the gate that hides everything while BEATs are off.
import type { ReactNode } from 'react'
import { Badge, Skeleton, type Tone } from '@/components/ui'
import { BEAT_FROZEN_NOTE, BEAT_TEST_BADGE, BEATS_NETWORK_UNAVAILABLE, BEATS_UNAVAILABLE, STATUS_LABELS, type BeatAvailability, type BeatStatus } from '@/lib/beats'
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

/** While the network isn't set up (`not_configured`): existing BEATs are shown, and this says why nothing can be paid. */
export function BeatsNotice({ a }: { a: BeatAvailability | null }) {
  if (a?.reason !== 'not_configured') return null
  return <p role="status" className="mb-4 rounded-md border border-amber-700 bg-amber-900/30 px-4 py-2 text-sm text-amber-200">{BEATS_NETWORK_UNAVAILABLE}</p>
}

/** BeatsGate's view for a known availability: a skeleton until it is known; while BEATs are off, says so and nothing
 * else; otherwise `children`, under the notice when the network isn't set up. */
export function BeatsGateView({ a, children }: { a: BeatAvailability | null; children: (a: BeatAvailability) => ReactNode }) {
  if (!a) return <Skeleton />
  if (!a.enabled) return <p className="text-sm text-gray-400">{BEATS_UNAVAILABLE}</p>
  return <><BeatsNotice a={a} />{children(a)}</>
}

/** Renders `children` with the availability once BEATs are on; while they're off, says so and nothing else. */
export function BeatsGate({ children }: { children: (a: BeatAvailability) => ReactNode }) {
  return <BeatsGateView a={useBeatAvailability()}>{children}</BeatsGateView>
}
