import { describe, it, expect } from 'vitest'
import { activityActor, describeActivity, nextCursor, type SceneActivityEntry } from './scene-activity'

const entry = (over: Partial<SceneActivityEntry>): SceneActivityEntry => ({
  id: 'a1', action: 'element.created', via: 'dashboard', subject: { type: 'image', id: 'e1', name: 'Poster' }, detail: null, count: 1,
  at: '2026-11-26T10:00:00.000Z', firstAt: '2026-11-26T10:00:00.000Z', actor: { name: 'Hana', wallet: null }, ...over,
})

describe('scene activity lines (LIV-32)', () => {
  it('names what changed, in plain words', () => {
    expect(describeActivity(entry({}))).toBe('added the image “Poster”')
    expect(describeActivity(entry({ action: 'element.updated', subject: { type: 'video', id: 'e', name: 'Main' }, count: 4 }))).toBe('changed the screen “Main” (4 times)')
    expect(describeActivity(entry({ action: 'instance.updated', subject: { type: 'model', id: 'e', name: 'Couch' } }))).toBe('moved or changed a copy of the model “Couch”')
    expect(describeActivity(entry({ action: 'instances.cleared', detail: { removed: 3 } }))).toBe('removed all 3 copies of the image “Poster”')
    expect(describeActivity(entry({ action: 'scene.updated', subject: { type: 'scene', id: 's', name: 'Night Club' }, detail: { changed: ['name'], from: 'Venue' } }))).toBe('renamed the scene from “Venue” to “Night Club”')
    expect(describeActivity(entry({ action: 'preset.activated', subject: { type: 'preset', id: 'p', name: 'Late' } }))).toBe('made the preset “Late” live')
    expect(describeActivity(entry({ action: 'role.granted', subject: { type: 'wallet', id: '0x1234567890abcdef1234567890abcdef12345678', name: null }, detail: { role: 'cohost', from: 'editor' } })))
      .toBe('made 0x1234…5678 co-host (was editor)')
    expect(describeActivity(entry({ action: 'collaborator.removed', subject: { type: 'user', id: 'u', name: 'Pal' }, detail: { role: 'viewer', left: true } }))).toBe('left the scene')
    expect(describeActivity(entry({ action: 'deploy.started', subject: { type: 'destination', id: 'd', name: 'club.dcl.eth' }, detail: { signed: false } }))).toBe('deployed to club.dcl.eth')
    expect(describeActivity(entry({ action: 'something.new' }))).toBe('made a change')
  })

  it('names the person by their Virvi name, else their wallet', () => {
    expect(activityActor(entry({}))).toBe('Hana')
    expect(activityActor(entry({ actor: { name: null, wallet: '0x1234567890abcdef1234567890abcdef12345678' } }))).toBe('0x1234…5678')
    expect(activityActor(entry({ actor: { name: null, wallet: null } }))).toBe('Someone')
  })

  it('pages back from the last entry', () => {
    expect(nextCursor([entry({ id: 'x', at: '2026-11-26T09:00:00.000Z' })])).toBe('2026-11-26T09:00:00.000Z,x')
    expect(nextCursor([])).toBeUndefined()
  })
})
