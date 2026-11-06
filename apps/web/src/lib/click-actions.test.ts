import { describe, it, expect } from 'vitest'
import { blankClickForm, clickFormOf, clickFromForm, type ClickForm } from './click-actions'

/** The dashboard's click action form (LIV-126). */
describe('click action form', () => {
  it('reads a saved action back into the form', () => {
    expect(clickFormOf({ type: 1, externalLink: 'https://t.example', hoverText: 'Tickets', showFeedback: true })).toMatchObject({ kind: 'link', link: 'https://t.example', hoverText: 'Tickets', showFeedback: true })
    expect(clickFormOf({ type: 4, moveTo: { position: { x: 1, y: 2, z: 3 }, cameraTarget: { x: 4, y: 5, z: 6 } } }))
      .toMatchObject({ kind: 'move', move: ['1', '2', '3'], aimCamera: true, camera: ['4', '5', '6'] })
    expect(clickFormOf(null)).toEqual(blankClickForm())
  })
  it('builds the action to save, checked as the server checks it', () => {
    const f = (o: Partial<ClickForm>): ClickForm => ({ ...blankClickForm(), ...o })
    expect(clickFromForm(f({ kind: 'none' }))).toEqual({ ok: true, value: null })
    expect(clickFromForm(f({ kind: 'link', link: ' https://t.example ', hoverText: 'Tickets', showFeedback: true })))
      .toEqual({ ok: true, value: { type: 1, externalLink: 'https://t.example', hoverText: 'Tickets', showFeedback: true } })
    expect(clickFromForm(f({ kind: 'teleport', teleport: '52, -20' }))).toEqual({ ok: true, value: { type: 5, teleportTo: '52,-20', showFeedback: false } })
    expect(clickFromForm(f({ kind: 'move', move: ['8', '0', '8'] }))).toEqual({ ok: true, value: { type: 4, moveTo: { position: { x: 8, y: 0, z: 8 } }, showFeedback: false } })
    expect(clickFromForm(f({ kind: 'move', move: ['8', '', '8'] }))).toEqual({ ok: false, error: 'Moving needs a position: x, y and z in metres.' })
    expect(clickFromForm(f({ kind: 'sound', sound: '' }))).toEqual({ ok: false, error: 'Choose the sound to play.' })
    expect(clickFromForm(f({ kind: 'link', link: 'tickets.example' }))).toEqual({ ok: false, error: 'A link must start with https:// or http://.' })
  })
})
