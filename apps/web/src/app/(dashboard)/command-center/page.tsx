'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useCommandCenterRoom, CommandCenterStatus } from '@/lib/colyseus'
import Link from 'next/link'
import { useEffect, useState, useCallback, useRef, Suspense } from 'react'
import { Badge, PageHeader, PlatformBadge, Skeleton, type Tone } from '@/components/ui'

export default function CommandCenterPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <CommandCenterContent />
    </Suspense>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(iso: string | null) {
  if (!iso) return '--'
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function getEventStatus(event: any): { label: string; tone: Tone } {
  const now = Date.now()
  const start = event.startTime ? new Date(event.startTime).getTime() : null
  const end = event.endTime ? new Date(event.endTime).getTime() : null

  if (end && now > end) return { label: 'Ended', tone: 'neutral' }
  if (start && now >= start) return { label: 'Live', tone: 'success' }
  if (start && now < start) return { label: 'Upcoming', tone: 'warning' }
  return { label: 'Scheduled', tone: 'info' }
}


// ── Main Content ─────────────────────────────────────────────────────────────

function CommandCenterContent() {
  const { token } = useAuth()
  const api = useApi()

  const [events, setEvents] = useState<any[]>([])
  const [selectedEventId, setSelectedEventId] = useState<string>('')
  const [loading, setLoading] = useState(true)

  // REST-based status (fallback / initial load)
  const [restStatus, setRestStatus] = useState<any>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Colyseus connection
  const { connected: wsConnected, status: wsStatus, activityLog, setActivityLog, sendBroadcast } =
    useCommandCenterRoom(selectedEventId || null, token)

  // Determine which status to use: prefer WS, fall back to REST
  const liveStatus: CommandCenterStatus | null = wsStatus || (restStatus ? {
    eventId: restStatus.event?.id || null,
    worlds: (restStatus.worlds || []).map((w: any) => ({
      ...w,
      visitorCount: w.visitorCount ?? 0,
    })),
    aggregate: {
      totalVisitors: 0,
      worldCount: restStatus.aggregate?.worldCount ?? 0,
      deployedCount: restStatus.aggregate?.deployedCount ?? 0,
    },
    timestamp: Date.now(),
  } : null)

  // Load events list
  useEffect(() => {
    if (!token) return
    api.getEvents()
      .then((data) => { setEvents(data.events); setLoading(false) })
      .catch(() => setLoading(false))
  }, [token])

  // Fetch REST status when event selected (and poll if WS not connected)
  const fetchStatus = useCallback(async () => {
    if (!selectedEventId || !token) return
    try {
      const data = await api.getCommandCenterStatus(selectedEventId)
      setRestStatus(data)
    } catch {
      // silently fail; status will remain stale
    }
  }, [selectedEventId, token])

  useEffect(() => {
    if (!selectedEventId) {
      setRestStatus(null)
      return
    }
    setStatusLoading(true)
    fetchStatus().finally(() => setStatusLoading(false))

    // Poll every 10s if WS is not connected
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      if (!wsConnected) fetchStatus()
    }, 10000)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [selectedEventId, wsConnected, fetchStatus])

  // ── No event selected ────────────────────────────────────────────────────

  if (loading) return <Skeleton />

  const selectedEvent = events.find((e) => e.id === selectedEventId)

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        crumbs={['Workspace', 'Command Center']}
        title="Command Center"
        subtitle="Watch and run your live events."
        actions={<div className="flex items-center gap-3">
          {wsConnected && (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <span className="inline-block h-2 w-2 rounded-full bg-green-400 animate-pulse" />
              Live
            </span>
          )}
          <select
            value={selectedEventId}
            onChange={(e) => {
              setSelectedEventId(e.target.value)
              setActivityLog([])
            }}
            className="rounded-md border border-gray-800 bg-gray-900 px-4 py-2.5 text-sm text-gray-200 outline-none focus:border-blue-400"
          >
            <option value="">Select an event...</option>
            {events.map((evt) => (
              <option key={evt.id} value={evt.id}>
                {evt.name}
              </option>
            ))}
          </select>
        </div>}
      />

      {!selectedEventId ? (
        <NoEventSelected />
      ) : statusLoading && !liveStatus ? (
        <Skeleton rows={2} className="h-12" />
      ) : (
        <>
          {selectedEvent && <EventInfoBar event={selectedEvent} />}
          <WorldGrid worlds={liveStatus?.worlds || []} aggregate={liveStatus?.aggregate} />
          <BroadcastPanel
            eventId={selectedEventId}
            wsConnected={wsConnected}
            sendBroadcast={sendBroadcast}
            api={api}
            onActivity={(msg) => setActivityLog((prev) => [{ time: Date.now(), message: msg }, ...prev.slice(0, 99)])}
          />
          <ActivityFeed log={activityLog} />
        </>
      )}
    </div>
  )
}

