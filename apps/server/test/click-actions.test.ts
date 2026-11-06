import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { checkClickEvent, describeClick } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { sceneElements, sceneElementInstances } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'

/** Click actions on placed items (LIV-126): what may be saved, and how it reads. */
describe('checkClickEvent', () => {
  it('keeps a link, a sound, a move (with or without camera) and a teleport, with hover text and feedback', () => {
    expect(checkClickEvent({ type: 1, externalLink: ' https://tickets.example/show ', hoverText: 'Get tickets', showFeedback: true }))
      .toEqual({ ok: true, value: { type: 1, externalLink: 'https://tickets.example/show', hoverText: 'Get tickets', showFeedback: true } })
    expect(checkClickEvent({ type: 2, sound: 'https://cdn.example/ding.mp3' })).toEqual({ ok: true, value: { type: 2, sound: 'https://cdn.example/ding.mp3', showFeedback: false } })
    expect(checkClickEvent({ type: 4, moveTo: { position: { x: 8, y: 0, z: 8 } } })).toEqual({ ok: true, value: { type: 4, moveTo: { position: { x: 8, y: 0, z: 8 } }, showFeedback: false } })
    expect(checkClickEvent({ type: 4, moveTo: { position: { x: 1, y: 2, z: 3 }, cameraTarget: { x: 4, y: 5, z: 6 } } }).ok).toBe(true)
    expect(checkClickEvent({ type: 5, teleportTo: '52,-20' })).toEqual({ ok: true, value: { type: 5, teleportTo: '52,-20', showFeedback: false } })
  })
  it('null or NONE clears it', () => {
    expect(checkClickEvent(null)).toEqual({ ok: true, value: null })
    expect(checkClickEvent({ type: 0, externalLink: 'https://x.example' })).toEqual({ ok: true, value: null })
  })
  it('refuses what a visitor could not use, with a reason', () => {
    expect(checkClickEvent({ type: 1, externalLink: 'javascript:alert(1)' })).toEqual({ ok: false, error: 'A link must start with https:// or http://.' })
    expect(checkClickEvent({ type: 2 })).toEqual({ ok: false, error: 'Choose the sound to play.' })
    expect(checkClickEvent({ type: 4, moveTo: { position: { x: 'a' } } })).toEqual({ ok: false, error: 'Moving needs a position: x, y and z in metres.' })
    expect(checkClickEvent({ type: 5, teleportTo: 'somewhere' })).toEqual({ ok: false, error: 'Teleport to parcel coordinates like 52,-20.' })
    expect(checkClickEvent({ type: 3 })).toEqual({ ok: false, error: 'That click action is not available.' })
    expect(checkClickEvent({ type: 1, externalLink: 'https://x.example', hoverText: 'x'.repeat(61) })).toEqual({ ok: false, error: 'Hover text can be up to 60 characters.' })
    expect(checkClickEvent('nope')).toEqual({ ok: false, error: 'That click action is not available.' })
  })
  it('describes an action in a few words', () => {
    expect(describeClick({ type: 1, externalLink: 'https://tickets.example/show' })).toBe('Opens tickets.example')
    expect(describeClick({ type: 2, sound: 'https://cdn.example/ding.mp3' })).toBe('Plays a sound')
    expect(describeClick({ type: 4, moveTo: { position: { x: 8, y: 0, z: 8 } } })).toBe('Moves the visitor to 8, 0, 8')
    expect(describeClick({ type: 5, teleportTo: '52,-20' })).toBe('Teleports to 52,-20')
    expect(describeClick(null)).toBe('Nothing')
  })
})

describe('saving click actions', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())
  const as = (u: any) => ({ authorization: `Bearer ${tokenFor(u)}` })

  it('an item and a copy take a valid action (stored tidied), and refuse a bad one with its reason', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const el = await createElement(preset.id, { type: 'image' })
    const inst = await createInstance(el.id)
    const ok = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { clickEvent: { type: 1, externalLink: ' https://tickets.example ', hoverText: 'Tickets' } } })
    expect(ok.statusCode).toBe(200)
    expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, el.id) }))!.clickEvent).toEqual({ type: 1, externalLink: 'https://tickets.example', hoverText: 'Tickets', showFeedback: false })
    const bad = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { clickEvent: { type: 1, externalLink: 'ftp://x' } } })
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'bad_click', message: 'A link must start with https:// or http://.' }])
    const own = await app.inject({ method: 'PUT', url: `/api/instances/${inst.id}`, headers: as(owner), payload: { clickEvent: { type: 5, teleportTo: '0,0' } } })
    expect(own.statusCode).toBe(200)
    expect((await db.query.sceneElementInstances.findFirst({ where: eq(sceneElementInstances.id, inst.id) }))!.clickEvent).toEqual({ type: 5, teleportTo: '0,0', showFeedback: false })
    const badInst = await app.inject({ method: 'PUT', url: `/api/instances/${inst.id}`, headers: as(owner), payload: { clickEvent: { type: 5, teleportTo: '' } } })
    expect(badInst.statusCode).toBe(400)
    const cleared = await app.inject({ method: 'PUT', url: `/api/instances/${inst.id}`, headers: as(owner), payload: { clickEvent: null } })
    expect(cleared.statusCode).toBe(200)
  })

  it('a new item or copy is checked too', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const res = await app.inject({ method: 'POST', url: `/api/presets/${preset.id}/elements`, headers: as(owner), payload: { type: 'image', name: 'P', clickEvent: { type: 2 } } })
    expect(res.statusCode).toBe(400)
    const el = await createElement(preset.id, { type: 'image' })
    const res2 = await app.inject({ method: 'POST', url: `/api/elements/${el.id}/instances`, headers: as(owner), payload: { clickEvent: { type: 1, externalLink: 'nope' } } })
    expect(res2.statusCode).toBe(400)
  })
})
