import { describe, it, expect } from 'vitest'
import { initialEventId, isOngoing } from './command-center'

const now = Date.parse('2026-11-17T12:00:00Z')
const ev = (id: string, startTime: string | null, endTime: string | null, createdAt = '2026-11-01T00:00:00Z') => ({ id, startTime, endTime, createdAt })

describe('Command Center opening event', () => {
  it('counts an event as live between its start and end', () => {
    expect(isOngoing(ev('a', '2026-11-17T11:00:00Z', '2026-11-17T13:00:00Z'), now)).toBe(true)
    expect(isOngoing(ev('b', '2026-11-17T13:00:00Z', '2026-11-17T14:00:00Z'), now)).toBe(false)
    expect(isOngoing(ev('c', '2026-11-17T09:00:00Z', '2026-11-17T11:00:00Z'), now)).toBe(false)
    expect(isOngoing(ev('d', null, null), now)).toBe(false)
  })

  it('counts an event with no end as live only for its first day', () => {
    expect(isOngoing(ev('a', '2026-11-17T02:00:00Z', null), now)).toBe(true)
    expect(isOngoing(ev('b', '2026-11-15T12:00:00Z', null), now)).toBe(false)
  })

  it('opens the longest-running live event, earliest created on a tie', () => {
    const events = [
      ev('later', '2026-11-17T11:00:00Z', '2026-11-17T20:00:00Z'),
      ev('tie-newer', '2026-11-17T10:00:00Z', '2026-11-17T20:00:00Z', '2026-11-05T00:00:00Z'),
      ev('tie-older', '2026-11-17T10:00:00Z', '2026-11-17T20:00:00Z', '2026-11-02T00:00:00Z'),
      ev('ended', '2026-11-17T01:00:00Z', '2026-11-17T02:00:00Z'),
    ]
    expect(initialEventId(events, null, now)).toBe('tie-older')
  })

  it('opens nothing when no event is live', () => {
    expect(initialEventId([ev('soon', '2026-11-18T00:00:00Z', null)], null, now)).toBe('')
    expect(initialEventId([], null, now)).toBe('')
  })

  it('opens the event the link names, over the live one, if the account has it', () => {
    const events = [ev('live', '2026-11-17T11:00:00Z', '2026-11-17T13:00:00Z'), ev('past', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')]
    expect(initialEventId(events, 'past', now)).toBe('past')
    expect(initialEventId(events, 'someone-elses', now)).toBe('live')
  })
})