// ── No Event Selected ────────────────────────────────────────────────────────

function NoEventSelected() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-gray-800 bg-gray-900 p-12 text-center">
      <div className="text-4xl mb-4 text-gray-600">{ '//' }</div>
      <h2 className="text-lg font-semibold text-gray-300 mb-2">No Event Selected</h2>
      <p className="text-sm text-gray-500 mb-4">
        Select an event from the dropdown above to view its multi-world command center.
      </p>
      <Link
        href="/events"
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700"
      >
        Go to Events
      </Link>
    </div>
  )
}

// ── Event Info Bar ───────────────────────────────────────────────────────────

function EventInfoBar({ event }: { event: any }) {
  const status = getEventStatus(event)

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-gray-800 bg-gray-900 px-5 py-3">
      <h2 className="text-lg font-semibold">{event.name}</h2>
      <Badge tone={status.tone}>{status.label}</Badge>
      <div className="flex gap-4 text-xs text-gray-400 ml-auto">
        <span>Start: {formatDateTime(event.startTime)}</span>
        <span>End: {formatDateTime(event.endTime)}</span>
      </div>
    </div>
  )
}

// ── World Grid ───────────────────────────────────────────────────────────────

function WorldGrid({ worlds, aggregate }: {
  worlds: CommandCenterStatus['worlds']
  aggregate?: CommandCenterStatus['aggregate']
}) {
  if (worlds.length === 0) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-center">
        <p className="text-sm text-gray-500">No worlds linked to this event.</p>
        <Link href="/events" className="mt-2 inline-block text-sm text-blue-400 hover:text-blue-300">
          Link scenes in Event settings
        </Link>
      </div>
    )
  }

  return (
    <div>
      {aggregate && (
        <div className="mb-3 flex gap-4 text-sm text-gray-400">
          <span>{aggregate.worldCount} world{aggregate.worldCount !== 1 ? 's' : ''}</span>
          <span>{aggregate.deployedCount} deployed</span>
          <span>{aggregate.totalVisitors} total visitor{aggregate.totalVisitors !== 1 ? 's' : ''}</span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {worlds.map((world) => (
          <WorldCard key={world.sceneId} world={world} />
        ))}
      </div>
    </div>
  )
}

function WorldCard({ world }: { world: CommandCenterStatus['worlds'][number] }) {
  const isDeployed = world.deploymentStatus === 'deployed'

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
      {world.sceneThumbnailUrl && (
        <img src={world.sceneThumbnailUrl} alt="" className="aspect-video w-full rounded-md border border-gray-800 object-cover" />
      )}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-sm">{world.sceneName}</h3>
          <PlatformBadge platform={world.platform} className="mt-1" />
        </div>
        <span
          className={`mt-1 inline-block h-2.5 w-2.5 rounded-full ${isDeployed ? 'bg-green-400' : 'bg-red-400'}`}
          title={isDeployed ? 'Connected / Deployed' : 'Disconnected'}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md bg-gray-800 px-3 py-2">
          <span className="text-gray-500 block">Visitors</span>
          <span className="text-lg font-bold">{world.visitorCount}</span>
        </div>
        <div className="rounded-md bg-gray-800 px-3 py-2">
          <span className="text-gray-500 block">Status</span>
          <span className={`font-medium ${isDeployed ? 'text-green-400' : 'text-gray-400'}`}>
            {world.deploymentStatus || 'None'}
          </span>
        </div>
      </div>

      {world.activePreset && (
        <p className="text-xs text-gray-500">
          Preset: <span className="text-gray-300">{world.activePreset}</span>
        </p>
      )}
    </div>
  )
}

// ── Broadcast Panel ──────────────────────────────────────────────────────────

