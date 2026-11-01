import { describe, it, expect } from 'vitest'
import {
  EMOTES, emoteChecklist, emoteLabel, emoteState, orbitDrag, orbitFrame, orbitKey, refusalMessage, setViewKey, stepsFor,
  type StudioDetail,
} from './studio'

const NOW = new Date('2026-11-01T12:00:00Z')
const detail = (over: Partial<StudioDetail> = {}): StudioDetail => ({
  design: { id: 'd1', name: 'Cap', kind: 'wearable', agent: 'claude', status: 'idle', archivedAt: null, lastJobAt: null, finalizedAt: null, createdAt: NOW.toISOString() },
  pieces: [], messages: [], activeJob: null, lastPrompt: null, uploads: [],
  set: { revisions: 'a,b', views: {}, checks: [], freeFixesLeft: {} }, ...over,
})

describe('inspect frames', () => {
  it('maps the on-screen rows to the worker’s frame order', () => {
    expect(orbitFrame(3, 5, 122)).toBe(5) // eye level
    expect(orbitFrame(1, 5, 122)).toBe(77) // 30°
    expect(orbitFrame(2, 0, 122)).toBe(24) // 60°
    expect(orbitFrame(5, 23, 122)).toBe(119) // 150°
    expect(orbitFrame(0, 9, 122)).toBe(120) // straight down, any column
    expect(orbitFrame(6, 3, 122)).toBe(121) // straight up
  })

  it('stops at the nearest rendered row while the sphere renders', () => {
    expect(orbitFrame(1, 4, 24)).toBe(4)
    expect(orbitFrame(6, 4, 24)).toBe(4)
    expect(orbitFrame(3, 4, 0)).toBe(0)
  })

  it('a drag wraps round and stops at the poles', () => {
    expect(orbitDrag({ row: 3, col: 0 }, 400, 0, 400, 300)).toEqual({ row: 3, col: 0 }) // one width is a full turn
    expect(orbitDrag({ row: 3, col: 0 }, 50, 0, 400, 300)).toEqual({ row: 3, col: 21 })
    expect(orbitDrag({ row: 3, col: 2 }, -100, 0, 400, 300)).toEqual({ row: 3, col: 8 })
    expect(orbitDrag({ row: 3, col: 0 }, 0, 100, 400, 300)).toEqual({ row: 1, col: 0 }) // drag down: look from above
    expect(orbitDrag({ row: 3, col: 0 }, 0, 900, 400, 300)).toEqual({ row: 0, col: 0 })
    expect(orbitDrag({ row: 3, col: 0 }, 0, -900, 400, 300)).toEqual({ row: 6, col: 0 })
  })

  it('view keys mirror the server', () => {
    expect(orbitKey('female')).toBe('orbit-female')
    expect(setViewKey('wearable', { bodyShape: 'male', outfit: 'default', emote: 'run' })).toBe('walk-male-default-run')
    expect(setViewKey('emote', { bodyShape: 'female', outfit: 'outfit-2', emote: null })).toBe('walk-female-outfit-2-own')
    expect(EMOTES).toEqual(['idle', 'wave', 'dance', 'clap', 'walk', 'run', 'jump'])
  })
})

describe('steps and emote checks', () => {
  it('an emote design has no inspect step', () => {
    expect(stepsFor('wearable')).toEqual(['design', 'inspect', 'avatar', 'emotes', 'finalize'])
    expect(stepsFor('emote')).toEqual(['design', 'avatar', 'emotes', 'finalize'])
  })

  it('the checklist is every emote on both bodies', () => {
    const d = detail({ set: { revisions: 'a', views: {}, freeFixesLeft: {}, checks: [
      { emote: 'run', bodyShape: 'male', state: 'fine' }, { emote: 'jump', bodyShape: 'female', state: 'clipping' }] } })
    const list = emoteChecklist(d)
    expect(list.rows).toHaveLength(14)
    expect(list.checkedCount).toBe(2)
    expect(list.rows.find((r) => r.emote === 'run' && r.bodyShape === 'male')?.state).toBe('fine')
    expect(list.rows.find((r) => r.emote === 'run' && r.bodyShape === 'female')?.state).toBe('unchecked')
    const own = emoteChecklist(detail({ design: { ...detail().design, kind: 'emote' } }))
    expect(own.rows.map((r) => [r.emote, r.bodyShape])).toEqual([['own', 'male'], ['own', 'female']])
  })

  it('an emote being fixed shows as fixing', () => {
    const d = detail({
      activeJob: { id: 'j1', type: 'prompt', status: 'taken', fixClipping: { emote: 'dance', bodyShape: 'male', outfit: 'default' } },
      set: { revisions: 'a', views: {}, freeFixesLeft: {}, checks: [{ emote: 'dance', bodyShape: 'male', state: 'clipping' }] },
    })
    expect(emoteState(d, 'dance', 'male')).toBe('fixing')
    expect(emoteState(d, 'dance', 'female')).toBe('fixing')
    expect(emoteState(d, 'wave', 'male')).toBe('unchecked')
    expect(emoteState(detail({ set: d.set }), 'dance', 'male')).toBe('clipping')
  })

  it('names the emote the way the copy does', () => {
    expect(emoteLabel('wearable', 'dance')).toBe('the dance')
    expect(emoteLabel('emote', 'own')).toBe('the emote')
  })

  it('a third report is asked to describe it', () => {
    expect(refusalMessage({ status: 409, body: { code: 'clipping_fix_limit', emote: 'dance' } }, NOW).text)
      .toBe('We’ve tried to fix the clipping in the dance twice. Describe what you see in a prompt and the agent will take another look.')
    expect(refusalMessage({ status: 409, body: { code: 'clipping_fix_limit', emote: 'own' } }, NOW).text)
      .toContain('the clipping in the emote twice')
    expect(refusalMessage({ status: 409, body: { code: 'not_seen' } }, NOW).text).toBe('Play that emote first, then report what you see.')
  })
})
