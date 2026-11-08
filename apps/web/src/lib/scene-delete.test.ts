import { describe, it, expect } from 'vitest'
import {
  checkboxNote, chosenIds, deleteIntro, eventLine, initialChecks, nameMatches, purgeDateText, removalStatusText, restoredNote, signRemoval,
  unfinished, upcomingWarning, type Removal, type RemovalSignApi, type RunningItem,
} from './scene-delete'

const item = (over: Partial<RunningItem>): RunningItem => ({ id: 'x', kind: 'dcl_world', label: 'Remove the scene from cafe.dcl.eth', defaultChecked: true, needsSignature: false, ...over })
const removal = (over: Partial<Removal>): Removal => ({ id: 'r', kind: 'dcl_world', label: 'Remove the scene from cafe.dcl.eth', status: 'done', errorMessage: null, finishedAt: null, ...over })

describe('delete dialog checkboxes', () => {
  it('open as the server says: a Decentraland scene that is the owner\'s own work is unticked', () => {
    const checks = initialChecks([item({ id: 'a' }), item({ id: 'b', defaultChecked: false, ownContent: true }), item({ id: 'h', kind: 'hosted_world', label: 'Shut down moon' })])
    expect(checks).toEqual({ a: true, b: false, h: true })
    expect(chosenIds(checks)).toEqual(['a', 'h'])
  })

  it('say what ticking and unticking each kind does', () => {
    expect(checkboxNote(item({ kind: 'hosted_world' }), true)).toBe("Shut down for good. It won't come back if you restore the scene.")
    expect(checkboxNote(item({ kind: 'hosted_world' }), false)).toMatch(/Keeps running while the scene is deleted.*shuts down when the scene is deleted for good/)
    expect(checkboxNote(item({ kind: 'hyperfy_world' }), true)).toBe('Virvi stops serving this world. Remove the Virvi app inside Hyperfy as well.')
    expect(checkboxNote(item({}), false)).toBe('Left up as it is. It shows nothing from Virvi while the scene is deleted.')
    expect(checkboxNote(item({ ownContent: true }), false)).toMatch(/^What's live there is your own scene, so it's left as it is/)
    expect(checkboxNote(item({ ownContent: true, needsSignature: true }), true))
      .toBe("What's live there is your own scene: this removes your own work too. The scene is taken off the World, signed with your wallet, and it's disconnected from this scene so you can use it elsewhere. Restoring doesn't bring it back.")
    expect(checkboxNote(item({ kind: 'dcl_parcels' }), true)).toMatch(/^An empty scene is published over the parcels, and it's disconnected/)
  })
})

describe('dates and warnings', () => {
  const now = new Date('2026-11-08T12:00:00Z')
  it('the purge date, with how long is left', () => {
    expect(purgeDateText('2026-12-08T12:00:00Z', now)).toBe('Deleted for good on 8 December 2026 (in 30 days)')
    expect(purgeDateText('2026-11-09T10:00:00Z', now)).toBe('Deleted for good on 9 November 2026 (tomorrow)')
    expect(purgeDateText('2026-11-08T11:00:00Z', now)).toBe('Deleted for good on 8 November 2026 (today)')
  })

  it('warns about upcoming events, one or several', () => {
    expect(upcomingWarning([])).toBeNull()
    const ev = { id: '1', name: 'Opening', startsAt: '2026-11-12T19:00:00Z', endsAt: null, kind: 'event' as const }
    expect(upcomingWarning([ev])).toBe("This scene has an upcoming event. While it's deleted, it is suspended: bookings don't go live and their crews can't get in.")
    expect(upcomingWarning([ev, { ...ev, id: '2' }])).toMatch(/^This scene has 2 upcoming events\. While it's deleted, they are suspended/)
    expect(eventLine(ev)).toBe('Opening, 12 November 2026')
    expect(eventLine({ ...ev, startsAt: null })).toBe('Opening')
  })

  it('the intro names the last day to restore', () => {
    expect(deleteIntro('2026-12-08T12:00:00Z')).toMatch(/restore it from Recently deleted until 8 December 2026\. Your media and assets stay in your libraries\.$/)
  })
})

describe('typing the name', () => {
  it('must match exactly; surrounding spaces are ignored', () => {
    expect(nameMatches('Gallery', 'Gallery')).toBe(true)
    expect(nameMatches('  Gallery ', 'Gallery')).toBe(true)
    expect(nameMatches('gallery', 'Gallery')).toBe(false)
    expect(nameMatches('', '')).toBe(false)
  })
})

describe('removals', () => {
  it('status lines, and which still need Sign or Retry', () => {
    expect(removalStatusText(removal({}))).toBe('Done')
    expect(removalStatusText(removal({ status: 'awaiting_signature' }))).toBe('Waiting for your wallet to sign')
    expect(removalStatusText(removal({ status: 'failed', errorMessage: 'Decentraland refused it: Unauthorized' }))).toBe("Didn't work: Decentraland refused it: Unauthorized")
    const list = [removal({ id: '1' }), removal({ id: '2', status: 'failed' }), removal({ id: '3', status: 'awaiting_signature' })]
    expect(unfinished(list).map((r) => r.id)).toEqual(['2', '3'])
  })

  it('a restore says what did not come back', () => {
    expect(restoredNote('Gallery', [])).toBe('Restored Gallery.')
    expect(restoredNote('Gallery', [removal({}), removal({ kind: 'hosted_world', label: 'Shut down moon-base' })]))
      .toBe("Restored Gallery. What was shut down or removed when you deleted it doesn't come back: cafe.dcl.eth, moon-base.")
  })

  it("signs a World's undeploy with its timestamp, and the parcels' empty scene; expired signs again once", async () => {
    const sent: unknown[] = []
    let expireOnce = true
    const api: RemovalSignApi = {
      async getRemovalSign(_s, id) {
        return id === 'w' ? { kind: 'request', signer: '0xowner', request: { payload: 'delete:/world/x/scenes/0,0:1:{}', timestamp: 1 } } : { kind: 'entity', payload: 'bafyempty', expiresAt: '' }
      },
      async submitRemovalSignature(_s, id, body) {
        if (id === 'w' && expireOnce) {
          expireOnce = false
          throw Object.assign(new Error('expired'), { body: { error: 'expired' } })
        }
        sent.push(body)
        return { removal: removal({ id }) }
      },
    }
    const signer = { sign: (p: string) => [`signed ${p}`] }
    expect((await signRemoval('s', 'w', signer, api)).id).toBe('w')
    expect((await signRemoval('s', 'p', signer, api)).id).toBe('p')
    expect(sent).toEqual([
      { chain: ['signed delete:/world/x/scenes/0,0:1:{}'], timestamp: 1 },
      { chain: ['signed bafyempty'] },
    ])
  })
})
