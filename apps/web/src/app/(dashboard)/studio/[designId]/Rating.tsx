'use client'
import { useState } from 'react'
import { useApi } from '@/lib/api'
import { refusalMessage, type Quote } from '@/lib/studio'
import {
  NOTE_MAX, RATING_TAGS, THANKS, TRY_AGAIN, TRY_AGAIN_NOTE, UP_PROMPT, finalizeThis, ratingBody, ratingSummary, type StudioRevision,
} from '@/lib/studio-ratings'

type Props = {
  designId: string
  rev: StudioRevision
  /** The owner rates; support only sees the owner's rating. */
  canRate: boolean
  quote: Quote | null
  /** A prompt can be sent now (nothing running, prompts allowed). */
  canPrompt: boolean
  onChanged: () => Promise<void>
  onFinalize: (categories: string[]) => void
  onKeepGoing: () => void
}

const pill = (on: boolean) => `rounded-md border px-2 py-1 text-sm ${on ? 'border-blue-400 bg-blue-500/15 text-white' : 'border-gray-800 text-gray-400 hover:text-white'} disabled:opacity-50`

/** 👍 / 👎 under an agent reply that changed pieces, and what follows each (LIV-142). */
export default function Rating({ designId, rev, canRate, quote, canPrompt, onChanged, onFinalize, onKeepGoing }: Props) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What follows a rating given here: the 👍 offer, the 👎 form, then the thanks (dismissed: nothing)
  const [step, setStep] = useState<'up' | 'down' | 'thanks' | null>(null)
  const [tags, setTags] = useState<string[]>(rev.tags)
  const [note, setNote] = useState(rev.note ?? '')

  if (!canRate) {
    const said = ratingSummary(rev)
    return said ? <p className="mt-2 text-xs text-gray-500">{said}</p> : null
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await onChanged()
      return true
    } catch (err) {
      setError(refusalMessage(err as never, new Date()).text || 'That didn’t work. Try again.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const rate = async (rating: 'up' | 'down') => {
    if (rev.rating === rating && step === null) {
      // the same thumb again clears it
      await run(() => api.clearStudioRating(designId, rev.jobId))
      return
    }
    if (rating === 'up') {
      if (await run(() => api.rateStudioRevision(designId, rev.jobId, ratingBody('up')))) setStep('up')
    } else {
      // saved at once, with whatever tags it had; the form adds what's wrong
      if (await run(() => api.rateStudioRevision(designId, rev.jobId, ratingBody('down', tags, note)))) setStep('down')
    }
  }

  const sendDetails = async () => {
    if (await run(() => api.rateStudioRevision(designId, rev.jobId, ratingBody('down', tags, note)))) setStep('thanks')
  }
  const tryAgain = () => run(() => api.tryStudioRevisionAgain(designId, rev.jobId)).then((ok) => { if (ok) setStep(null) })
  const finalizable = finalizeThis(rev.categories, quote)

  return (
    <div className="mt-2 border-t border-gray-800 pt-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">How did this turn out?</span>
        <button type="button" aria-pressed={rev.rating === 'up'} aria-label="Thumbs up" disabled={busy} onClick={() => rate('up')} className={pill(rev.rating === 'up')}>👍</button>
        <button type="button" aria-pressed={rev.rating === 'down'} aria-label="Thumbs down" disabled={busy} onClick={() => rate('down')} className={pill(rev.rating === 'down')}>👎</button>
      </div>

      {step === 'up' && rev.rating === 'up' && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="status">
          <span className="text-gray-300">{UP_PROMPT}</span>
          {finalizable && (
            <button type="button" onClick={() => { setStep(null); onFinalize(finalizable) }} className="rounded-md bg-blue-600 px-3 py-1 text-white hover:bg-blue-500">Finalize this</button>
          )}
          <button type="button" onClick={() => { setStep(null); onKeepGoing() }} className="rounded-md bg-gray-800 px-3 py-1 hover:bg-gray-700">Keep going</button>
          <button type="button" aria-label="Dismiss" onClick={() => setStep(null)} className="text-gray-500 hover:text-white">✕</button>
        </div>
      )}

      {step === 'down' && rev.rating === 'down' && (
        <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); sendDetails() }}>
          <fieldset>
            <legend className="mb-1 text-xs text-gray-400">What’s wrong? (optional)</legend>
            <div className="flex flex-wrap gap-1.5">
              {RATING_TAGS.map(([key, label]) => (
                <label key={key} className={`cursor-pointer ${pill(tags.includes(key))}`}>
                  <input type="checkbox" className="sr-only" checked={tags.includes(key)}
                    onChange={() => setTags((t) => (t.includes(key) ? t.filter((x) => x !== key) : [...t, key]))} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="sr-only">Tell us more (optional)</span>
            <input type="text" value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder="Tell us more (optional)"
              className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-white outline-none focus:border-blue-400" />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-md bg-blue-600 px-3 py-1 text-white hover:bg-blue-500 disabled:opacity-50">Send</button>
            <button type="button" onClick={() => setStep('thanks')} className="rounded-md bg-gray-800 px-3 py-1 hover:bg-gray-700">Skip</button>
          </div>
        </form>
      )}

      {(step === 'thanks' || (step === null && rev.rating === 'down' && rev.tryAgain === 'available')) && rev.rating === 'down' && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="status">
          {step === 'thanks' && <span className="text-gray-300">{THANKS}</span>}
          {rev.tryAgain === 'available' && (
            <>
              <button type="button" disabled={busy || !canPrompt} onClick={tryAgain}
                className="rounded-md border border-blue-500/40 px-3 py-1 text-blue-200 hover:bg-blue-500/10 disabled:opacity-50">{TRY_AGAIN}</button>
              <span className="text-xs text-gray-500">{TRY_AGAIN_NOTE}</span>
            </>
          )}
          {step === 'thanks' && <button type="button" aria-label="Dismiss" onClick={() => setStep(null)} className="text-gray-500 hover:text-white">✕</button>}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-amber-300" role="alert">{error}</p>}
    </div>
  )
}
