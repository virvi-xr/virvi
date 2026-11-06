import { describe, it, expect } from 'vitest'
import { CLICKABLE_TYPES, clickDraftOf, clickFromDraft, clickLabel } from '../src/clicks.js'
import { toLayoutItem } from '../src/layout.js'

/** Setting an item's click action from the Layout panel (LIV-126 story 3). */
describe('HUD click actions', () => {
  it('layout rows carry the item click action', () => {
    expect(toLayoutItem({ id: 'e', name: 'P', type: 'image', instances: [], clickEvent: { type: 1, externalLink: 'https://t.example' } }).click)
      .toEqual({ type: 1, externalLink: 'https://t.example' })
    expect(toLayoutItem({ id: 'e', name: 'P', type: 'image', instances: [] }).click).toBeNull()
    // An update without the click keeps the previous one
    const prev = toLayoutItem({ id: 'e', name: 'P', type: 'image', instances: [], clickEvent: { type: 5, teleportTo: '0,0' } })
    expect(toLayoutItem({ id: 'e', name: 'P2', type: 'image' }, prev).click).toEqual({ type: 5, teleportTo: '0,0' })
  })

  it('only images, models and screens take clicks', () => {
    expect([...CLICKABLE_TYPES].sort()).toEqual(['image', 'model', 'video'])
  })

  it('a draft starts from the saved action and builds what to save, checked as the server checks it', () => {
    expect(clickDraftOf({ type: 1, externalLink: 'https://t.example', hoverText: 'Tickets' })).toMatchObject({ kind: 'link', link: 'https://t.example', hoverText: 'Tickets' })
    expect(clickDraftOf(null).kind).toBe('none')
    expect(clickFromDraft({ ...clickDraftOf(null), kind: 'link', link: 'https://t.example', hoverText: 'Go' })).toEqual({ ok: true, value: { type: 1, externalLink: 'https://t.example', hoverText: 'Go', showFeedback: true } })
    expect(clickFromDraft({ ...clickDraftOf(null), kind: 'teleport', teleport: '52,-20' })).toEqual({ ok: true, value: { type: 5, teleportTo: '52,-20', showFeedback: true } })
    expect(clickFromDraft({ ...clickDraftOf(null), kind: 'move', move: ['8', '0', '8'] })).toEqual({ ok: true, value: { type: 4, moveTo: { position: { x: 8, y: 0, z: 8 } }, showFeedback: true } })
    expect(clickFromDraft({ ...clickDraftOf(null), kind: 'none' })).toEqual({ ok: true, value: null })
    expect(clickFromDraft({ ...clickDraftOf(null), kind: 'link', link: 'tickets' })).toEqual({ ok: false, error: 'A link must start with https:// or http://.' })
  })

  it('says what a click does on the row', () => {
    expect(clickLabel({ type: 1, externalLink: 'https://www.tickets.example/x' })).toBe('On click: Opens tickets.example')
    expect(clickLabel(null)).toBe('On click: Nothing')
  })
})
