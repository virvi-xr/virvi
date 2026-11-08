'use client'

import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/lib/api'
import { Skeleton } from '@/components/ui'
import { adminActionMessage, kindLabel, otherAgents } from '@/lib/studio'
import { leaderLine, rateLabel, whoLabel, type KindDefaults as Data } from '@/lib/studio-ratings'

const smallButton = 'rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50'
const KINDS = ['wearable', 'emote', 'scene'] as const

/** The agent new designs of each kind start on (LIV-142), beside the 👍 rates. Never switches on its own. */
export default function KindDefaults() {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [d, setD] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiRef.current.getAdminStudioDefaults().then(setD).catch((e) => setError(adminActionMessage(e)))
  }, [])

  const choose = async (kind: string, agent: string) => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.setAdminStudioDefault(kind, agent)
      setD((prev) => (prev ? { ...prev, defaults: r.defaults } : prev))
    } catch (e) {
      setError(adminActionMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="defaults-title" className="mt-10">
      <h2 id="defaults-title" className="mb-1 text-lg font-semibold">Default agent per kind</h2>
      <p className="mb-3 text-sm text-gray-400">
        New designs of a kind start on its default; people can still change agent, and existing designs keep theirs.
        {d && ` 👍 rates from the last ${d.ratesDays} days; a leader is named after ${d.minSample} ratings.`}
      </p>
      {error && <p className="mb-3 text-sm text-red-400" role="alert">{error}</p>}
      {!d ? (error ? null : <Skeleton rows={1} className="h-16" />) : (
        <div className="grid gap-3 md:grid-cols-3">
          {KINDS.map((k) => {
            const current = d.defaults[k]
            const rates = d.rates.find((r) => r.kind === k)
            return (
              <div key={k} className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
                <h3 className="font-medium">{kindLabel(k)}</h3>
                <p className="text-gray-300">{current ? `Default: ${whoLabel(current.agent, current.model)}` : 'Default: the page’s own'}</p>
                {rates && <p className="mt-2 text-gray-200">{leaderLine(rates)}</p>}
                <ul className="mt-1 text-xs text-gray-400">
                  {rates?.rows.map((r) => <li key={`${r.agent}-${r.model}`}>{whoLabel(r.agent, r.model)}: {rateLabel(r, d.minSample)}</li>)}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  {otherAgents(current?.agent ?? '').filter((a) => d.agents.includes(a.id)).map((a) => (
                    <button key={a.id} type="button" disabled={busy} onClick={() => choose(k, a.id)} className={smallButton}>Use {a.label}</button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
