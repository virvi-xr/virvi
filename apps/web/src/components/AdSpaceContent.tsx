'use client'

import { useEffect, useState } from 'react'
import type { AdContent, OwnerAdSpace } from '@virvixr/shared'
import type { useApi } from '@/lib/api'
import { contentLabel, candidateBadges, adSpaceErrorText } from '@/lib/ads'

const CONTENT_OPTIONS: AdContent[] = ['family', 'all', 'approve']

/** The owner's setting for who can advertise on an ad space, plus per-ad approvals. Renders nothing for callers without full access (403). */
export default function AdSpaceContent({ elementId, refreshKey, api }: { elementId: string; refreshKey: string; api: ReturnType<typeof useApi> }) {
  const [space, setSpace] = useState<OwnerAdSpace | null>(null)
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setSpace(null)
    setHidden(false)
    setError(null)
    api.getAdSpace(elementId).then(
      (d) => { if (live) setSpace(d.space) },
      (e: any) => {
        if (!live) return
        if (e?.status === 403) setHidden(true)
        else setError(e?.message ?? 'Could not load ad settings')
      },
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elementId, refreshKey])

  if (hidden || (!space && !error)) return null

  const run = async (fn: () => Promise<{ space: OwnerAdSpace }>) => {
    setBusy(true)
    setError(null)
    try {
      setSpace((await fn()).space)
    } catch (e: any) {
      setError(adSpaceErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-950 p-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Who can advertise here</span>
        <select aria-label="Who can advertise here" value={space?.content ?? 'family'} disabled={!space || busy}
          onChange={(e) => run(() => api.setAdSpaceContent(elementId, e.target.value as AdContent))}
          className="w-full max-w-md rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800 disabled:opacity-50">
          {CONTENT_OPTIONS.map((c) => <option key={c} value={c}>{contentLabel(c)}</option>)}
        </select>
      </div>
      <p className="text-xs text-gray-500">Every ad is reviewed by Virvi before it can show anywhere.</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {space?.content === 'approve' && (
        space.ads.length === 0 ? (
          <p className="text-sm text-gray-500">No approved ads fit this space yet.</p>
        ) : (
          <div className="space-y-2">
            {space.ads.map((ad) => (
              <div key={ad.adId} className="space-y-2 rounded-lg border border-gray-800 bg-gray-900 p-2">
                <div className="flex flex-wrap gap-2">
                  {ad.creatives.map((c) => (
                    <div key={c.id} className="flex h-20 w-28 items-center justify-center overflow-hidden rounded bg-gray-800">
                      {c.kind === 'image'
                        ? <img src={c.url} alt={ad.name} className="max-h-full max-w-full object-contain" />
                        : <video src={c.url} muted preload="metadata" className="max-h-full max-w-full object-contain" />}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{ad.name}</p>
                    <div className="flex gap-1">
                      {candidateBadges(ad).map((b) => <span key={b} className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">{b}</span>)}
                    </div>
                    <a href={ad.clickUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-xs text-blue-400 hover:text-blue-300">{ad.clickUrl}</a>
                    {ad.decision && (
                      <p className={`text-xs ${ad.decision === 'approved' ? 'text-green-400' : 'text-gray-500'}`}>
                        {ad.decision === 'approved' ? 'Approved' : 'Declined'}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button disabled={busy || ad.decision === 'approved'} onClick={() => run(() => api.decideAdSpaceAd(elementId, ad.adId, 'approved'))}
                      className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 disabled:opacity-50">Approve</button>
                    <button disabled={busy || ad.decision === 'declined'} onClick={() => run(() => api.decideAdSpaceAd(elementId, ad.adId, 'declined'))}
                      className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 disabled:opacity-50">Decline</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}
