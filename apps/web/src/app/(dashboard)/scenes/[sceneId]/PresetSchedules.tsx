'use client'
import { useCallback, useEffect, useState } from 'react'
import type { useApi } from '@/lib/api'
import { presetDisplayName } from '@/lib/presets'
import {
  describeSchedule, formatRunTime, formToBody, runLabel, timezones, viewerTimezone, weekGrid, WEEKDAYS,
  type PresetSchedule, type ScheduleForm, type ScheduleRun, type WeekOccurrence,
} from '@/lib/preset-schedules'

type Api = ReturnType<typeof useApi>

const INPUT = 'rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white outline-none focus:border-blue-400'
const COLORS = ['bg-blue-600/70', 'bg-purple-600/70', 'bg-emerald-600/70', 'bg-amber-600/70', 'bg-pink-600/70', 'bg-cyan-600/70']
const BTN = 'rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50'

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Scheduled presets (LIV-86): a preset goes live on its own at set times, once or repeating, in a timezone. Shown under
 * the preset bar; hosts, co-hosts and editors only (the server refuses everyone else).
 */
export function PresetSchedules({ api, sceneId, presets }: { api: Api; sceneId: string; presets: { id: string; name: string }[] }) {
  const viewerTz = viewerTimezone()
  const blank = (): ScheduleForm => ({
    presetId: presets[0]?.id ?? '', recurrence: 'weekly', weekdays: [new Date().getDay()], startDate: today(), startTime: '20:00',
    hasEnd: true, durationMinutes: 120, timezone: viewerTz, returnToPresetId: '',
  })
  const [open, setOpen] = useState(false)
  const [schedules, setSchedules] = useState<PresetSchedule[] | null>(null)
  const [runs, setRuns] = useState<ScheduleRun[]>([])
  const [week, setWeek] = useState<WeekOccurrence[]>([])
  const [view, setView] = useState<'list' | 'week'>('list')
  const [form, setForm] = useState<ScheduleForm | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = (id: string | null) => presetDisplayName(presets.find((p) => p.id === id)?.name ?? 'a deleted preset')

  const load = useCallback(() => {
    api.getPresetSchedules(sceneId)
      .then((r) => { setSchedules(r.schedules); setRuns(r.runs); setWeek(r.week ?? []) })
      .catch((e: any) => { setSchedules([]); setError(e?.status === 403 ? 'Only the scene host, co-hosts and editors can schedule presets.' : e?.message || 'Could not load schedules') })
  }, [api, sceneId])
  useEffect(() => { if (open && schedules === null) load() }, [open, schedules, load])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await work() } catch (e: any) { setError(e?.body?.message || e?.message || 'Something went wrong') } finally { setBusy(false) }
  }

  const save = () => form && run(async () => {
    if (editingId) await api.updatePresetSchedule(editingId, formToBody(form))
    else await api.createPresetSchedule(sceneId, formToBody(form))
    setForm(null)
    setEditingId(null)
    load()
  })

  const edit = (s: PresetSchedule) => {
    setEditingId(s.id)
    setForm({
      presetId: s.presetId, recurrence: s.recurrence, weekdays: s.weekdays.length ? s.weekdays : [new Date().getDay()], startDate: s.startDate, startTime: s.startTime,
      hasEnd: s.durationMinutes != null, durationMinutes: s.durationMinutes ?? 120, timezone: s.timezone, returnToPresetId: s.returnToPresetId ?? '',
    })
  }

  const set = <K extends keyof ScheduleForm>(k: K, v: ScheduleForm[K]) => setForm((f) => f && { ...f, [k]: v })
  const live = runs.find((r) => r.status === 'active' || r.status === 'held')

  return (
    <div className="mb-4 rounded-lg border border-gray-800 bg-gray-900">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm font-medium text-gray-200 hover:bg-white/[0.02]">
        <span>Schedule {schedules && schedules.length > 0 && <span className="ml-1 text-xs text-gray-500">({schedules.length})</span>}</span>
        <span className="text-xs text-gray-500">{open ? 'Hide' : 'Switch presets automatically at set times'}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-gray-800 px-4 py-4">
          {live && (
            <p className="text-sm text-green-400">
              {runLabel(live)}: {name(schedules?.find((s) => s.id === live.scheduleId)?.presetId ?? null)}
            </p>
          )}

          {schedules && schedules.length > 0 && (
            <div className="flex gap-1 text-xs" role="tablist" aria-label="Schedule view">
              {(['list', 'week'] as const).map((v) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                  className={`rounded-md px-2.5 py-1 ${view === v ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>{v === 'list' ? 'List' : 'Week'}</button>
              ))}
            </div>
          )}

          {schedules && schedules.length > 0 && view === 'week' ? (
            <WeekView week={week} viewerTz={viewerTz} name={name} color={(id) => COLORS[Math.max(0, presets.findIndex((p) => p.id === id)) % COLORS.length]} />
          ) : schedules === null ? <p className="text-sm text-gray-500">Loading…</p> : schedules.length === 0 && !form ? (
            <p className="text-sm text-gray-500">No schedules yet. A schedule makes a preset live at set times, even with nobody online. Venue bookings take priority, and switching by hand overrides the run in progress.</p>
          ) : (
            <ul className="space-y-2">
              {schedules.map((s) => (
                <li key={s.id} className={`rounded-md border border-gray-800 bg-gray-950 px-3 py-2 ${s.enabled ? '' : 'opacity-60'}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-white">{name(s.presetId)}</span>
                    <span className="text-sm text-gray-400">{describeSchedule(s)}</span>
                    {!s.enabled && <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-gray-400">Paused</span>}
                    <span className="ml-auto flex gap-2">
                      <button type="button" className={BTN} disabled={busy} onClick={() => edit(s)}>Edit</button>
                      <button type="button" className={BTN} disabled={busy} onClick={() => run(async () => { await api.updatePresetSchedule(s.id, { enabled: !s.enabled }); load() })}>{s.enabled ? 'Pause' : 'Resume'}</button>
                      <button type="button" className={`${BTN} hover:border-red-500 hover:text-red-300`} disabled={busy} onClick={() => run(async () => { await api.deletePresetSchedule(s.id); load() })}>Delete</button>
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Then: {s.returnToPresetId ? name(s.returnToPresetId) : 'back to the preset that was live before'}
                  </p>
                  {s.nextRuns.length > 0 && (
                    <ul className="mt-1 text-xs text-gray-400">
                      {s.nextRuns.map((r) => <li key={r}>Next: {formatRunTime(r, s.timezone, viewerTz)}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}

          {form ? (
            <form className="space-y-3 rounded-md border border-gray-800 bg-gray-950 p-3" onSubmit={(e) => { e.preventDefault(); void save() }}>
              <div className="flex flex-wrap items-center gap-3 text-sm text-gray-300">
                <label className="flex items-center gap-2">Preset
                  <select className={INPUT} value={form.presetId} onChange={(e) => set('presetId', e.target.value)}>
                    {presets.map((p) => <option key={p.id} value={p.id}>{presetDisplayName(p.name)}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2">Repeat
                  <select className={INPUT} value={form.recurrence} onChange={(e) => set('recurrence', e.target.value as ScheduleForm['recurrence'])}>
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
                    {timezones().map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm text-gray-300">
                <label className="flex items-center gap-2"><input type="checkbox" checked={form.hasEnd} onChange={(e) => set('hasEnd', e.target.checked)} />Ends after</label>
                {form.hasEnd ? (
                  <>
                    <input type="number" min={1} max={form.recurrence === 'daily' ? 1440 : 10080} className={`${INPUT} w-24`} value={form.durationMinutes}
                      onChange={(e) => set('durationMinutes', Math.max(1, Number(e.target.value) || 1))} aria-label="Length in minutes" />
                    <span>minutes, then</span>
                    <select className={INPUT} value={form.returnToPresetId} onChange={(e) => set('returnToPresetId', e.target.value)} aria-label="Afterwards">
                      <option value="">back to the preset live before</option>
                      {presets.filter((p) => p.id !== form.presetId).map((p) => <option key={p.id} value={p.id}>{presetDisplayName(p.name)}</option>)}
                    </select>
                  </>
                ) : <span className="text-gray-500">Stays live until the next schedule or a manual switch</span>}
              </div>
              <div className="flex gap-3">
                <button type="submit" disabled={busy || !form.presetId} className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">{editingId ? 'Save' : 'Add schedule'}</button>
                <button type="button" className="text-sm text-gray-400 hover:text-white" onClick={() => { setForm(null); setEditingId(null); setError('') }}>Cancel</button>
              </div>
            </form>
          ) : (
            <button type="button" className={BTN} disabled={busy || presets.length === 0} onClick={() => { setEditingId(null); setForm(blank()) }}>Add schedule</button>
          )}

          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

          {runs.length > 0 && (
            <details className="text-xs text-gray-400">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-300">Recent runs</summary>
              <ul className="mt-2 space-y-1">
                {runs.map((r) => {
                  const s = schedules?.find((x) => x.id === r.scheduleId)
                  return <li key={r.id}>{formatRunTime(r.occurrenceStart, s?.timezone ?? viewerTz, viewerTz)}: {name(s?.presetId ?? null)} — {runLabel(r)}</li>
                })}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

/** The next seven days in the viewer's timezone, each run a block placed by its local time (LIV-86). */
function WeekView({ week, viewerTz, name, color }: { week: WeekOccurrence[]; viewerTz: string; name: (id: string | null) => string; color: (presetId: string) => string }) {
  const days = weekGrid(week, viewerTz, new Date())
  return (
    <div>
      <div className="grid grid-cols-[2rem_repeat(7,minmax(0,1fr))] gap-1 text-[10px] text-gray-500">
        <span />
        {days.map((d) => <span key={d.date} className="text-center">{d.label}</span>)}
        <div className="relative h-72">
          {[0, 6, 12, 18].map((h) => <span key={h} className="absolute right-1" style={{ top: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>)}
        </div>
        {days.map((d) => (
          <div key={d.date} className="relative h-72 rounded bg-gray-950 ring-1 ring-gray-800">
            {d.blocks.map((b, i) => (
              <div key={i} title={`${name(b.presetId)}, ${b.time}`}
                className={`absolute inset-x-0.5 overflow-hidden rounded px-1 text-[10px] leading-tight text-white ${color(b.presetId)}`}
                style={{ top: `${b.top}%`, height: `max(${b.height}%, 0.9rem)` }}>
                {name(b.presetId)}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-500">Times in your timezone ({viewerTz}). Paused schedules aren&apos;t shown.</p>
    </div>
  )
}
