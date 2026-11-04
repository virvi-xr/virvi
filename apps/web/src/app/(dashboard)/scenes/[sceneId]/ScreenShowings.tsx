'use client'
import { useCallback, useEffect, useState, type ComponentType } from 'react'
import type { useApi } from '@/lib/api'
import { mediaLabel, useMediaNames } from '@/lib/media-names'
import { formatRunTime, localDate, timezoneOptions, viewerTimezone } from '@/lib/preset-schedules'
import { formatDuration } from '@/lib/format'
import {
  describeShowing, formToShowingBody, parseLength, previewAt, programmeLength, programmeProblem, showingToForm, WEEKDAYS,
  type Showing, type ShowingForm, type ShowingFormItem,
} from '@/lib/showings'

type Api = ReturnType<typeof useApi>
type Picker = ComponentType<{ api: Api; accept?: string; onSelect: (url: string) => void; onClose: () => void }>

const INPUT = 'rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white outline-none focus:border-blue-400'
const BTN = 'rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50'

/**
 * Scheduled showings (LIV-87): a screen in Schedule mode plays programmes of videos at set times, and everyone in the
 * scene sees the same moment. Hosts, co-hosts, editors and booking crew with the playlist permission (the server checks).
 */
export function ScreenShowings({ api, sceneId, elementId, MediaPicker }: { api: Api; sceneId: string; elementId: string; MediaPicker: Picker }) {
  const viewerTz = viewerTimezone()
  const blank = (): ShowingForm => ({
    title: '', description: '', posterUrl: '', items: [], recurrence: 'weekly', weekdays: [new Date().getDay()],
    startDate: localDate(), startTime: '19:00', timezone: viewerTz, enabled: true,
  })
  const [showings, setShowings] = useState<Showing[] | null>(null)
  const [form, setForm] = useState<ShowingForm | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unknown, setUnknown] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const urls = [...new Set([...(showings ?? []).flatMap((s) => s.items.map((i) => i.url)), ...(form?.items.map((i) => i.url) ?? [])])]
  const names = useMediaNames(api, sceneId, urls)
  const name = (url: string) => mediaLabel(url, names).label

  const load = useCallback(() => {
    api.getShowings(elementId)
      .then((r) => setShowings(r.showings))
      .catch((e: any) => { setShowings([]); setError(e?.status === 403 ? 'You need permission to edit this screen\'s playlist to schedule showings.' : e?.message || 'Could not load showings') })
  }, [api, elementId])
  useEffect(() => { load() }, [load])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setUnknown([])
    try {
      await work()
    } catch (e: any) {
      setError(e?.body?.message || e?.message || 'Something went wrong')
      if (Array.isArray(e?.body?.urls)) setUnknown(e.body.urls)
    } finally {
      setBusy(false)
    }
  }

  const set = <K extends keyof ShowingForm>(k: K, v: ShowingForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const setItem = (i: number, patch: Partial<ShowingFormItem>) => form && set('items', form.items.map((it, j) => (j === i ? { ...it, ...patch } : it)))
  const addItem = (url: string) => form && set('items', [...form.items, { url, kind: 'video', length: '' }])
  const moveItem = (i: number, by: -1 | 1) => {
    if (!form) return
    const items = [...form.items]
    const j = i + by
    if (j < 0 || j >= items.length) return
    ;[items[i], items[j]] = [items[j], items[i]]
    set('items', items)
  }

  const problem = form ? programmeProblem(form.items) : null
  const save = () => form && !problem && run(async () => {
    if (editingId) await api.updateShowing(editingId, formToShowingBody(form))
    else await api.createShowing(elementId, formToShowingBody(form))
    setForm(null)
    setEditingId(null)
    load()
  })
  const toggle = (s: Showing) => run(async () => { await api.updateShowing(s.id, { enabled: !s.enabled }); load() })
  const remove = (s: Showing) => run(async () => {
    await api.deleteShowing(s.id)
    // Deleting the one being edited closes its form (saving it would edit a showing that's gone)
    if (s.id === editingId) { setForm(null); setEditingId(null) }
    load()
  })

  return (
    <div className="space-y-3 rounded-md border border-gray-800 bg-gray-950/50 p-3">
      <div>
        <span className="text-xs text-gray-500">Showings</span>
        <p className="text-xs text-gray-500">Each showing plays its videos in order at its start time. Everyone in the scene sees the same moment, and late arrivals join mid-show. Between showings the screen shows the holding image.</p>
      </div>

      {showings === null ? <p className="text-sm text-gray-500">Loading…</p> : showings.length === 0 && !form ? (
        <p className="text-sm text-gray-400">No showings yet.</p>
      ) : (
        <ul className="space-y-2">
          {showings.map((s) => (
            <li key={s.id} className={`rounded-md border border-gray-800 px-3 py-2 text-sm ${s.enabled ? '' : 'opacity-60'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-white">{s.title || 'Untitled showing'}{s.enabled ? '' : ' (paused)'}</span>
                <span className="flex gap-2">
                  <button type="button" className={BTN} disabled={busy} onClick={() => { setEditingId(s.id); setForm(showingToForm(s)); setError(''); setUnknown([]) }}>Edit</button>
                  <button type="button" className={BTN} disabled={busy} onClick={() => toggle(s)}>{s.enabled ? 'Pause' : 'Resume'}</button>
                  <button type="button" className={`${BTN} text-red-400`} disabled={busy} onClick={() => remove(s)}>Delete</button>
                </span>
              </div>
              <p className="text-xs text-gray-400">{describeShowing(s)}</p>
              <p className="text-xs text-gray-500">{s.items.map((i) => `${name(i.url)}${i.kind === 'ad' ? ' (ad)' : ''}`).join(' → ')}</p>
              {s.enabled && s.nextStarts[0] && <p className="text-xs text-gray-500">Next: {formatRunTime(s.nextStarts[0], s.timezone, viewerTz)}</p>}
            </li>
          ))}
        </ul>
      )}

      {form ? (
        <form className="space-y-3 rounded-md border border-gray-800 bg-gray-950 p-3" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <div className="flex flex-wrap items-center gap-3 text-sm text-gray-300">
            <label className="flex items-center gap-2">Title
              <input className={`${INPUT} w-64`} value={form.title} maxLength={200} onChange={(e) => set('title', e.target.value)} placeholder="Night of the Living Dead" />
            </label>
            <label className="flex items-center gap-2">Repeat
              <select className={INPUT} value={form.recurrence} onChange={(e) => set('recurrence', e.target.value as ShowingForm['recurrence'])}>
                <option value="once">Once</option>
                <option value="daily">Every day</option>
                <option value="weekly">On chosen days</option>
              </select>
            </label>
          </div>
          {form.recurrence === 'weekly' && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
              {WEEKDAYS.map((d, i) => {
                const on = form.weekdays.includes(i)
                return (
                  <button type="button" key={d} aria-pressed={on}
                    onClick={() => set('weekdays', on ? form.weekdays.filter((x) => x !== i) : [...form.weekdays, i])}
                    className={`rounded-md border px-2 py-1 text-xs ${on ? 'border-blue-500 bg-blue-600/20 text-white' : 'border-gray-700 text-gray-400'}`}>{d}</button>
                )
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 text-sm text-gray-300">
            <label className="flex items-center gap-2">{form.recurrence === 'once' ? 'Date' : 'From'}
              <input type="date" className={INPUT} value={form.startDate} onChange={(e) => set('startDate', e.target.value)} required />
            </label>
            <label className="flex items-center gap-2">At
              <input type="time" className={INPUT} value={form.startTime} onChange={(e) => set('startTime', e.target.value)} required />
            </label>
            <label className="flex items-center gap-2">Timezone
              <select className={`${INPUT} max-w-[14rem]`} value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {timezoneOptions(form.timezone).map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </label>
          </div>

          <div className="space-y-1">
            <span className="text-xs text-gray-500">Programme, played in order. Mark trailers and ads as ads; they play before the feature, never after it.</span>
            {form.items.map((it, i) => (
              <div key={i} className={`flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${unknown.includes(it.url) ? 'border-amber-500' : 'border-gray-800'}`}>
                <span className="w-5 text-xs text-gray-500">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate text-gray-300" title={it.url}>{name(it.url)}</span>
                <select className={INPUT} value={it.kind} onChange={(e) => setItem(i, { kind: e.target.value as ShowingFormItem['kind'] })} aria-label="Kind">
                  <option value="video">Video</option>
                  <option value="ad">Ad / trailer</option>
                </select>
                <input className={`${INPUT} w-24`} value={it.length} onChange={(e) => setItem(i, { length: e.target.value })}
                  placeholder="auto" aria-label="Length (h:mm:ss)" title="Leave blank for Media Library videos: their length was measured on upload. Enter it for videos from elsewhere." />
                <button type="button" className="text-xs text-gray-400 hover:text-white disabled:opacity-30" disabled={i === 0} onClick={() => moveItem(i, -1)} aria-label="Move up">↑</button>
                <button type="button" className="text-xs text-gray-400 hover:text-white disabled:opacity-30" disabled={i === form.items.length - 1} onClick={() => moveItem(i, 1)} aria-label="Move down">↓</button>
                <button type="button" className="text-xs text-red-400 hover:text-red-300" onClick={() => set('items', form.items.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={BTN} onClick={() => setPicking(true)}>Add from Media Library</button>
              <input className={`${INPUT} flex-1`} value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="Or paste a video URL"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (urlInput.trim()) { addItem(urlInput.trim()); setUrlInput('') } } }} />
            </div>
            <Preview form={form} name={name} />
          </div>

          <p className="text-xs text-gray-500">Only screen films you have the rights to show publicly. What plays is the scene owner&apos;s responsibility.</p>
          {problem && form.items.length > 0 && <p className="text-sm text-amber-300">{problem}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={busy || !!problem} className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">{editingId ? 'Save' : 'Add showing'}</button>
            <button type="button" className="text-sm text-gray-400 hover:text-white" onClick={() => { setForm(null); setEditingId(null); setError(''); setUnknown([]) }}>Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" className={BTN} disabled={busy || showings === null} onClick={() => { setEditingId(null); setForm(blank()) }}>Add showing</button>
      )}

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {picking && <MediaPicker api={api} accept="video/*" onSelect={(url) => { addItem(url); setPicking(false) }} onClose={() => setPicking(false)} />}
    </div>
  )
}

/** "At 14 minutes in, the screen is 4:02 into <film>", from the lengths typed or known so far. */
function Preview({ form, name }: { form: ShowingForm; name: (url: string) => string }) {
  const [minutes, setMinutes] = useState('14')
  const items = form.items.map((i) => ({ url: i.url, kind: i.kind, duration: parseLength(i.length) ?? 0 }))
  const known = items.length > 0 && items.every((i) => i.duration > 0)
  if (!known) return items.length ? <p className="text-xs text-gray-500">Lengths of Media Library videos are filled in when you save.</p> : null
  const total = formatDuration(programmeLength(items))
  const at = Math.max(0, Number(minutes) || 0) * 60
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
      <span>Runs {total}. Preview:</span>
      <input className={`${INPUT} w-16 py-0.5 text-xs`} type="number" min={0} value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Minutes after the start" />
      <span>min after the start: {previewAt(items, at, name)}</span>
    </p>
  )
}
