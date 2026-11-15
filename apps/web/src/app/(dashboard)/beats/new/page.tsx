'use client'
// New BEAT (LIV-11): the form, then the review step with the price, then payment. `?scene=` picks that scene.
import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useApi } from '@/lib/api'
import { beatBody, beatEditBody, beatFieldError, beatHref, blankBeat, type BeatAvailability, type BeatInput, type FieldError } from '@/lib/beats'
import { PageHeader, Skeleton } from '@/components/ui'
import { BeatsGate } from '@/components/beats/BeatBits'
import { BeatForm } from '@/components/beats/BeatForm'
import { BeatReview } from '@/components/beats/BeatReview'

export default function NewBeatPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <div className="mx-auto max-w-3xl">
        <BeatsGate>{(a) => <NewBeat availability={a} />}</BeatsGate>
      </div>
    </Suspense>
  )
}

function NewBeat({ availability }: { availability: BeatAvailability }) {
  const api = useApi()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [input, setInput] = useState<BeatInput>(() => blankBeat(new Date(), searchParams.get('scene')))
  // The draft the review step prices; Back and Review again update it rather than make another
  const [draftId, setDraftId] = useState<string | null>(null)
  const [step, setStep] = useState<'form' | 'review'>('form')
  const [error, setError] = useState<FieldError | null>(null)
  const [busy, setBusy] = useState(false)

  // While the network isn't set up, the gate's notice above says why; there is no form to show
  if (availability.reason === 'not_configured') return null
  if (!availability.canCreate) return <p className="text-sm text-gray-400">BEATs aren&apos;t open to everyone yet.</p>

  const review = async (f: BeatInput) => {
    setInput(f); setBusy(true); setError(null)
    try {
      const b = draftId ? await api.updateBeat(draftId, beatEditBody(f, 'draft')) : await api.createBeat(beatBody(f))
      setDraftId(b.id)
      setStep('review')
    } catch (err) { setError(beatFieldError(err)) }
    setBusy(false)
  }

  return (
    <>
      <PageHeader crumbs={[{ label: 'BEATs', href: '/beats' }, 'New BEAT']} title="New BEAT"
        subtitle="Visitors who stay long enough claim one, and it's sent to their wallet." />
      {step === 'review' && draftId
        ? <BeatReview beatId={draftId} test={availability.test} onPaid={() => router.push(beatHref(draftId))} onBack={() => setStep('form')} />
        : <BeatForm initial={input} error={error} busy={busy} submitLabel="Review" onSubmit={review} />}
    </>
  )
}
