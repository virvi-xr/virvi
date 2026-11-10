'use client'

import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/lib/api'
import { Skeleton } from '@/components/ui'
import { adminActionMessage } from '@/lib/studio'
import { secondsLabel, type FirstReplyStats } from '@/lib/studio-wait'

const MACHINES = [
  { key: 'created', label: 'New machine' },
  { key: 'started', label: 'Stopped machine started' },
  { key: 'running', label: 'Machine already running' },
] as const
const STEPS = [
  { key: 'taken', label: 'Taken' },
  { key: 'boot', label: 'Worker boot (how long it took)' },
  { key: 'checking', label: 'Checking' },
  { key: 'building', label: 'Agent starts' },
  { key: 'firstProgress', label: 'First progress' },
  { key: 'done', label: 'Finished' },
] as const

/** How long prompts wait for the agent's first progress line, over the last 50 timed prompts. */
export default function FirstReply() {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [d, setD] = useState<FirstReplyStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiRef.current.getAdminStudioFirstReply().then(setD).catch((e) => setError(adminActionMessage(e)))
  }, [])

  return (
    <section aria-labelledby="first-reply-title" className="mt-10">
      <h2 id="first-reply-title" className="mb-1 text-lg font-semibold">First reply</h2>
      <p className="mb-3 text-sm text-gray-400">
        From sending a prompt to the agent’s first progress line{d ? `, over the last ${d.jobs} timed prompts` : ''}.
      </p>
      {error && <p className="mb-3 text-sm text-red-400" role="alert">{error}</p>}
      {!d ? (error ? null : <Skeleton rows={1} className="h-16" />) : d.jobs === 0 ? (
        <p className="text-sm text-gray-500">No timed prompts yet.</p>
      ) : (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
          <p className="text-gray-200">
            Median {secondsLabel(d.firstReply.median)}, 90th percentile {secondsLabel(d.firstReply.p90)}
            <span className="text-gray-500"> ({d.firstReply.jobs} prompts)</span>
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[20rem] text-left text-xs">
              <thead className="text-gray-500">
                <tr><th className="py-1 pr-3 font-normal">Machine</th><th className="py-1 pr-3 font-normal">Prompts</th><th className="py-1 pr-3 font-normal">Median</th><th className="py-1 font-normal">90th</th></tr>
              </thead>
              <tbody className="text-gray-300">
                {MACHINES.map((m) => (
                  <tr key={m.key} className="border-t border-gray-800">
                    <td className="py-1 pr-3">{m.label}</td>
                    <td className="py-1 pr-3 tabular-nums">{d.byMachine[m.key].jobs}</td>
                    <td className="py-1 pr-3 tabular-nums">{secondsLabel(d.byMachine[m.key].median)}</td>
                    <td className="py-1 tabular-nums">{secondsLabel(d.byMachine[m.key].p90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-gray-500">Median time from sending to each step</p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-300">
            {STEPS.map((s) => <li key={s.key}>{s.label}: <span className="tabular-nums">{secondsLabel(d.steps[s.key])}</span></li>)}
          </ul>
        </div>
      )}
    </section>
  )
}
