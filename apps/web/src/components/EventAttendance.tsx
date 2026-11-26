'use client'

import { useEffect, useState } from 'react'
import type { EventAttendanceReport } from '@virvixr/shared'
import type { useApi } from '@/lib/api'
import { attendanceCsv, attendanceFileName, presentLabel } from '@/lib/analytics/attendance'
import { downloadText } from '@/lib/download'
import { TableScroll } from '@/components/ui'

const SHOWN = 50

/**
 * LIV-38: who was in the event's linked scenes between its start and end, from the scenes' visitor analytics.
 * Names and wallets appear only where the location shows wallets and the visitor allowed it.
 */
export default function EventAttendance({ event, api }: { event: { id: string; name: string; startTime?: string | null; endTime?: string | null }; api: ReturnType<typeof useApi> }) {
  const [report, setReport] = useState<EventAttendanceReport | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [all, setAll] = useState(false)
  const started = !!event.startTime && new Date(event.startTime).getTime() <= Date.now()
  const ready = started && !!event.endTime

  function load() {
    setLoading(true)
    setFailed(false)
    api.getEventAttendance(event.id).then(setReport, () => setFailed(true)).finally(() => setLoading(false))
  }
  useEffect(() => {
    setReport(null)
    if (ready) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, event.startTime, event.endTime])

  const live = ready && new Date(event.endTime!).getTime() > Date.now()
  const rows = report ? (all ? report.attendees : report.attendees.slice(0, SHOWN)) : []
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Who came</h2>
        {report && (
          <div className="flex gap-2">
            {live && (
              <button type="button" onClick={load} disabled={loading}
                className="rounded-md border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50">
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
            {report.attendees.length > 0 && (
              <button type="button" onClick={() => downloadText(attendanceCsv(report), attendanceFileName(event.name, report.from))}
                className="rounded-md border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-500 hover:text-white">
                Download CSV
              </button>
            )}
          </div>
        )}
      </div>

      {!event.startTime || !event.endTime ? (
        <p className="text-sm text-gray-500">Set a start and end time above to see who came to this event.</p>
      ) : !started ? (
        <p className="text-sm text-gray-500">Once the event starts, this shows who is in its linked scenes.</p>
      ) : failed ? (
        <p className="text-sm text-red-400">Couldn’t load who came. Try again in a moment.</p>
      ) : !report ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : report.locations === 0 ? (
        <p className="text-sm text-gray-500">None of this event’s linked scenes has visitor analytics yet. Link a scene that’s set up in Analytics to see who came.</p>
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Visitors" value={report.totals.visitors} />
            <Stat label="Verified wallets" value={report.totals.verifiedVisitors} />
            <Stat label="Most at once" value={report.totals.peakConcurrent} />
            <Stat label="Average stay" value={report.totals.visitors ? presentLabel(report.totals.avgSecondsPresent) : '–'} />
          </dl>
          {report.attendees.length === 0 ? (
            <p className="text-sm text-gray-500">Nobody has been in the linked scenes during the event{live ? ' yet' : ''}.</p>
          ) : (
            <TableScroll label="Who came">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-gray-500">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-normal">Visitor</th>
                    <th scope="col" className="py-1 pr-3 font-normal">Wallet</th>
                    {report.locations > 1 && <th scope="col" className="py-1 pr-3 font-normal">Where</th>}
                    <th scope="col" className="py-1 pr-3 font-normal">Arrived</th>
                    <th scope="col" className="py-1 text-right font-normal">Stayed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={`${a.location}:${a.visitorId}`} className="border-t border-gray-800">
                      <td className="py-1.5 pr-3">{a.displayName || <span className="text-gray-500">{a.isGuest ? 'Guest' : 'Visitor'} {a.visitorId.slice(0, 6)}</span>}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs text-gray-400">
                        {a.wallet ? `${a.wallet.slice(0, 6)}…${a.wallet.slice(-4)}` : '–'}
                        {a.verified && <span className="ml-1 font-sans text-green-400" title="Verified wallet">✓</span>}
                      </td>
                      {report.locations > 1 && <td className="py-1.5 pr-3 text-gray-400">{a.location}</td>}
                      <td className="py-1.5 pr-3 text-gray-400">{new Date(a.firstSeenAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td>
                      <td className="py-1.5 text-right">{presentLabel(a.secondsPresent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.attendees.length > SHOWN && (
                <button type="button" onClick={() => setAll(!all)} className="mt-2 text-sm text-blue-400 hover:text-blue-300">
                  {all ? 'Show fewer' : `Show all ${report.attendees.length}`}
                </button>
              )}
            </TableScroll>
          )}
          {report.truncated && <p className="text-xs text-amber-400">The list shows the first {report.attendees.length} visitors by time spent. The numbers above count everyone.</p>}
          <p className="text-xs text-gray-500">Counts visits to this event’s linked scenes between its start and end. Names and wallets appear only where the scene shows wallets in Analytics and the visitor allowed it.</p>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md bg-gray-800 px-3 py-2">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  )
}
