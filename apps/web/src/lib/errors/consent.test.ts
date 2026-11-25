import { describe, it, expect, vi } from 'vitest'
import { PRIVACY_NOTICE_VERSION, type ClientErrorEvent, type PrivacyStatus } from '@virvixr/shared'
import { HELD_MAX, ReportingGate, reportingModeFor } from './consent'

const ev = (message: string) => ({ kind: 'exception', message } as unknown as ClientErrorEvent)
const status = (decision: PrivacyStatus['decision']): PrivacyStatus => ({ version: PRIVACY_NOTICE_VERSION, decision, decidedAt: decision ? '2026-11-24T00:00:00.000Z' : null })

describe('reportingModeFor', () => {
  it('holds until sign-in is known, and reports as before for anyone the notice does not ask', () => {
    expect(reportingModeFor({ authLoading: true, signedIn: false, asked: false, status: null })).toBe('held')
    expect(reportingModeFor({ authLoading: false, signedIn: false, asked: false, status: null })).toBe('on')
    expect(reportingModeFor({ authLoading: false, signedIn: true, asked: false, status: null })).toBe('on') // a trial or a scene pass
  })

  it("follows an asked account's decision, holding while there is none or it hasn't loaded", () => {
    const base = { authLoading: false, signedIn: true, asked: true }
    expect(reportingModeFor({ ...base, status: null })).toBe('held')
    expect(reportingModeFor({ ...base, status: status(null) })).toBe('held')
    expect(reportingModeFor({ ...base, status: status('accept') })).toBe('on')
    expect(reportingModeFor({ ...base, status: status('decline') })).toBe('off')
  })
})

describe('ReportingGate', () => {
  const rig = () => {
    const out = { add: vi.fn(), crash: vi.fn(), forget: vi.fn() }
    return { out, gate: new ReportingGate(out) }
  }

  it('starts holding: records breadcrumbs, sends nothing', () => {
    const { out, gate } = rig()
    expect(gate).toMatchObject({ mode: 'held', records: true, sends: false })
    gate.add(ev('a'))
    gate.crash(ev('b'))
    expect(out.add).not.toHaveBeenCalled()
    expect(out.crash).not.toHaveBeenCalled()
  })

  it('on accept, sends what it held in order, then everything as it comes', () => {
    const { out, gate } = rig()
    gate.add(ev('a'))
    gate.crash(ev('b'))
    gate.set('on')
    expect(out.add.mock.calls.map((c) => c[0].message)).toEqual(['a'])
    expect(out.crash.mock.calls.map((c) => c[0].message)).toEqual(['b'])
    gate.add(ev('c'))
    expect(out.add).toHaveBeenCalledTimes(2)
    expect(gate.sends).toBe(true)
  })

  it('on decline, discards what it held and the breadcrumbs, records nothing and sends nothing', () => {
    const { out, gate } = rig()
    gate.add(ev('a'))
    gate.set('off')
    expect(out.forget).toHaveBeenCalledTimes(1)
    expect(gate).toMatchObject({ records: false, sends: false })
    gate.add(ev('b'))
    gate.crash(ev('c'))
    gate.set('on') // a later accept (Settings) starts afresh: nothing from before comes back
    expect(out.add).not.toHaveBeenCalled()
    expect(out.crash).not.toHaveBeenCalled()
  })

  it('holds a bounded number of errors', () => {
    const { out, gate } = rig()
    for (let i = 0; i < HELD_MAX + 10; i++) gate.add(ev(String(i)))
    gate.set('on')
    expect(out.add).toHaveBeenCalledTimes(HELD_MAX)
  })
})
