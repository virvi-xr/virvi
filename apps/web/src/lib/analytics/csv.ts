import type { TimeseriesPoint } from './types'

/**
 * LIV-38: the "Visitors over time" numbers as a CSV, for spreadsheets and advertiser reports. Totals per hour or day
 * only, the same numbers the chart shows: nothing about any one visitor. Times are UTC, as the server buckets them.
 */
export function timeseriesCsv(points: TimeseriesPoint[], bucket: 'hour' | 'day'): string {
  const head = [bucket === 'day' ? 'Date (UTC)' : 'Hour (UTC)', 'Visitors', 'Sessions', 'Peak at once', 'Average time (seconds)']
  const rows = points.map((p) => {
    const iso = new Date(p.t).toISOString()
    const when = bucket === 'day' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
    return [when, p.uniqueVisitors, p.sessions, p.peakConcurrency, p.dwellAvgSec].join(',')
  })
  return [head.join(','), ...rows].join('\r\n') + '\r\n'
}

/** A file name from the location's name and the range: virvi-visitors-my-scene-2026-11-01-to-2026-11-07.csv. */
export function csvFileName(title: string, from: string, to: string): string {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'scene'
  const day = (s: string) => s.slice(0, 10)
  return `virvi-visitors-${slug}-${day(from)}-to-${day(to)}.csv`
}
