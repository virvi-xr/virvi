'use client'
import { eventPresetLabel, eventPresetsFor, eventShowingLabel, eventShowingsFor, type EventPresetSchedule, type EventShowing, type ScenePresetOption } from '@/lib/event-presets'
import { presetDisplayName } from '@/lib/presets'
import { useApi, useDemoPrefix } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { ArrowUpRightIcon, CalendarIcon, ChevronDownIcon, PlusIcon } from '@/components/icons'
import { Badge, EmptyState, InlineDescription, PageHeader, PrimaryButton, RowMenu, SearchField, SelectField, Skeleton, type Tone } from '@/components/ui'
import { countLabel, plural } from '@/lib/format'
import { dateParts, eventTiming, listEvents, type EventFilter, type EventSort, type EventTiming } from '@/lib/events'

export default function EventsPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <EventsContent />
    </Suspense>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** An event's page; `prefix` is `/demo` inside the demo. */
const eventHref = (id: string, prefix = '') => `${prefix}/events?id=${id}`
const inputClass = 'w-full rounded-md border border-gray-800 bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400'

// ── Main Content ─────────────────────────────────────────────────────────────

function EventsContent() {
  const { token } = useAuth()
  const api = useApi()
  const prefix = useDemoPrefix()
  const searchParams = useSearchParams()
  const router = useRouter()
  const selectedEventId = searchParams.get('id')

  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<EventFilter>('all')
  const [sort, setSort] = useState<EventSort>('start')
  const [error, setError] = useState<string | null>(null)

  // create form
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd] = useState('')
  const [newTz, setNewTz] = useState('UTC')

  useEffect(() => {
    if (!token) return
    api
      .getEvents()
      .then((data) => {
        setEvents(data.events)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [token])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    const { event } = await api.createEvent({
      name: newName.trim(),
      description: newDesc.trim() || undefined,
      startTime: newStart || undefined,
      endTime: newEnd || undefined,
      timezone: newTz || 'UTC',
    })
    setEvents((prev) => [event, ...prev])
    setNewName('')
    setNewDesc('')
    setNewStart('')
    setNewEnd('')
    setNewTz('UTC')
    setShowCreate(false)
  }

  const saveDescription = async (id: string, description: string) => {
    const { event } = await api.updateEvent(id, { description })
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, description: event.description } : e)))
  }

  const deleteEvent = async (id: string) => {
    setError(null)
    try {
      await api.deleteEvent(id)
      setEvents((prev) => prev.filter((e) => e.id !== id))
    } catch {
      setError("Couldn't delete the event")
    }
  }

  // ── Detail view ────────────────────────────────────────────────────────────
  if (selectedEventId) {
    return (
      <div className="mx-auto max-w-7xl">
        <EventDetail
          eventId={selectedEventId}
          onDeleted={() => {
            setEvents((prev) => prev.filter((e) => e.id !== selectedEventId))
            router.push(`${prefix}/events`)
          }}
        />
      </div>
    )
  }

  // ── List view ──────────────────────────────────────────────────────────────
  const shown = listEvents(events, query, filter, sort)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['Workspace', 'Events']}
        title="Events"
        count={loading ? undefined : countLabel(events.length)}
        subtitle="Schedule and manage your experiences."
        actions={<PrimaryButton onClick={() => setShowCreate(!showCreate)}><PlusIcon size={16} /> Create Event</PrimaryButton>}
      />

      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Event name" autoFocus className={inputClass} />
          <input type="text" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description (optional)" className={inputClass} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs text-gray-400">Start time</span>
              <input type="datetime-local" value={newStart} onChange={(e) => setNewStart(e.target.value)} className={inputClass} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-gray-400">End time</span>
              <input type="datetime-local" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} className={inputClass} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-gray-400">Timezone</span>
              <input type="text" value={newTz} onChange={(e) => setNewTz(e.target.value)} placeholder="UTC" className={inputClass} />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">Create</button>
            <button type="button" onClick={() => setShowCreate(false)} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          </div>
        </form>
      )}

      {!loading && events.length > 0 && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <SearchField value={query} onChange={setQuery} placeholder="Search events..." label="Search events" />
            <SelectField value={filter} onChange={(v) => setFilter(v as EventFilter)} label="Show" className="w-full sm:w-56">
              <option value="all">All events</option>
              <option value="upcoming">Upcoming</option>
              <option value="live">Live now</option>
              <option value="past">Past</option>
            </SelectField>
          </div>
          <div className="mb-3 flex items-center justify-between gap-3 text-sm">
            <span className="text-gray-400">{plural(shown.length, 'event')}</span>
            <label className="relative flex items-center text-gray-400">
              Sort:
              <select value={sort} onChange={(e) => setSort(e.target.value as EventSort)}
                className="appearance-none bg-transparent py-1 pl-1 pr-6 text-gray-200 outline-none">
                <option value="start">Start date</option>
                <option value="name">Name</option>
              </select>
              <span className="pointer-events-none absolute right-0 text-gray-400"><ChevronDownIcon size={16} /></span>
            </label>
          </div>
        </>
      )}

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {loading ? (
        <div className="space-y-px overflow-hidden rounded-lg border border-gray-800" aria-hidden="true">
          {[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse bg-gray-900" />)}
        </div>
      ) : events.length === 0 ? (
        <EmptyState icon={<CalendarIcon size={40} />} title="No events yet"
          body="An event puts your scenes and giveaways on a schedule. Create one to get started."
          action={<PrimaryButton onClick={() => setShowCreate(true)}><PlusIcon size={16} /> Create Event</PrimaryButton>} />
      ) : shown.length === 0 ? (
        <p className="py-12 text-center text-gray-500">No events match.</p>
      ) : (
        <div className="corner-notch relative rounded-lg border border-gray-800 bg-gray-900">
          <div className="hidden grid-cols-[minmax(0,1fr)_11rem_11rem_6rem] gap-4 rounded-t-lg border-b border-gray-800 bg-gray-950/40 px-6 py-3 font-mono text-xs uppercase tracking-wider text-gray-400 md:grid">
            <span>Event</span><span>Starts</span><span>Ends</span><span className="sr-only">Actions</span>
          </div>
          {shown.map((evt, i) => (
            <EventRow key={evt.id} event={evt} first={i === 0}
              onDescribe={(d) => saveDescription(evt.id, d)}
              onOpen={() => router.push(eventHref(evt.id, prefix))}
              onDelete={() => deleteEvent(evt.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function DateCell({ iso, label }: { iso?: string | null; label: string }) {
  const parts = dateParts(iso)
  return (
    <div className="text-sm">
      <span className="text-xs text-gray-500 md:hidden">{label} </span>
      {parts ? (
        <>
          <span className="font-medium text-gray-100 md:block">{parts.date}</span>{' '}
          <span className="text-gray-400 md:mt-1 md:block">{parts.time}</span>
        </>
      ) : <span className="text-gray-500">Not set</span>}
    </div>
  )
}

function EventRow({ event, first, onDescribe, onOpen, onDelete }: { event: any; first: boolean; onDescribe: (d: string) => Promise<void>; onOpen: () => void; onDelete: () => void }) {
  const prefix = useDemoPrefix()
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-4 md:grid-cols-[minmax(0,1fr)_11rem_11rem_6rem] md:px-6 ${first ? '' : 'border-t border-gray-800'}`}>
      <div className="flex min-w-0 items-start gap-4">
        <Link href={eventHref(event.id, prefix)} tabIndex={-1} aria-hidden="true"
          className="hidden h-14 w-14 shrink-0 items-center justify-center rounded-md border border-gray-800 bg-gray-950/40 text-gray-400 sm:flex">
          <CalendarIcon size={22} />
        </Link>
        <div className="min-w-0">
          <Link href={eventHref(event.id, prefix)} className="block truncate text-lg font-semibold hover:text-blue-300">{event.name}</Link>
          <InlineDescription value={event.description} canEdit onSave={onDescribe} label="Event description" placeholder="What happens at this event?" spacing="mt-1.5" />
        </div>
      </div>
      <div className="col-start-1 flex gap-4 md:col-start-auto md:contents">
        <DateCell iso={event.startTime} label="Starts" />
        <DateCell iso={event.endTime} label="Ends" />
      </div>
      <div className="col-start-2 row-span-2 row-start-1 flex items-center justify-end gap-1 md:col-start-auto md:row-span-1 md:row-start-auto">
        <Link href={eventHref(event.id, prefix)} aria-label={`Open ${event.name}`} className="rounded p-2 text-gray-400 hover:bg-white/[0.05] hover:text-blue-300">
          <ArrowUpRightIcon size={20} />
        </Link>
        <RowMenu label={`Actions for ${event.name}`} items={[
          { label: 'Open event', onSelect: onOpen },
          { label: 'Delete event', onSelect: onDelete, danger: true, confirm: 'Click again to delete' },
        ]} />
      </div>
    </div>
  )
}

// ── Event Detail ─────────────────────────────────────────────────────────────

const TIMING_BADGE: Record<EventTiming, [string, Tone]> = {
  live: ['Live', 'success'],
  upcoming: ['Upcoming', 'warning'],
  past: ['Ended', 'neutral'],
  unscheduled: ['Unscheduled', 'info'],
}

function EventDetail({ eventId, onDeleted }: { eventId: string; onDeleted: () => void }) {
  const { token } = useAuth()
  const api = useApi()
  const prefix = useDemoPrefix()

  const [event, setEvent] = useState<any>(null)

  const [eventPresets, setEventPresets] = useState<{ eventId: string; schedules: EventPresetSchedule[]; presets: ScenePresetOption[]; showings: EventShowing[] }>({ eventId, schedules: [], presets: [], showings: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // edit form
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [editTz, setEditTz] = useState('')
  const [saving, setSaving] = useState(false)

  // scenes
  const [allScenes, setAllScenes] = useState<any[]>([])
  const [linkSceneId, setLinkSceneId] = useState('')
  const [linking, setLinking] = useState(false)

  // giveaways
  const [allGiveaways, setAllGiveaways] = useState<any[]>([])
  const [linkGiveawayId, setLinkGiveawayId] = useState('')
  const [linkingGiveaway, setLinkingGiveaway] = useState(false)

  // delete
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!token) return
    loadEvent()
    api.getScenes().then((d) => setAllScenes(d.scenes)).catch(() => {})
    api.getGiveaways().then((d) => setAllGiveaways(d.giveaways)).catch(() => {})
  }, [token, eventId])

  async function loadEvent() {
    setLoading(true)
    try {
      const { event: ev, presetSchedules, scenePresets, showings } = await api.getEvent(eventId)
      setEvent(ev)
      setEventPresets({ eventId, schedules: presetSchedules ?? [], presets: scenePresets ?? [], showings: showings ?? [] })
      setEditName(ev.name)
      setEditDesc(ev.description || '')
      setEditStart(ev.startTime ? toLocalInput(ev.startTime) : '')
      setEditEnd(ev.endTime ? toLocalInput(ev.endTime) : '')
      setEditTz(ev.timezone || 'UTC')
    } catch {
      setError('Failed to load event')
    }
    setLoading(false)
  }

  function toLocalInput(iso: string) {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const { event: updated } = await api.updateEvent(eventId, {
        name: editName.trim(),
        description: editDesc.trim(),
        startTime: editStart ? new Date(editStart).toISOString() : undefined,
        endTime: editEnd ? new Date(editEnd).toISOString() : undefined,
        timezone: editTz,
      })
      setEvent((prev: any) => ({ ...prev, ...updated }))
    } catch {
      setError('Failed to save')
    }
    setSaving(false)
  }

  const handleDelete = async () => {
    await api.deleteEvent(eventId)
    onDeleted()
  }

  const handleLinkScene = async () => {
    if (!linkSceneId) return
    setLinking(true)
    try {
      await api.linkSceneToEvent(eventId, linkSceneId)
      await loadEvent()
      setLinkSceneId('')
    } catch {
      setError('Failed to link scene')
    }
    setLinking(false)
  }

  const handleUnlinkScene = async (sceneId: string) => {
    try {
      await api.unlinkSceneFromEvent(eventId, sceneId)
      await loadEvent()
    } catch {
      setError('Failed to unlink scene')
    }
  }

  const handleLinkGiveaway = async () => {
    if (!linkGiveawayId) return
    setLinkingGiveaway(true)
    try {
      await api.linkGiveawayToEvent(eventId, linkGiveawayId)
      await loadEvent()
      setLinkGiveawayId('')
    } catch {
      setError('Failed to link giveaway')
    }
    setLinkingGiveaway(false)
  }

  const handleUnlinkGiveaway = async (giveawayId: string) => {
    try {
      await api.unlinkGiveawayFromEvent(eventId, giveawayId)
      await loadEvent()
    } catch {
      setError('Failed to unlink giveaway')
    }
  }

  if (loading) return <Skeleton />
  if (error && !event) return <p className="text-red-400">{error}</p>
  if (!event) return <p className="text-gray-400">Event not found.</p>

  const linkedSceneIds = new Set(
    (event.sceneLinks || []).map((l: any) => l.sceneId)
  )
  const availableScenes = allScenes.filter((s) => !linkedSceneIds.has(s.id))

  const linkedGiveawayIds = new Set(
    (event.giveawayLinks || []).map((l: any) => l.giveawayId)
  )
  const availableGiveaways = allGiveaways.filter((g) => !linkedGiveawayIds.has(g.id))

  const [timingLabel, timingTone] = TIMING_BADGE[eventTiming(event)]

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={['Workspace', { label: 'Events', href: `${prefix}/events` }, event.name]}
        title={event.name}
        subtitle={event.description || undefined}
        actions={<Badge tone={timingTone}>{timingLabel}</Badge>}
      />

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Edit form */}
      <form onSubmit={handleUpdate} className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold">Edit Event</h2>
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          placeholder="Event name"
          className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
        />
        <input
          type="text"
          value={editDesc}
          onChange={(e) => setEditDesc(e.target.value)}
          placeholder="Description"
          className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Start time</label>
            <input
              type="datetime-local"
              value={editStart}
              onChange={(e) => setEditStart(e.target.value)}
              className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">End time</label>
            <input
              type="datetime-local"
              value={editEnd}
              onChange={(e) => setEditEnd(e.target.value)}
              className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Timezone</label>
            <input
              type="text"
              value={editTz}
              onChange={(e) => setEditTz(e.target.value)}
              className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </form>

      {/* Linked scenes */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold mb-3">Linked Scenes</h2>
        {(event.sceneLinks || []).length === 0 ? (
          <p className="text-sm text-gray-500">No scenes linked to this event.</p>
        ) : (
          <ul className="space-y-2 mb-4">
            {(event.sceneLinks || []).map((link: any) => (
              <li key={link.sceneId} className="rounded-md bg-gray-800 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm">{link.scene?.name || link.sceneId}</span>
                  <button
                    onClick={() => handleUnlinkScene(link.sceneId)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Unlink
                  </button>
                </div>
                <EventPresets sceneId={link.sceneId} data={eventPresets} onChanged={loadEvent} />
                <EventShowings sceneId={link.sceneId} showings={eventPresets.showings} />
              </li>
            ))}
          </ul>
        )}

        {availableScenes.length > 0 && (
          <div className="flex gap-2">
            <select
              value={linkSceneId}
              onChange={(e) => setLinkSceneId(e.target.value)}
              className="flex-1 rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 border border-gray-800"
            >
              <option value="">Select a scene to link...</option>
              {availableScenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              onClick={handleLinkScene}
              disabled={!linkSceneId || linking}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {linking ? 'Linking...' : 'Link Scene'}
            </button>
          </div>
        )}
      </div>

      {/* Linked giveaways */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold mb-3">Linked Giveaways</h2>
        {(event.giveawayLinks || []).length === 0 ? (
          <p className="text-sm text-gray-500">No giveaways linked to this event.</p>
        ) : (
          <ul className="space-y-2 mb-4">
            {(event.giveawayLinks || []).map((link: any) => (
              <li key={link.giveawayId} className="flex items-center justify-between rounded-md bg-gray-800 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{link.giveaway?.name || link.giveawayId}</span>
                  <Badge tone={link.giveaway?.enabled ? 'success' : 'neutral'}>{link.giveaway?.enabled ? 'Enabled' : 'Disabled'}</Badge>
                </div>
                <button
                  onClick={() => handleUnlinkGiveaway(link.giveawayId)}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        )}

        {availableGiveaways.length > 0 && (
          <div className="flex gap-2">
            <select
              value={linkGiveawayId}
              onChange={(e) => setLinkGiveawayId(e.target.value)}
              className="flex-1 rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 border border-gray-800"
            >
              <option value="">Select a giveaway to link...</option>
              {availableGiveaways.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <button
              onClick={handleLinkGiveaway}
              disabled={!linkGiveawayId || linkingGiveaway}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {linkingGiveaway ? 'Linking...' : 'Link Giveaway'}
            </button>
          </div>
        )}
      </div>

      {/* Delete */}
      <div className="rounded-lg border border-red-900/50 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold text-red-400 mb-2">Danger Zone</h2>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="rounded-md bg-red-600/20 px-4 py-2 text-sm text-red-400 hover:bg-red-600/30"
          >
            Delete Event
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-gray-400">Are you sure? This cannot be undone.</p>
            <button
              onClick={handleDelete}
              className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
            >
              Confirm Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Scheduled showings that play when this event starts in one linked scene (LIV-87); they're set up on the scene's screens. */
function EventShowings({ sceneId, showings }: { sceneId: string; showings: EventShowing[] }) {
  const mine = eventShowingsFor(sceneId, showings)
  if (mine.length === 0) return null
  return (
    <div className="mt-2 space-y-1 border-t border-gray-700 pt-2 text-xs text-gray-300">
      {mine.map((s) => (
        <div key={s.id} className="flex items-center justify-between">
          <span>Showing when this event starts: {eventShowingLabel(s)}</span>
          <Link href={`/scenes/${sceneId}`} className="text-gray-400 hover:text-white">Edit on the scene</Link>
        </div>
      ))}
    </div>
  )
}

/** Presets that go live during this event in one linked scene (LIV-86); they follow the event's times. */
function EventPresets({ sceneId, data, onChanged }: { sceneId: string; data: { eventId: string; schedules: EventPresetSchedule[]; presets: ScenePresetOption[] }; onChanged: () => void }) {
  const api = useApi()
  const { scheduled, choices } = eventPresetsFor(sceneId, data.schedules, data.presets)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await work(); setPick(''); onChanged() } catch (e: any) { setError(e?.body?.message || e?.message || 'Something went wrong') } finally { setBusy(false) }
  }
  if (scheduled.length === 0 && choices.length === 0) return null
  return (
    <div className="mt-2 space-y-1 border-t border-gray-700 pt-2 text-xs text-gray-300">
      {scheduled.map((s) => (
        <div key={s.id} className="flex items-center justify-between">
          <span>Live during this event: {eventPresetLabel(s, presetDisplayName)}</span>
          <button type="button" disabled={busy} className="text-gray-400 hover:text-red-300" onClick={() => run(() => api.deletePresetSchedule(s.id))}>Remove</button>
        </div>
      ))}
      {choices.length > 0 && (
        <div className="flex items-center gap-2">
          <select aria-label="Preset to use during this event" value={pick} onChange={(e) => setPick(e.target.value)} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white">
            <option value="">Use a preset during this event…</option>
            {choices.map((p) => <option key={p.id} value={p.id}>{presetDisplayName(p.name)}</option>)}
          </select>
          <button type="button" disabled={!pick || busy} className="rounded-md border border-gray-700 px-2 py-1 hover:border-gray-500 disabled:opacity-50"
            onClick={() => run(() => api.createPresetSchedule(sceneId, { presetId: pick, eventId: data.eventId }))}>Add</button>
        </div>
      )}
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </div>
  )
}
