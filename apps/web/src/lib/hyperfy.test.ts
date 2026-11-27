import { describe, it, expect } from 'vitest'
import type { HyperfyWorldSummary } from '@virvixr/shared'
import { appVersionNote, lastSeenLabel, setupSteps, hyperfyErrorMessage, removeWorldPrompt, worldStatusLabel, slotLine, noSlotsLine, destroyWorldPrompt } from './hyperfy'

const now = new Date('2026-10-20T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

describe('lastSeenLabel', () => {
  it('says never connected for null', () => {
    expect(lastSeenLabel(null, now)).toBe('Never connected')
  })
  it('says connected just now under 2 minutes', () => {
    expect(lastSeenLabel(ago(30_000), now)).toBe('Connected just now')
    expect(lastSeenLabel(ago(119_000), now)).toBe('Connected just now')
  })
  it('uses minutes under an hour', () => {
    expect(lastSeenLabel(ago(5 * 60_000), now)).toBe('Last seen 5 min ago')
  })
  it('uses hours under a day', () => {
    expect(lastSeenLabel(ago(3 * 3_600_000), now)).toBe('Last seen 3 h ago')
  })
  it('uses the date after a day', () => {
    expect(lastSeenLabel('2026-10-18T12:00:00Z', now)).toBe('Last seen Oct 18')
  })
})

describe('setupSteps', () => {
  it('gives the four steps with the feed url', () => {
    expect(setupSteps('https://api.virvi.io')).toEqual([
      'Download the Virvi app and drag virvi.hyp into your Hyperfy world.',
      "Open the app's settings and paste your world key into Virvi world key.",
      'Leave Virvi feed URL as https://api.virvi.io unless Virvi support tells you otherwise.',
      'Your scene appears within a few seconds and follows your edits.',
    ])
  })
})

describe('removeWorldPrompt', () => {
  it('says the world keeps its last scene but stops receiving updates', () => {
    expect(removeWorldPrompt('Gallery')).toBe('Remove "Gallery"? The Virvi app in that world stops receiving updates from Virvi.')
  })
})

describe('hyperfyErrorMessage', () => {
  it('explains an upgrade is needed', () => {
    expect(hyperfyErrorMessage(new Error('upgrade_required'))).toMatch(/plan/i)
  })
  it('explains a too-long name', () => {
    const err = 'name is required (up to 100 characters)'
    expect(hyperfyErrorMessage(Object.assign(new Error(err), { status: 400, body: { error: err } }))).toMatch(/100/)
  })
  it('falls back', () => {
    expect(hyperfyErrorMessage(new Error('API error 500'))).toBe('Something went wrong. Try again in a moment.')
  })
})

const world = (over: Partial<HyperfyWorldSummary>): HyperfyWorldSummary => ({
  id: 'w1', sceneId: 's1', name: 'Gallery', kind: 'hosted', address: 'gallery.worlds.virvi.io', status: 'running',
  errorMessage: null, keyPrefix: 'virviw_abcdefg', createdAt: '2026-10-01T00:00:00Z', lastSeenAt: null, app: null,
  endsAt: null, endedAt: null, purgeAfter: null, ...over,
})

describe('worldStatusLabel', () => {
  it('says setting up while provisioning', () => {
    expect(worldStatusLabel(world({ status: 'provisioning' }), now)).toBe('Setting up…')
  })
  it('says live when running', () => {
    expect(worldStatusLabel(world({ status: 'running' }), now)).toBe('Live')
  })
  it('shows the failure message', () => {
    expect(worldStatusLabel(world({ status: 'failed', errorMessage: 'The world did not start' }), now)).toBe('Failed: The world did not start')
  })
  it('says just Failed without a message', () => {
    expect(worldStatusLabel(world({ status: 'failed' }), now)).toBe('Failed')
  })
  it('gives the restore deadline in UTC for an ended world', () => {
    expect(worldStatusLabel(world({ status: 'ended', purgeAfter: '2026-11-17T23:30:00Z' }), now)).toBe('Ended. Restorable until Nov 17')
  })
  it('says just Ended once the restore window has passed or is unknown', () => {
    expect(worldStatusLabel(world({ status: 'ended', purgeAfter: '2026-10-19T00:00:00Z' }), now)).toBe('Ended')
    expect(worldStatusLabel(world({ status: 'ended' }), now)).toBe('Ended')
  })
})

describe('slotLine', () => {
  it('shows used of limit', () => {
    expect(slotLine(1, 3)).toBe('1 of 3 hosted worlds')
    expect(slotLine(0, 1)).toBe('0 of 1 hosted worlds')
  })
  it('drops the limit when unlimited', () => {
    expect(slotLine(1, Infinity)).toBe('1 hosted world')
    expect(slotLine(4, Infinity)).toBe('4 hosted worlds')
  })
  it('shows no count when the plan has no hosted worlds (not "0 of 0")', () => {
    expect(slotLine(0, 0)).toBeNull()
  })
})

describe('noSlotsLine', () => {
  it("says the plan doesn't include hosted worlds when the limit is 0", () => {
    expect(noSlotsLine(0)).toBe("Your plan doesn't include hosted worlds.")
  })
  it('says all are used otherwise', () => {
    expect(noSlotsLine(3)).toBe("You've used all your hosted worlds.")
  })
})

describe('destroyWorldPrompt', () => {
  it('says the world and everything built in it are deleted and cannot be restored', () => {
    expect(destroyWorldPrompt('Gallery')).toBe('Destroy "Gallery"? The world and everything built in it are deleted and can\'t be restored.')
  })
})

describe('hyperfyErrorMessage for hosted worlds', () => {
  const apiErr = (code: string, status: number, body: Record<string, unknown> = {}) =>
    Object.assign(new Error(code), { status, body: { error: code, ...body } })
  it('explains hosting is unavailable', () => {
    expect(hyperfyErrorMessage(apiErr('hyperfy_hosting_unavailable', 503))).toMatch(/not available/i)
  })
  it('explains the world limit with the counts', () => {
    expect(hyperfyErrorMessage(apiErr('world_limit_reached', 403, { used: 3, limit: 3 }))).toMatch(/3 of 3/)
  })
  it("says the plan doesn't include hosted worlds when the limit is 0", () => {
    const msg = hyperfyErrorMessage(apiErr('world_limit_reached', 403, { used: 0, limit: 0 }))
    expect(msg).toMatch(/plan doesn't include hosted worlds/)
    expect(msg).not.toMatch(/0 of 0/)
  })
  it('explains a world that cannot be restored', () => {
    expect(hyperfyErrorMessage(apiErr('not_restorable', 409))).toMatch(/can't be restored/)
  })
  it('explains an already ended world', () => {
    expect(hyperfyErrorMessage(apiErr('already_ended', 409))).toMatch(/ended/)
  })
  it('passes through the server message for a failed update', () => {
    expect(hyperfyErrorMessage(apiErr('world_update_failed', 502, { message: 'The world did not restart.' }))).toBe('The world did not restart.')
  })
  it('explains a restore whose machines will not start', () => {
    expect(hyperfyErrorMessage(apiErr('restore_failed', 502))).toMatch(/start/)
  })
})

describe('hyperfyErrorMessage for bad requests', () => {
  const bad = (error: string) => Object.assign(new Error(error), { status: 400, body: { error } })
  it('names the real problem instead of always blaming the name', () => {
    expect(hyperfyErrorMessage(bad('name is required (up to 100 characters)'))).toBe('Give the world a name of 100 characters or fewer.')
    expect(hyperfyErrorMessage(bad('endsAt must be a future ISO date, or null'))).toBe('Pick an end date in the future, or leave it empty.')
    expect(hyperfyErrorMessage(bad('Body cannot be empty when content-type is set to \'application/json\''))).toBe('Something went wrong. Try again in a moment.')
  })
})

describe('appVersionNote (LIV-33)', () => {
  it('says nothing before the world connects', () => {
    expect(appVersionNote(null)).toEqual({ current: null, behind: null })
  })
  it('shows the release when up to date', () => {
    expect(appVersionNote({ version: '1.0.0', latest: '1.0.0', behind: false })).toEqual({ current: 'Virvi app 1.0.0', behind: null })
  })
  it('asks for a fresh download when behind', () => {
    expect(appVersionNote({ version: '1.0.0', latest: '1.1.0', behind: true }).behind)
      .toBe('This world runs Virvi app 1.0.0; 1.1.0 is out. Download the app again and drag it into the world to replace the old one.')
    expect(appVersionNote({ version: null, latest: '1.0.0', behind: true }).behind).toMatch(/^This world runs an older Virvi app\. Download/)
  })
})
