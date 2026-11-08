'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { Skeleton } from '@/components/ui'
import { adminActionMessage, kindLabel, latestOnly } from '@/lib/studio'
import { lastFullWeek, leaderLine, rateLabel, shiftWeek, tagLabel, weekLabel, whoLabel, type Digest as DigestData } from '@/lib/studio-ratings'

const smallButton = 'rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50'

/** The weekly ratings digest (LIV-142): pick a week; the same digest is mailed to every admin each Monday. */
export default function Digest() {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const latest = lastFullWeek(new Date())
  const [week, setWeek] = useState(latest)
  const [d, setD] = useState<DigestData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const gate = useRef(latestOnly())

  useEffect(() => {
    const id = gate.current.next()
    setD(null)
    setError(null)
    apiRef.current.getAdminStudioDigest(week)
      .then((r) => { if (gate.current.isLatest(id)) setD(r) })
      .catch((e) => { if (gate.current.isLatest(id)) setError(adminActionMessage(e)) })
  }, [week])

  return (
    <section aria-labelledby="digest-title" className="mt-10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="digest-title" className="text-lg font-semibold">Weekly ratings digest</h2>
        <div className="flex items-center gap-2 text-sm">
          <button type="button" onClick={() => setWeek(shiftWeek(week, -1))} className={smallButton} aria-label="Previous week">←</button>
          <span className="min-w-48 text-center text-gray-300" aria-live="polite">{weekLabel(week)}</span>
          <button type="button" onClick={() => setWeek(shiftWeek(week, 1))} disabled={week >= shiftWeek(latest, 1)} className={smallButton} aria-label="Next week">→</button>
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-red-400" role="alert">{error}</p>}
      {!d ? (error ? null : <Skeleton rows={2} className="h-24" />) : d.totals.up + d.totals.down === 0 ? (
        <p className="text-gray-400">No ratings that week.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
            <h3 className="font-medium">{d.totals.up} 👍 · {d.totals.down} 👎</h3>
            <table className="mt-2 w-full text-left">
              <thead className="text-xs text-gray-500"><tr><th className="py-1 font-normal">Kind</th><th className="font-normal">Agent · model</th><th className="font-normal">👍</th><th className="font-normal">👎</th></tr></thead>
              <tbody>
                {d.counts.map((c) => (
                  <tr key={`${c.kind}-${c.agent}-${c.model}`} className="border-t border-gray-800">
                    <td className="py-1">{kindLabel(c.kind)}</td><td>{whoLabel(c.agent, c.model)}</td><td>{c.up}</td><td>{c.down}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
            <h3 className="font-medium">👍 rate by agent and model</h3>
            <p className="text-xs text-gray-500">A leader is named after {d.minSample} ratings.</p>
            {d.rates.map((k) => (
              <div key={k.kind} className="mt-2">
                <p className="text-gray-200">{leaderLine(k)}</p>
                <ul className="text-xs text-gray-400">
                  {k.rows.map((r) => <li key={`${r.agent}-${r.model}`}>{whoLabel(r.agent, r.model)}: {rateLabel(r, d.minSample)}</li>)}
                </ul>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
            <h3 className="font-medium">Top complaints</h3>
            {d.topTags.length ? <ul className="mt-1">{d.topTags.map((t) => <li key={t.tag}>{t.label}: {t.count}</li>)}</ul> : <p className="text-gray-400">No tags.</p>}
            <h3 className="mt-3 font-medium">Worst-rated designs</h3>
            {d.worstDesigns.length ? (
              <ul className="mt-1">
                {d.worstDesigns.map((w) => (
                  <li key={w.id}><Link href={`/studio/${w.id}`} className="text-blue-300 underline">{w.name ?? w.id}</Link> · {w.down} 👎, {w.up} 👍</li>
                ))}
              </ul>
            ) : <p className="text-gray-400">None.</p>}
          </div>
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
            <h3 className="font-medium">Could be checked automatically</h3>
            {d.autoCheckGroups.length ? (
              <ul className="mt-1">{d.autoCheckGroups.map((g) => <li key={`${g.tag}-${g.kind}`}>{g.label} · {kindLabel(g.kind)}: {g.count}</li>)}</ul>
            ) : <p className="text-gray-400">Nothing marked yet.</p>}
            <h3 className="mt-3 font-medium">What people said</h3>
            {d.notes.length ? (
              <ul className="mt-1 space-y-1">
                {d.notes.map((n) => (
                  <li key={n.id} className="text-gray-300">
                    <span className="text-xs text-gray-500">{kindLabel(n.kind)} · {whoLabel(n.agent, n.model)}{n.tags.length ? ` · ${n.tags.map(tagLabel).join(', ')}` : ''}</span>
                    <span className="block whitespace-pre-wrap break-words">“{n.note}”</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-gray-400">No notes.</p>}
          </div>
        </div>
      )}
    </section>
  )
}
