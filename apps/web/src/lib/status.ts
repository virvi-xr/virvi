/** The public status page (LIV-40): what /api/status returns, and how the page words it. */

export type ComponentState = 'up' | 'degraded' | 'down' | 'unknown'
export interface StatusDay { day: string; uptime: number | null; worst: 'up' | 'degraded' | 'down' | null }
export interface StatusComponent { key: string; label: string; note: string | null; state: ComponentState; detail: string | null; uptime: number | null; days: StatusDay[] }
export interface StatusUpdate { status: string; body: string; at: string }
export interface StatusIncident { id: string; title: string; kind: string; status: string; components: string[]; createdAt: string; resolvedAt: string | null; updates: StatusUpdate[] }
export interface StatusPage { state: ComponentState; components: StatusComponent[]; incidents: StatusIncident[]; since: string | null; generatedAt: string }

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const

export const STATE_LABEL: Record<ComponentState, string> = { up: 'Working', degraded: 'Having problems', down: 'Down', unknown: 'Not checked lately' }

/** The headline at the top of the page. */
export function headline(page: Pick<StatusPage, 'state' | 'incidents'>): string {
  const open = page.incidents.filter((i) => !i.resolvedAt)
  if (open.some((i) => i.kind === 'incident')) return 'We know about a problem and are working on it'
  if (page.state === 'down') return 'Part of Virvi is down'
  if (page.state === 'degraded') return 'Part of Virvi is having problems'
  if (open.length) return 'Everything is working. Maintenance is planned'
  return 'Everything is working'
}

/** "99.95%": two decimals, never rounded up to 100% unless it is. */
export function formatUptime(u: number | null): string {
  if (u === null) return 'No data'
  if (u >= 1) return '100%'
  return `${(Math.floor(u * 10000) / 100).toFixed(2)}%`
}

/** One day's bar: its colour and its hover text. */
export function dayBar(d: StatusDay): { tone: 'none' | 'up' | 'degraded' | 'down'; label: string } {
  const date = new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  if (d.uptime === null || d.worst === null) return { tone: 'none', label: `${date}: no data` }
  // A day with a short gap is still mostly up: only a day under 99% reads as down
  const tone = d.uptime < 0.99 ? 'down' : d.worst === 'up' ? 'up' : 'degraded'
  return { tone, label: `${date}: ${formatUptime(d.uptime)} up` }
}

export const STATUS_WORD: Record<string, string> = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' }
