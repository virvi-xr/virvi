'use client'
import { useEffect, useState } from 'react'
import type { ShowItemState, ShowView } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { Badge } from '@/components/ui'
import { openAssistant } from './AssistantButton'

const STATE: Record<ShowItemState, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  todo: { label: 'To do', tone: 'neutral' },
  waiting: { label: 'Waiting', tone: 'warning' },
  done: { label: 'Done', tone: 'success' },
  skipped: { label: 'Skipped', tone: 'neutral' },
}

/** The checklist of each show attached to an event: item, state badge, note, then the timeline and warning when set. Text only. */
export function ShowChecklist({ shows, onAsk }: { shows: ShowView[]; onAsk: () => void }) {
  if (shows.length === 0) return null
  return (
    <section className="mb-6 rounded-lg border border-gray-800 bg-gray-900/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Show checklist</h2>
        <button type="button" onClick={onAsk}
          className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-white">Ask the assistant</button>
      </div>
      {shows.map((show) => (
        <div key={show.id} className="mb-3 last:mb-0">
          {shows.length > 1 && <p className="mb-1 text-xs text-gray-500">{show.title}</p>}
          <ul className="space-y-1.5">
            {show.items.map((item) => {
              const s = STATE[item.state] ?? STATE.todo
              return (
                <li key={item.id} className="flex items-start gap-2 rounded-md border border-gray-800 bg-gray-900/60 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm text-gray-100">{item.label}</p>
                    {item.note && <p className="mt-0.5 break-words text-xs text-gray-400">{item.note}</p>}
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </li>
              )
            })}
          </ul>
          {show.timeline && <p className="mt-2 text-xs text-gray-400">{show.timeline}</p>}
          {show.warning && <p className="mt-1 text-xs text-amber-300">{show.warning}</p>}
        </div>
      ))}
    </section>
  )
}

/** Loads the event's shows. Any refusal or failure (assistant hidden, locked, off) means no checklist. */
export function EventShowChecklist({ eventId }: { eventId: string }) {
  const api = useApi()
  const [shows, setShows] = useState<ShowView[]>([])
  useEffect(() => {
    let live = true
    setShows([])
    api.getAssistantShows(eventId).then((d) => { if (live) setShows(d.shows) }).catch(() => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId])
  return <ShowChecklist shows={shows} onAsk={openAssistant} />
}
