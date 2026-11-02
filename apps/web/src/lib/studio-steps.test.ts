import { describe, it, expect } from 'vitest'
import { EMOTES, emoteChecklist, inspectNote, emoteLabel, emoteState, orbitDrag, orbitFrame, orbitKey, refusalMessage, setViewKey, stepsFor, type StudioDetail, STEP_LABELS, pieceLabel, orbitKeyFor, viewKey, triangleWarning, KIND_CHOICES, kindLabel, finalizeStrip, defaultStep, shownStep, dialogTotal, giftNote, checkedEmotes } from './studio'

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

  it('says more angles are coming only while they are', () => {
    const view = (frames: number, pending?: boolean) => ({ status: 'ready', frames, urls: [], renderedAt: '', pending })
    expect(inspectNote(view(24, true))).toBe('loading')
    expect(inspectNote(view(24, false))).toBe('retry') // the sphere failed behind the ring
    expect(inspectNote(view(122, false))).toBe(null)
    expect(inspectNote(undefined)).toBe(null)
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

  it('a reported emote still counts as checked while it is fixed', () => {
    const d = detail({
      activeJob: { id: 'j1', type: 'prompt', status: 'taken', fixClipping: { emote: 'dance', bodyShape: 'male', outfit: 'default' } },
      set: { revisions: 'a', views: {}, freeFixesLeft: {}, checks: [{ emote: 'dance', bodyShape: 'male', state: 'clipping' }] },
    })
    expect(emoteChecklist(d).checkedCount).toBe(1)
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

describe('scene designs', () => {
  it('a building gets the walk-through, furniture the scale view, and neither gets avatar or emotes', () => {
    expect(stepsFor('scene', ['building'])).toEqual(['design', 'inspect', 'tour', 'finalize'])
    expect(stepsFor('scene', ['furniture_chair'])).toEqual(['design', 'inspect', 'scale', 'finalize'])
    expect(stepsFor('scene', ['building', 'furniture_chair'])).toEqual(['design', 'inspect', 'tour', 'scale', 'finalize'])
    expect(stepsFor('scene', [])).toEqual(['design', 'inspect', 'finalize'])
    expect(stepsFor('wearable', ['hat'])).toEqual(['design', 'inspect', 'avatar', 'emotes', 'finalize'])
    expect(stepsFor('emote', ['emote'])).toEqual(['design', 'avatar', 'emotes', 'finalize'])
    expect(STEP_LABELS.tour).toBe('Walk-through')
    expect(STEP_LABELS.scale).toBe('Scale')
  })
  it('scene pieces are named for people, and their views keyed as the server keys them', () => {
    expect(pieceLabel('building')).toBe('Building')
    expect(pieceLabel('furniture_round_table')).toBe('Round table')
    expect(pieceLabel('furniture_door')).toBe('Door')
    expect(orbitKeyFor('scene', 'male')).toBe('orbit-scene')
    expect(orbitKeyFor('wearable', 'female')).toBe('orbit-female')
    expect(viewKey('scene', { bodyShape: 'male', outfit: 'default', emote: null })).toBe('scale')
    expect(setViewKey('scene', { bodyShape: 'male', outfit: 'default', emote: null })).toBe('tour')
  })
  it('a piece over its recommended triangles gets a warning, not a block', () => {
    expect(triangleWarning('Neon Chair', { pass: true, failures: 0, warnings: 1, triangles: { count: 1200, limit: 800 } }))
      .toBe('Neon Chair has 1,200 triangles, more than the 800 recommended. It still works in Decentraland, but a lighter piece leaves room for the rest of the scene.')
    expect(triangleWarning('Neon Chair', { pass: true, failures: 0, warnings: 0, triangles: null })).toBeNull()
    expect(triangleWarning('Neon Chair', null)).toBeNull()
  })
  it('the new design picker offers buildings and furniture', () => {
    expect(KIND_CHOICES).toEqual([['wearable', 'Wearable'], ['emote', 'Emote'], ['scene', 'Building or furniture']])
    expect(kindLabel('scene')).toBe('Building or furniture')
  })
})

describe('scene finalize', () => {
  it('says the pieces go into the asset library', () => {
    expect(finalizeStrip(null, 'scene').unlocks).toMatch(/asset library/)
  })
})

describe('the step a design opens on', () => {
  it('is On avatar, or Inspect for a scene design, and a step the design has', () => {
    expect(defaultStep('wearable')).toBe('avatar')
    expect(defaultStep('emote')).toBe('avatar')
    expect(defaultStep('scene')).toBe('inspect')
    expect(shownStep('tour', 'scene', ['furniture_chair'])).toBe('inspect')  // no building, so no walk-through
    expect(shownStep('tour', 'scene', ['building'])).toBe('tour')
    expect(shownStep('emotes', 'wearable', ['hat'])).toBe('emotes')
  })
})

describe('scene gifts and checks', () => {
  const line = (over: Record<string, unknown>) => ({ category: 'building', revisionId: 'r1', revisionNumber: 1, pieceName: 'Kiosk',
    priceKind: 'first', amountCents: 7900, waived: false, ...over }) as any
  const quote = (lines: any[]) => ({ pieces: [], lines, totalCents: 0, blocked: [], giftsUsed: 0, reportsHeld: [], notes: [] }) as any
  it('a gift takes $29 off a 4x4 building and covers a chair whole, as Stripe charges', () => {
    expect(dialogTotal(quote([line({ gift: true, giftCents: 2900 })]), [])).toBe(5000)
    expect(dialogTotal(quote([line({ amountCents: 900, gift: true, giftCents: 900 })]), [])).toBe(0)
    expect(dialogTotal(quote([line({ amountCents: 2900, gift: true })]), [])).toBe(0)  // a wearable gift: the whole line
    expect(giftNote(line({ gift: true, giftCents: 2900 }))).toBe('$29 off (gift code)')
    expect(giftNote(line({ amountCents: 900, gift: true, giftCents: 900 }))).toBe('free (gift code)')
    expect(giftNote(line({ amountCents: 2900, gift: true }))).toBe('free (gift code)')
    expect(giftNote(line({}))).toBeNull()
  })
  it('a scene design has no emotes to check', () => {
    expect(checkedEmotes('scene')).toEqual([])
    expect(checkedEmotes('wearable')).toHaveLength(7)
  })
})