function BroadcastPanel({
  eventId,
  wsConnected,
  sendBroadcast,
  api,
  onActivity,
}: {
  eventId: string
  wsConnected: boolean
  sendBroadcast: (action: Record<string, unknown>) => void
  api: ReturnType<typeof useApi>
  onActivity: (msg: string) => void
}) {
  const [activeTab, setActiveTab] = useState<'message' | 'preset' | 'element'>('message')

  // Message form
  const [msgText, setMsgText] = useState('')
  const [msgColor, setMsgColor] = useState('#ffffff')
  const [msgFontSize, setMsgFontSize] = useState('24')

  // Preset form
  const [presetId, setPresetId] = useState('')

  // Element form
  const [elementId, setElementId] = useState('')
  const [elementEnabled, setElementEnabled] = useState(true)

  const [sending, setSending] = useState(false)

  const dispatch = useCallback(async (action: Record<string, unknown>, description: string) => {
    setSending(true)
    try {
      if (wsConnected) {
        sendBroadcast(action)
      } else {
        await api.broadcastToEvent(eventId, { action, targetScenes: 'all' })
      }
      onActivity(`Sent: ${description}`)
    } catch (err) {
      onActivity(`Failed: ${description}`)
    }
    setSending(false)
  }, [wsConnected, sendBroadcast, api, eventId, onActivity])

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!msgText.trim()) return
    await dispatch(
      { type: 'show_message', text: msgText.trim(), color: msgColor, fontSize: parseInt(msgFontSize) },
      `Message: "${msgText.trim()}"`,
    )
    setMsgText('')
  }

  const handleSwitchPreset = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!presetId.trim()) return
    await dispatch(
      { type: 'switch_preset', presetId: presetId.trim() },
      `Switch preset: ${presetId.trim()}`,
    )
  }

  const handleToggleElement = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!elementId.trim()) return
    await dispatch(
      { type: 'toggle_element', elementId: elementId.trim(), enabled: elementEnabled },
      `${elementEnabled ? 'Enable' : 'Disable'} element: ${elementId.trim()}`,
    )
  }

  const tabs = [
    { key: 'message' as const, label: 'Send Message' },
    { key: 'preset' as const, label: 'Switch Preset' },
    { key: 'element' as const, label: 'Toggle Element' },
  ]

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <h2 className="text-lg font-semibold mb-3">Broadcast to All Worlds</h2>

      <div className="flex gap-1 mb-4 border-b border-gray-800 pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              activeTab === tab.key
                ? 'bg-gray-800 text-white'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'message' && (
        <form onSubmit={handleSendMessage} className="space-y-3">
          <input
            type="text"
            value={msgText}
            onChange={(e) => setMsgText(e.target.value)}
            placeholder="Enter message to display..."
            className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
          />
          <div className="flex gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Color</label>
              <input
                type="color"
                value={msgColor}
                onChange={(e) => setMsgColor(e.target.value)}
                className="h-9 w-14 cursor-pointer rounded border border-gray-700 bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Font size</label>
              <input
                type="number"
                value={msgFontSize}
                onChange={(e) => setMsgFontSize(e.target.value)}
                min="8"
                max="128"
                className="w-20 rounded-md bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={sending || !msgText.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {sending ? 'Sending...' : 'Send to All Worlds'}
          </button>
        </form>
      )}

      {activeTab === 'preset' && (
        <form onSubmit={handleSwitchPreset} className="space-y-3">
          <input
            type="text"
            value={presetId}
            onChange={(e) => setPresetId(e.target.value)}
            placeholder="Preset ID to apply across all scenes..."
            className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
          />
          <button
            type="submit"
            disabled={sending || !presetId.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {sending ? 'Switching...' : 'Switch Preset on All Worlds'}
          </button>
        </form>
      )}

      {activeTab === 'element' && (
        <form onSubmit={handleToggleElement} className="space-y-3">
          <input
            type="text"
            value={elementId}
            onChange={(e) => setElementId(e.target.value)}
            placeholder="Element ID to toggle..."
            className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
          />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={elementEnabled}
                onChange={(e) => setElementEnabled(e.target.checked)}
                className="rounded border-gray-600"
              />
              {elementEnabled ? 'Enable' : 'Disable'} element
            </label>
          </div>
          <button
            type="submit"
            disabled={sending || !elementId.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {sending ? 'Toggling...' : `${elementEnabled ? 'Enable' : 'Disable'} on All Worlds`}
          </button>
        </form>
      )}
    </div>
  )
}

// ── Activity Feed ────────────────────────────────────────────────────────────

function ActivityFeed({ log }: { log: Array<{ time: number; message: string }> }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <h2 className="text-lg font-semibold mb-3">Activity Feed</h2>
      {log.length === 0 ? (
        <p className="text-sm text-gray-500">No activity yet. Broadcasts and events will appear here.</p>
      ) : (
        <div className="max-h-64 overflow-y-auto space-y-1">
          {log.map((entry, i) => (
            <div key={`${entry.time}-${i}`} className="flex items-start gap-3 text-sm py-1">
              <span className="text-xs text-gray-600 whitespace-nowrap pt-0.5">
                {new Date(entry.time).toLocaleTimeString()}
              </span>
              <span className="text-gray-300">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
