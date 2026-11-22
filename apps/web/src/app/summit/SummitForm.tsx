'use client'
import { useEffect, useState } from 'react'
import type { SummitInterest, SummitJoinAs } from '@virvixr/shared'
import { EMPTY_SUMMIT_FORM, SUMMIT_OFFERINGS, signupFromForm, submitSummitSignup, summitDoneLine, summitRefFromSearch, type SummitFormState } from '@/lib/summit'
import { siteLinks } from '@/lib/site'

const inputClass = 'w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-accent'
const labelClass = 'mb-1 block text-sm text-gray-400'
const choiceClass = 'flex cursor-pointer items-start gap-3 rounded-lg border border-gray-800 bg-gray-900 p-3 has-[:checked]:border-accent'

const JOIN_CHOICES: { value: SummitJoinAs; label: string; hint: string }[] = [
  { value: 'online', label: 'Online', hint: 'The stream and the Virvi worlds' },
  { value: 'in_person', label: 'In person', hint: 'Ask for a place in the studio in Melbourne, Florida' },
  { value: 'watch_party', label: 'Host a watch party', hint: 'We’ll send you a host kit' },
]

/** "You’re on the list." and what happens next. */
export function SummitDone({ joinAs }: { joinAs: SummitJoinAs }) {
  return (
    <div role="status">
      <h3 className="text-2xl font-semibold text-white">You’re on the list.</h3>
      <p className="mt-2 text-gray-300">{summitDoneLine(joinAs)}</p>
    </div>
  )
}

/** The Summit sign-up form, at #sign-up. */
export function SummitForm() {
  const [form, setForm] = useState<SummitFormState>(EMPTY_SUMMIT_FORM)
  const [consent, setConsent] = useState(false)
  const [ref, setRef] = useState<string | undefined>(undefined)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<SummitJoinAs | null>(null)
  const { privacy } = siteLinks()

  // A static export: the ?ref= is read in the browser
  useEffect(() => setRef(summitRefFromSearch(window.location.search)), [])

  const set = (key: 'email' | 'name' | 'partySize' | 'city' | 'expectedGuests' | 'nickname') =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }))
  const toggleInterest = (id: SummitInterest) =>
    setForm((f) => ({ ...f, interests: f.interests.includes(id) ? f.interests.filter((i) => i !== id) : [...f.interests, id] }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const joinAs = form.joinAs as SummitJoinAs
      await submitSummitSignup(signupFromForm(form, ref))
      setDone(joinAs)
    } catch (err) {
      // Keep everything they typed so they can try again
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section id="sign-up" aria-labelledby="summit-sign-up" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-12 sm:px-6">
      <div className="relative corner-notch mx-auto max-w-2xl rounded-xl border border-blue-700 bg-gray-900 p-6 sm:p-8">
        <p className="text-sm font-medium uppercase tracking-wider text-accent">Sign up</p>
        <h2 id="summit-sign-up" className="mt-2 text-3xl font-semibold tracking-tight text-white">Save your spot</h2>
        {done ? (
          <div className="mt-6"><SummitDone joinAs={done} /></div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="su-email" className={labelClass}>Email</label>
                <input id="su-email" type="email" required autoComplete="email" maxLength={254} value={form.email} onChange={set('email')} className={inputClass} />
              </div>
              <div>
                <label htmlFor="su-name" className={labelClass}>Name</label>
                <input id="su-name" type="text" required autoComplete="name" maxLength={200} value={form.name} onChange={set('name')} className={inputClass} />
              </div>
            </div>

            <fieldset>
              <legend className={labelClass}>How will you join?</legend>
              <div className="grid gap-2">
                {JOIN_CHOICES.map((c) => (
                  <label key={c.value} className={choiceClass}>
                    <input
                      type="radio"
                      name="joinAs"
                      value={c.value}
                      required
                      checked={form.joinAs === c.value}
                      onChange={() => setForm((f) => ({ ...f, joinAs: c.value }))}
                      className="mt-1 accent-cyan-400"
                    />
                    <span>
                      <span className="block font-medium text-white">{c.label}</span>
                      <span className="block text-sm text-gray-400">{c.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {form.joinAs === 'in_person' && (
              <div>
                <label htmlFor="su-party" className={labelClass}>How many of you, including you?</label>
                <select id="su-party" value={form.partySize} onChange={set('partySize')} className={`${inputClass} sm:w-40`}>
                  {[1, 2, 3, 4].map((n) => <option key={n} value={String(n)}>{n}</option>)}
                </select>
                <p className="mt-1 text-xs text-gray-500">The room is limited. We’ll email you to confirm, with the full address.</p>
              </div>
            )}

            {form.joinAs === 'watch_party' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="su-city" className={labelClass}>City</label>
                  <input id="su-city" type="text" required maxLength={200} value={form.city} onChange={set('city')} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="su-guests" className={labelClass}>Expected guests (optional)</label>
                  <input id="su-guests" type="number" inputMode="numeric" min={1} max={500} step={1} value={form.expectedGuests} onChange={set('expectedGuests')} className={inputClass} />
                </div>
              </div>
            )}

            <fieldset>
              <legend className={labelClass}>What are you most interested in? (optional)</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {SUMMIT_OFFERINGS.map((o) => (
                  <label key={o.id} className="flex cursor-pointer items-center gap-3 text-gray-300">
                    <input
                      type="checkbox"
                      name="interests"
                      value={o.id}
                      checked={form.interests.includes(o.id)}
                      onChange={() => toggleInterest(o.id)}
                      className="accent-cyan-400"
                    />
                    {o.name}
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Honeypot: hidden from people, filled by bots */}
            <input
              type="text"
              name="nickname"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={form.nickname}
              onChange={set('nickname')}
              className="absolute -left-[9999px] h-px w-px opacity-0"
            />

            <label className="flex cursor-pointer items-start gap-3 text-sm text-gray-300">
              <input type="checkbox" required checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-cyan-400" />
              <span>
                Email me about the Virvi Summit. You can unsubscribe at any time.{' '}
                <a href={privacy} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline underline-offset-2 hover:text-blue-300">Privacy</a>
              </span>
            </label>

            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
            <button type="submit" disabled={submitting} className="clip-corner w-full bg-accent py-3 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50">
              {submitting ? 'Sending…' : 'Sign up'}
            </button>
          </form>
        )}
      </div>
    </section>
  )
}
