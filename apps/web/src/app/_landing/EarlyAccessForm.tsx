'use client'
import { useState } from 'react'
import { submitAdvertiserLead } from '@/lib/advertiser-leads'
import { siteLinks } from '@/lib/site'
import { useDialog } from '@/lib/use-dialog'

const EMPTY = { email: '', name: '', company: '', website: '', message: '', nickname: '' }

const inputClass = 'w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500'

/** Advertiser early-access sign-up, shown as a modal from "Advertise with Virvi". */
export function EarlyAccessForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const { privacy } = siteLinks()

  const dialog = useDialog(open, onClose)

  if (!open) return null

  const set = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await submitAdvertiserLead({ ...form, consent: true })
      setDone(true)
      setForm(EMPTY)
    } catch (err: any) {
      // Keep everything they typed so they can try again
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="early-access-title"
        className="relative corner-notch max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-blue-700 bg-gray-900 p-6 sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={onClose} aria-label="Close" className="absolute right-4 top-4 text-gray-500 hover:text-white">✕</button>
        <p className="mb-2 text-sm font-medium text-blue-300">Early access</p>
        <h2 id="early-access-title" className="mb-2 text-2xl font-bold">Advertise with Virvi</h2>
        {done ? (
          <>
            <p className="mb-6 text-gray-300">Thanks — we'll be in touch soon.</p>
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-700 px-4 py-2 font-medium hover:bg-gray-800">Close</button>
          </>
        ) : (
          <>
            <p className="mb-6 text-sm text-gray-400">Tell us what you'd like to advertise. We'll set up your first campaign with you.</p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="ea-email" className="mb-1 block text-sm text-gray-400">Email</label>
                <input id="ea-email" data-autofocus type="email" required value={form.email} onChange={set('email')} className={inputClass} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="ea-name" className="mb-1 block text-sm text-gray-400">Name</label>
                  <input id="ea-name" type="text" maxLength={200} value={form.name} onChange={set('name')} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="ea-company" className="mb-1 block text-sm text-gray-400">Company or project</label>
                  <input id="ea-company" type="text" maxLength={200} value={form.company} onChange={set('company')} className={inputClass} />
                </div>
              </div>
              <div>
                <label htmlFor="ea-website" className="mb-1 block text-sm text-gray-400">Website</label>
                <input id="ea-website" type="text" inputMode="url" maxLength={200} placeholder="brand.com" value={form.website} onChange={set('website')} className={inputClass} />
              </div>
              <div>
                <label htmlFor="ea-message" className="mb-1 block text-sm text-gray-400">What would you like to advertise?</label>
                <textarea id="ea-message" rows={3} maxLength={2000} value={form.message} onChange={set('message')} className={inputClass} />
              </div>
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
              <p className="text-xs text-gray-500">
                We'll only use this to contact you about advertising on Virvi.
                {privacy && <> <a href={privacy} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Privacy</a></>}
              </p>
              {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
              <button type="submit" disabled={submitting} className="clip-corner w-full bg-accent py-3 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50">
                {submitting ? 'Sending…' : 'Request early access'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
