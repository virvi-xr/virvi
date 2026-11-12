'use client'
import { useEffect, useState } from 'react'
import { CREDIT_MAX, SHARE_LICENSES, shareLicense } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { REPORT_REASONS, shareErrorMessage } from '@/lib/asset-sharing'

const fieldClass = 'w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-400'

function Shell({ titleId, title, busy, onClose, children }: { titleId: string; title: string; busy: boolean; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="text-gray-500 hover:text-white">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Share a model with other Virvi users (LIV-20): pick a license (each says what it allows), say how to be credited, and
 * confirm the rights. Also changes the license of a model that's already shared.
 */
export function ShareDialog({ asset, onShared, onClose }: { asset: any; onShared: (asset: any) => void; onClose: () => void }) {
  const api = useApi()
  const [license, setLicense] = useState(shareLicense(asset.license)?.id ?? 'cc-by-4.0')
  const [credit, setCredit] = useState(asset.author ?? '')
  const [rights, setRights] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { asset: updated } = await api.shareAsset(asset.id, { license, rightsConfirmed: rights, credit: credit.trim() || undefined })
      onShared(updated)
    } catch (err) {
      setError(shareErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell titleId="share-model-title" title={asset.isPublic ? 'Change how it’s shared' : 'Share with the community'} busy={busy} onClose={onClose}>
      <p className="mb-4 text-sm text-gray-400">
        Shared models show in the Asset Library’s Community view, credited to you, and any Virvi user can add them to their scenes.
        You can make it private again later: scenes that already have it keep it.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">License: what other people may do with it</legend>
          <div className="space-y-2">
            {SHARE_LICENSES.map((l) => (
              <label key={l.id} className={`flex cursor-pointer gap-3 rounded-md border p-3 ${license === l.id ? 'border-blue-400 bg-blue-500/10' : 'border-gray-800 hover:border-gray-700'}`}>
                <input type="radio" name="license" value={l.id} checked={license === l.id} onChange={() => setLicense(l.id)} className="mt-1" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {l.name}
                    {l.url && <> <a href={l.url} target="_blank" rel="noopener noreferrer" className="ml-1 text-xs font-normal text-blue-300 hover:underline" onClick={(e) => e.stopPropagation()}>Full license</a></>}
                  </span>
                  <span className="block text-sm text-gray-400">{l.summary}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">Creative Commons licenses can’t be taken back from people who already have a copy. Changing the license applies from now on.</p>
        </fieldset>
        <div>
          <label htmlFor="share-credit" className="mb-1 block text-sm text-gray-400">Credit as</label>
          <input id="share-credit" type="text" value={credit} maxLength={CREDIT_MAX} onChange={(e) => setCredit(e.target.value)}
            placeholder="Your name, if left empty" className={fieldClass} />
        </div>
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-1" />
          <span>I made this model, or I have the right to share it under this license. It doesn’t show anyone’s home or private information.</span>
        </label>
        {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          <button type="submit" disabled={busy || !rights} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Sharing…' : asset.isPublic ? 'Save' : 'Share'}
          </button>
        </div>
      </form>
    </Shell>
  )
}

/** Report someone's shared model to Virvi. */
export function ReportDialog({ asset, onClose }: { asset: any; onClose: () => void }) {
  const api = useApi()
  const [reason, setReason] = useState('')
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.reportAsset(asset.id, { reason, details: details.trim() || undefined })
      setDone(true)
    } catch (err) {
      setError(shareErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell titleId="report-model-title" title={`Report “${asset.name}”`} busy={busy} onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-300" role="status">Thanks. Virvi support will look at it. For a copyright claim, you can also email support@virvi.io.</p>
          <div className="flex justify-end"><button type="button" onClick={onClose} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Close</button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">What’s wrong?</legend>
            <div className="space-y-1.5">
              {REPORT_REASONS.map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="radio" name="report-reason" value={key} checked={reason === key} onChange={() => setReason(key)} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="report-details" className="mb-1 block text-sm text-gray-400">Anything else we should know? (optional)</label>
            <textarea id="report-details" rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} className={fieldClass} />
          </div>
          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
            <button type="submit" disabled={busy || !reason} className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50">
              {busy ? 'Sending…' : 'Report'}
            </button>
          </div>
        </form>
      )}
    </Shell>
  )
}
