'use client'

import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/lib/api'
import { Skeleton } from '@/components/ui'
import { adminActionMessage } from '@/lib/studio'
import { ideaCountRow, type AdminIdeaCounts } from '@/lib/studio-ideas'

/**
 * The example prompts under "What makes a good prompt": how many are left per slot and per move (an idea goes once
 * someone sends it as a first prompt), flagging any running low. More ideas are added in the server's prompt-ideas.ts.
 */
export default function ExampleIdeas() {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [d, setD] = useState<AdminIdeaCounts | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiRef.current.getAdminStudioIdeas().then(setD).catch((e) => setError(adminActionMessage(e)))
  }, [])

  const list = (title: string, kind: 'wearable' | 'emote', rows: AdminIdeaCounts['wearable']) => (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
      <h3 className="mb-2 font-medium">{title}</h3>
      <ul className="space-y-1">
        {rows.map((c) => {
          const r = ideaCountRow(c, d!.low, kind)
          return (
            <li key={c.key} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-gray-300">{r.label}</span>
              <span className={`shrink-0 tabular-nums ${r.low ? 'text-amber-300' : 'text-gray-400'}`}>
                {r.count}{r.low && <span className="ml-1.5 text-xs">(running low)</span>}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )

  return (
    <section aria-labelledby="ideas-title" className="mt-10">
      <h2 id="ideas-title" className="mb-1 text-lg font-semibold">Example ideas</h2>
      <p className="mb-3 text-sm text-gray-400">
        The ideas people can tap before their first prompt. Each one goes for everyone once someone sends it.
        {d && ` A slot counts its outfits too; fewer than ${d.low} left is flagged.`}
      </p>
      {error && <p className="mb-3 text-sm text-red-400" role="alert">{error}</p>}
      {!d ? (error ? null : <Skeleton rows={1} className="h-16" />) : (
        <div className="grid gap-3 md:grid-cols-2">
          {list('Wearables', 'wearable', d.wearable)}
          {list('Emotes', 'emote', d.emote)}
        </div>
      )}
    </section>
  )
}
