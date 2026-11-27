import { describe, it, expect } from 'vitest'
import { dayBar, formatUptime, headline, type StatusIncident } from './status'

const incident = (over: Partial<StatusIncident> = {}): StatusIncident => ({
  id: 'i', title: 'T', kind: 'incident', status: 'investigating', components: [], createdAt: '', resolvedAt: null, updates: [], ...over,
})

describe('status page wording (LIV-40)', () => {
  it('formats uptime without rounding a bad day up to 100%', () => {
    expect(formatUptime(1)).toBe('100%')
    expect(formatUptime(0.99999)).toBe('99.99%')
    expect(formatUptime(0.75)).toBe('75.00%')
    expect(formatUptime(null)).toBe('No data')
  })

  it('colours a day by how much of it was up', () => {
    expect(dayBar({ day: '2026-11-26', uptime: 1, worst: 'up' })).toEqual({ tone: 'up', label: 'Nov 26: 100% up' })
    expect(dayBar({ day: '2026-11-26', uptime: 0.995, worst: 'down' }).tone).toBe('degraded')
    expect(dayBar({ day: '2026-11-26', uptime: 0.9, worst: 'down' }).tone).toBe('down')
    expect(dayBar({ day: '2026-11-26', uptime: null, worst: null })).toEqual({ tone: 'none', label: 'Nov 26: no data' })
  })

  it('leads with an open incident, then the worst component', () => {
    expect(headline({ state: 'up', incidents: [] })).toBe('Everything is working')
    expect(headline({ state: 'degraded', incidents: [incident()] })).toBe('We know about a problem and are working on it')
    expect(headline({ state: 'up', incidents: [incident({ kind: 'maintenance' })] })).toBe('Everything is working. Maintenance is planned')
    expect(headline({ state: 'up', incidents: [incident({ resolvedAt: '2026-11-26T00:00:00Z' })] })).toBe('Everything is working')
    expect(headline({ state: 'down', incidents: [] })).toBe('Part of Virvi is down')
  })
})
