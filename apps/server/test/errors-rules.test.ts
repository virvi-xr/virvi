import { describe, it, expect } from 'vitest'
import { spikeCheck } from '../src/errors/spikes.js'
import { filingReason, type FilingStats } from '../src/errors/filing.js'
import { checkThresholds } from '../src/errors/settings.js'
import { config } from '../src/config.js'

const T = config.errorThresholds

describe('spikes: 3x the usual rate for that hour of the week', () => {
  it('flags a signature running at 3x or more its usual, past the minimum count', () => {
    expect(spikeCheck(30, [10, 8, 12, 10], T)).toEqual({ spiking: true, usual: 10 })
    expect(spikeCheck(29, [10, 8, 12, 10], T).spiking).toBe(false)
  })
  it('never flags a signature with no past weeks (new ones are "new", not spikes)', () => {
    expect(spikeCheck(500, [], T).spiking).toBe(false)
  })
  it('a quiet usual counts as the minimum baseline, and a spike needs the minimum count', () => {
    expect(spikeCheck(4, [0, 0, 0, 0], T).spiking).toBe(false) // under spikeMinCount (5)
    expect(spikeCheck(5, [0, 0, 0, 0], T)).toEqual({ spiking: true, usual: 0 })
    expect(spikeCheck(5, [0, 0, 0, 0], { ...T, spikeMinBaseline: 2 }).spiking).toBe(false)
  })
})

describe('filing reasons', () => {
  const base: FilingStats = {
    source: 'web', expected: null, kind: 'crash', status: null, isNew: true, usersSinceFirstSeen: 0,
    hourUsers: 0, hourIps: 0, hourCount: 0, dayUsers: 1, dayIps: 1, spiking: false, regressed: false,
  }
  it('a new signature hitting 2 users is filed', () => {
    expect(filingReason({ ...base, usersSinceFirstSeen: 1 }, T)).toBeNull()
    expect(filingReason({ ...base, usersSinceFirstSeen: 2 }, T)).toBe('new')
  })
  it('a browser 5xx or crash is severe by 3 users or 3 addresses in an hour, never by the counts browsers send', () => {
    const old = { ...base, isNew: false }
    expect(filingReason({ ...old, hourUsers: 3 }, T)).toBe('severe')
    expect(filingReason({ ...old, hourIps: 3 }, T)).toBe('severe')
    expect(filingReason({ ...old, hourCount: 10_000 }, T)).toBeNull()
    expect(filingReason({ ...old, kind: 'api', status: 500, hourUsers: 3 }, T)).toBe('severe')
    expect(filingReason({ ...old, kind: 'api', status: 404, hourUsers: 3 }, T)).toBeNull()
  })
  it('a server 5xx is severe by 3 users or 10 times in an hour', () => {
    const srv = { ...base, source: 'server' as const, isNew: false, kind: 'server_5xx', status: 502, dayUsers: 0, dayIps: 0 }
    expect(filingReason({ ...srv, hourCount: 10 }, T)).toBe('severe')
    expect(filingReason({ ...srv, hourUsers: 3 }, T)).toBe('severe')
    expect(filingReason({ ...srv, hourCount: 9 }, T)).toBeNull()
  })
  it('spikes and regressions are filed', () => {
    expect(filingReason({ ...base, isNew: false, spiking: true }, T)).toBe('spike')
    expect(filingReason({ ...base, isNew: false, regressed: true }, T)).toBe('regression')
  })
  it('a browser error from one anonymous address files nothing, whatever it claims', () => {
    const lone = { ...base, dayUsers: 0, dayIps: 1, isNew: false }
    for (const s of [{ spiking: true }, { regressed: true }, { hourIps: 1, hourCount: 1e6 }]) expect(filingReason({ ...lone, ...s }, T)).toBeNull()
    expect(filingReason({ ...lone, dayIps: 2, spiking: true }, T)).toBe('spike')
  })
  it('expected 4xx are never filed, except as a spike; overflow never', () => {
    const exp = { ...base, kind: 'api' as const, status: 401, expected: 'session' }
    expect(filingReason({ ...exp, usersSinceFirstSeen: 50, hourUsers: 50, hourCount: 500, regressed: true }, T)).toBeNull()
    expect(filingReason({ ...exp, isNew: false, spiking: true }, T)).toBe('spike')
    expect(filingReason({ ...base, expected: 'overflow', isNew: false, spiking: true, dayUsers: 9 }, T)).toBeNull()
  })
  it('nothing is filed when filing is switched off', () => {
    expect(filingReason({ ...base, usersSinceFirstSeen: 9 }, { ...T, filing: false })).toBeNull()
  })
})

describe('threshold settings from the Errors page', () => {
  it('takes known keys in range and refuses the rest', () => {
    expect(checkThresholds({ newMinUsers: 4, spikeFactor: 2.5, filing: false })).toEqual({ ok: true, value: { newMinUsers: 4, spikeFactor: 2.5, filing: false } })
    expect(checkThresholds({ newMinUsers: 0 }).ok).toBe(false)
    expect(checkThresholds({ spikeFactor: 1 }).ok).toBe(false)
    expect(checkThresholds({ bogus: 1 }).ok).toBe(false)
    expect(checkThresholds({ quietDays: 1.5 }).ok).toBe(false)
    expect(checkThresholds('x').ok).toBe(false)
  })
})
