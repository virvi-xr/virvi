import type { EventAttendanceReport } from '@virvixr/shared'

/** "<1 min", "25 min", "1 h 5 min": how long someone was at the event. */
export function presentLabel(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 1) return '<1 min'
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

/**
 * One CSV cell. Quotes cells with commas, quotes or line breaks, and defuses a leading = + - @ (or tab/CR) so a
 * display name can't run as a spreadsheet formula.
 */
export function csvCell(v: string | number | boolean | null): string {
  if (v === null) return ''
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** LIV-38: the event's attendee list as a CSV, times in UTC. */
export function attendanceCsv(r: EventAttendanceReport): string {
  const head = ['Name', 'Wallet', 'Verified wallet', 'Guest', 'Location', 'First seen (UTC)', 'Minutes present', 'Visitor ID']
  const rows = r.attendees.map((a) => [
    a.displayName, a.wallet, a.verified ? 'yes' : 'no', a.isGuest ? 'yes' : 'no', a.location,
    `${a.firstSeenAt.slice(0, 10)} ${a.firstSeenAt.slice(11, 16)}`, Math.round(a.secondsPresent / 60), a.visitorId,
  ].map(csvCell).join(','))
  return [head.join(','), ...rows].join('\r\n') + '\r\n'
}

/** virvi-attendance-launch-party-2026-11-19.csv */
export function attendanceFileName(name: string, from: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event'
  return `virvi-attendance-${slug}-${from.slice(0, 10)}.csv`
}
