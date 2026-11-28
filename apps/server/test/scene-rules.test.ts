import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneCollaborators, sceneElements, scenePresets, sceneRules, scenes } from '../src/db/schema.js'
import { RULES_PER_PRESET, triggerFires } from '../src/rules/rules.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'

/** Scene rules (LIV-196): widgets drive show, hide, toggle and preset switches, run by the server. */
const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const TOGGLE = 1, TRIGGER = 5, SLIDER = 6

describe('triggerFires', () => {
  it('on/off for toggles, press for triggers, change for anything that changed', () => {
    expect(triggerFires('on', TOGGLE, false, true)).toBe(true)
    expect(triggerFires('on', TOGGLE, true, false)).toBe(false)
    expect(triggerFires('off', TOGGLE, true, false)).toBe(true)
    expect(triggerFires('off', TOGGLE, undefined, false)).toBe(false)
    expect(triggerFires('press', TRIGGER, 1, 2)).toBe(true)
    expect(triggerFires('press', TOGGLE, false, true)).toBe(false)
    expect(triggerFires('change', SLIDER, 40, 41)).toBe(true)
    expect(triggerFires('change', SLIDER, 40, 40)).toBe(false)
  })
})

describe('scene rules', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  async function setup() {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const lights = await createElement(preset.id, { type: 'widget', name: 'Lights', properties: { controlType: TOGGLE, value: false } })
    const show = await createElement(preset.id, { type: 'widget', name: 'Start show', properties: { controlType: TRIGGER, value: 0 } })
    const rig = await createElement(preset.id, { type: 'image', name: 'Light rig', properties: { imageSrc: 'https://x/a.png' } })
    const curtain = await createElement(preset.id, { type: 'image', name: 'Curtain', properties: { imageSrc: 'https://x/c.png' } })
    const rules = (body: unknown) => app.inject({ method: 'POST', url: `/api/presets/${preset.id}/rules`, headers: as(owner), payload: body as any })
    const setWidget = (id: string, properties: Record<string, unknown>) => app.inject({ method: 'PUT', url: `/api/elements/${id}`, headers: as(owner), payload: { properties } })
    const enabled = async (id: string) => (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!.enabled
    return { owner, scene, preset, lights, show, rig, curtain, rules, setWidget, enabled }
  }

  it('a light switch: on shows the rig, off hides it; only on a real change', async () => {
    const { lights, rig, rules, setWidget, enabled, preset, owner } = await setup()
    await db.update(sceneElements).set({ enabled: false }).where(eq(sceneElements.id, rig.id))
    expect((await rules({ name: 'Lights on', trigger: { type: 'widget', widgetId: lights.id, when: 'on' }, actions: [{ type: 'show', elementId: rig.id }] })).statusCode).toBe(201)
    expect((await rules({ name: 'Lights off', trigger: { type: 'widget', widgetId: lights.id, when: 'off' }, actions: [{ type: 'hide', elementId: rig.id }] })).statusCode).toBe(201)
    await setWidget(lights.id, { controlType: TOGGLE, value: true })
    expect(await enabled(rig.id)).toBe(true)
    await setWidget(lights.id, { controlType: TOGGLE, value: false })
    expect(await enabled(rig.id)).toBe(false)
    const list = await app.inject({ method: 'GET', url: `/api/presets/${preset.id}/rules`, headers: as(owner) })
    expect(list.json()).toMatchObject({ limit: RULES_PER_PRESET, rules: [{ name: 'Lights on' }, { name: 'Lights off' }] })
  })

  it('a trigger runs several actions in order: toggle, hide and a preset switch', async () => {
    const { show, rig, curtain, rules, setWidget, enabled, scene, owner } = await setup()
    const [after] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Show time' }).returning()
    await rules({ trigger: { type: 'widget', widgetId: show.id, when: 'press' }, actions: [{ type: 'toggle', elementId: rig.id }, { type: 'hide', elementId: curtain.id }, { type: 'preset', presetId: after.id }] })
    await setWidget(show.id, { controlType: TRIGGER, value: 1 })
    expect(await enabled(rig.id)).toBe(false)
    expect(await enabled(curtain.id)).toBe(false)
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) }))!.activePresetId).toBe(after.id)
    // Switched off, the rule doesn't run
    await db.update(scenes).set({ activePresetId: (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, rig.id) }))!.presetId }).where(eq(scenes.id, scene.id))
    const [rule] = await db.select().from(sceneRules)
    expect((await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, headers: as(owner), payload: { enabled: false } })).json().rule.enabled).toBe(false)
    await setWidget(show.id, { controlType: TRIGGER, value: 2 })
    expect(await enabled(rig.id)).toBe(false)
  })

  it('refuses rules that point outside the preset, the wrong trigger for a widget, and too many actions', async () => {
    const { lights, show, rig, rules } = await setup()
    const other = await setup()
    const err = async (body: unknown) => (await rules(body)).json().error
    expect(await err({ trigger: { type: 'widget', widgetId: rig.id, when: 'change' }, actions: [{ type: 'show', elementId: rig.id }] })).toBe('bad_trigger')
    expect(await err({ trigger: { type: 'widget', widgetId: show.id, when: 'on' }, actions: [{ type: 'show', elementId: rig.id }] })).toBe('bad_trigger')
    expect(await err({ trigger: { type: 'widget', widgetId: lights.id, when: 'on' }, actions: [{ type: 'show', elementId: other.rig.id }] })).toBe('bad_actions')
    expect(await err({ trigger: { type: 'widget', widgetId: lights.id, when: 'on' }, actions: [{ type: 'show', elementId: lights.id }] })).toBe('bad_actions')
    expect(await err({ trigger: { type: 'widget', widgetId: lights.id, when: 'on' }, actions: [{ type: 'preset', presetId: other.preset.id }] })).toBe('bad_actions')
    expect(await err({ trigger: { type: 'widget', widgetId: lights.id, when: 'on' }, actions: [] })).toBe('bad_actions')
    expect(await err({ trigger: { type: 'widget', widgetId: lights.id, when: 'on' }, actions: Array(11).fill({ type: 'show', elementId: rig.id }) })).toBe('bad_actions')
  })

  it('only editors manage rules', async () => {
    const { preset, scene, rules, lights, rig } = await setup()
    const viewer = await createUser()
    const stranger = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: viewer.id, role: 'viewer' })
    const body = { trigger: { type: 'widget', widgetId: lights.id, when: 'on' }, actions: [{ type: 'show', elementId: rig.id }] }
    for (const u of [viewer, stranger]) {
      expect((await app.inject({ method: 'POST', url: `/api/presets/${preset.id}/rules`, headers: as(u), payload: body })).statusCode).toBe(403)
      expect((await app.inject({ method: 'GET', url: `/api/presets/${preset.id}/rules`, headers: as(u) })).statusCode).toBe(403)
    }
    const { rule } = (await rules(body)).json()
    expect((await app.inject({ method: 'DELETE', url: `/api/rules/${rule.id}`, headers: as(stranger) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, headers: as(viewer), payload: { enabled: false } })).statusCode).toBe(403)
    expect(await db.select().from(sceneRules)).toHaveLength(1)
  })

  it('a copied preset gets the rules, pointing at its own copies', async () => {
    const { preset, scene, owner, lights, rig, rules } = await setup()
    await rules({ trigger: { type: 'widget', widgetId: lights.id, when: 'on' }, actions: [{ type: 'hide', elementId: rig.id }] })
    const copy = await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/presets`, headers: as(owner), payload: { name: 'Copy', fromPresetId: preset.id } })
    const copyId = copy.json().preset.id
    const els = await db.select().from(sceneElements).where(eq(sceneElements.presetId, copyId))
    const [r] = (await app.inject({ method: 'GET', url: `/api/presets/${copyId}/rules`, headers: as(owner) })).json().rules
    expect(r.trigger.widgetId).toBe(els.find((e) => e.name === 'Lights')!.id)
    expect(r.actions[0].elementId).toBe(els.find((e) => e.name === 'Light rig')!.id)
  })
})

import { dueAt, sweepTimedRules, TIMED_GRACE_MS } from '../src/rules/rules.js'
import { timedRuleChanged } from '../src/rules/sweep.js'
import { sceneActivity } from '../src/db/schema.js'

describe('timed rules', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('reads the widget value as a wall time in the rule’s time zone', () => {
    expect(dueAt('2026-12-31T20:00', 'UTC')!.toISOString()).toBe('2026-12-31T20:00:00.000Z')
    expect(dueAt('2026-07-01T20:00', 'Europe/London')!.toISOString()).toBe('2026-07-01T19:00:00.000Z')
    expect(dueAt('2026-12-31 20:00', 'UTC')).toBeNull()
    expect(dueAt('2026-12-31T20:00', 'Not/AZone')).toBeNull()
    expect(dueAt(undefined, 'UTC')).toBeNull()
  })

  it('opens the doors when the time comes, once, and says Virvi did it; a past time set long ago is skipped', async () => {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const doors = await createElement(preset.id, { type: 'widget', name: 'Doors open', properties: { controlType: 4, value: '2030-01-01T20:00' } })
    const gate = await createElement(preset.id, { type: 'image', name: 'Gate', properties: { imageSrc: 'https://x/g.png' } })
    const make = await app.inject({ method: 'POST', url: `/api/presets/${preset.id}/rules`, headers: as(owner), payload: { name: 'Open up', trigger: { type: 'time', widgetId: doors.id, timezone: 'UTC' }, actions: [{ type: 'hide', elementId: gate.id }] } })
    expect(make.statusCode).toBe(201)
    const gateOn = async () => (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, gate.id) }))!.enabled

    expect(await sweepTimedRules(timedRuleChanged, new Date('2030-01-01T19:59:00Z'))).toBe(0)
    expect(await gateOn()).toBe(true)
    expect(await sweepTimedRules(timedRuleChanged, new Date('2030-01-01T20:00:30Z'))).toBe(1)
    expect(await gateOn()).toBe(false)
    expect(await sweepTimedRules(timedRuleChanged, new Date('2030-01-01T20:01:00Z'))).toBe(0)
    const [act] = await db.select().from(sceneActivity).where(eq(sceneActivity.subjectId, gate.id))
    expect(act).toMatchObject({ via: 'rule', actorUserId: null, action: 'element.updated' })
    expect(act.detail).toMatchObject({ rule: 'Open up' })

    // A new time, already well past when it's set: marked done, nothing runs
    await db.update(sceneElements).set({ enabled: true }).where(eq(sceneElements.id, gate.id))
    await app.inject({ method: 'PUT', url: `/api/elements/${doors.id}`, headers: as(owner), payload: { properties: { controlType: 4, value: '2030-01-01T08:00' } } })
    expect(await sweepTimedRules(timedRuleChanged, new Date(Date.parse('2030-01-01T08:00:00Z') + TIMED_GRACE_MS + 60_000))).toBe(0)
    expect(await gateOn()).toBe(true)
    expect(scene.id).toBeTruthy()
  })

  it('a timed rule needs a Date and time widget and a real time zone', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const lights = await createElement(preset.id, { type: 'widget', name: 'Lights', properties: { controlType: 1, value: false } })
    const doors = await createElement(preset.id, { type: 'widget', name: 'Doors', properties: { controlType: 4, value: '' } })
    const gate = await createElement(preset.id, { type: 'image', name: 'Gate' })
    const post = (trigger: unknown) => app.inject({ method: 'POST', url: `/api/presets/${preset.id}/rules`, headers: as(owner), payload: { trigger, actions: [{ type: 'hide', elementId: gate.id }] } as any })
    expect((await post({ type: 'time', widgetId: lights.id, timezone: 'UTC' })).json().error).toBe('bad_trigger')
    expect((await post({ type: 'time', widgetId: doors.id, timezone: 'Mars/Base' })).json().error).toBe('bad_trigger')
    expect((await post({ type: 'time', widgetId: doors.id, timezone: 'America/New_York' })).statusCode).toBe(201)
  })
})

import { startGameServer, joinScene } from './helpers/game-server.js'
import { withRuleClicks } from '../src/rules/rules.js'

describe('click rules', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => { await resetDb(); app = await testApp(); gs = await startGameServer() })
  afterEach(async () => { await app.close(); await gs.stop() })

  it('a visitor clicking the switch flips the lights for everyone; the item is marked clickable', async () => {
    const owner = await createUser()
    const visitor = await createUser()
    const { scene, preset } = await createScene(owner)
    const button = await createElement(preset.id, { type: 'model', name: 'Wall switch', properties: { modelSrc: 'https://x/s.glb' } })
    const lamp = await createElement(preset.id, { type: 'image', name: 'Lamp', properties: { imageSrc: 'https://x/l.png' } })
    const widget = await createElement(preset.id, { type: 'widget', name: 'W', properties: { controlType: 1, value: false } })
    const post = (trigger: unknown) => app.inject({ method: 'POST', url: `/api/presets/${preset.id}/rules`, headers: as(owner), payload: { trigger, actions: [{ type: 'toggle', elementId: lamp.id }] } as any })
    expect((await post({ type: 'click', elementId: widget.id })).json().error).toBe('bad_trigger')
    expect((await post({ type: 'click', elementId: button.id })).statusCode).toBe(201)

    const host = await joinScene(gs.url, scene.id, tokenFor(owner))
    const guest = await joinScene(gs.url, scene.id, tokenFor(visitor))
    const init = await guest.waitFor('scene_preset_update')
    await host.waitFor('scene_preset_update')
    expect(init.scenePreset.models[0].clickEvent).toMatchObject({ ruleElement: button.id })
    expect(init.scenePreset.images[0].clickEvent?.ruleElement).toBeUndefined()

    guest.room.send('rule_click', { elementId: button.id })
    const update = await host.waitFor('scene_preset_update')
    expect(update).toMatchObject({ action: 'upsert', element: 'image', elementData: { sk: lamp.id, enabled: false } })
    expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, lamp.id) }))!.enabled).toBe(false)

    // An item no rule starts from does nothing
    guest.room.send('rule_click', { elementId: lamp.id })
    await host.expectNone('scene_preset_update')
  })

  it('withRuleClicks marks only enabled click rules of the preset', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const a = await createElement(preset.id, { type: 'image', name: 'A' })
    const b = await createElement(preset.id, { type: 'image', name: 'B' })
    await db.insert(sceneRules).values([
      { presetId: preset.id, trigger: { type: 'click', elementId: a.id }, actions: [{ type: 'hide', elementId: b.id }] },
      { presetId: preset.id, enabled: false, trigger: { type: 'click', elementId: b.id }, actions: [{ type: 'hide', elementId: a.id }] },
    ])
    const out = await withRuleClicks({ sk: preset.id, images: [{ sk: a.id, clickEvent: { type: 1, externalLink: 'https://x' } }, { sk: b.id }] })
    expect(out.images).toEqual([{ sk: a.id, clickEvent: { type: 1, externalLink: 'https://x', ruleElement: a.id } }, { sk: b.id }])
  })
})

describe('slider volume rules', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('a slider sets a sound’s and a screen’s volume; only from a Slider', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const knob = await createElement(preset.id, { type: 'widget', name: 'Volume', properties: { controlType: 6, value: 50 } })
    const lights = await createElement(preset.id, { type: 'widget', name: 'Lights', properties: { controlType: 1, value: false } })
    const music = await createElement(preset.id, { type: 'sound', name: 'Music', properties: { audioSrc: 'https://x/m.mp3', volume: 1 } })
    const screen = await createElement(preset.id, { type: 'video', name: 'Screen' })
    const pic = await createElement(preset.id, { type: 'image', name: 'Pic' })
    const post = (body: unknown) => app.inject({ method: 'POST', url: `/api/presets/${preset.id}/rules`, headers: as(owner), payload: body as any })
    expect((await post({ trigger: { type: 'widget', widgetId: lights.id, when: 'change' }, actions: [{ type: 'volume', elementId: music.id }] })).json().error).toBe('bad_actions')
    expect((await post({ trigger: { type: 'widget', widgetId: knob.id, when: 'change' }, actions: [{ type: 'volume', elementId: pic.id }] })).json().error).toBe('bad_actions')
    const made = await post({ trigger: { type: 'widget', widgetId: knob.id, when: 'change' }, actions: [{ type: 'volume', elementId: music.id }, { type: 'volume', elementId: screen.id }] })
    expect(made.statusCode).toBe(201)
    await app.inject({ method: 'PUT', url: `/api/elements/${knob.id}`, headers: as(owner), payload: { properties: { controlType: 6, value: 30 } } })
    const vol = async (id: string) => ((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!.properties as any).volume
    expect(await vol(music.id)).toBe(0.3)
    expect(await vol(screen.id)).toBe(0.3)
    // Its other properties stay
    expect(((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, music.id) }))!.properties as any).audioSrc).toBe('https://x/m.mp3')
    // Changing the trigger to a Toggle is refused while it has a volume action
    const ruleId = made.json().rule.id
    expect((await app.inject({ method: 'PATCH', url: `/api/rules/${ruleId}`, headers: as(owner), payload: { trigger: { type: 'widget', widgetId: lights.id, when: 'on' } } })).json().error).toBe('bad_actions')
  })

  it("a rule whose item was deleted can still be switched off and renamed", async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const lights = await createElement(preset.id, { type: 'widget', name: 'Lights', properties: { controlType: 1, value: false } })
    const rig = await createElement(preset.id, { type: 'image', name: 'Rig' })
    const { rule } = (await app.inject({ method: 'POST', url: `/api/presets/${preset.id}/rules`, headers: as(owner), payload: { trigger: { type: 'widget', widgetId: lights.id, when: 'on' }, actions: [{ type: 'show', elementId: rig.id }] } })).json()
    await db.delete(sceneElements).where(eq(sceneElements.id, rig.id))
    const res = await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, headers: as(owner), payload: { enabled: false, name: 'Old' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().rule).toMatchObject({ enabled: false, name: 'Old' })
  })
})

describe('slider brightness rules', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('a slider sets an image’s and a screen’s brightness, not a sound’s', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const dimmer = await createElement(preset.id, { type: 'widget', name: 'Dimmer', properties: { controlType: 6, value: 50 } })
    const poster = await createElement(preset.id, { type: 'image', name: 'Poster', properties: { imageSrc: 'https://x/p.png' } })
    const screen = await createElement(preset.id, { type: 'video', name: 'Screen' })
    const music = await createElement(preset.id, { type: 'sound', name: 'Music' })
    const post = (actions: unknown) => app.inject({ method: 'POST', url: `/api/presets/${preset.id}/rules`, headers: as(owner), payload: { trigger: { type: 'widget', widgetId: dimmer.id, when: 'change' }, actions } as any })
    expect((await post([{ type: 'brightness', elementId: music.id }])).json().error).toBe('bad_actions')
    expect((await post([{ type: 'brightness', elementId: poster.id }, { type: 'brightness', elementId: screen.id }])).statusCode).toBe(201)
    await app.inject({ method: 'PUT', url: `/api/elements/${dimmer.id}`, headers: as(owner), payload: { properties: { controlType: 6, value: 85 } } })
    const em = async (id: string) => ((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!.properties as any).emission
    expect(await em(poster.id)).toBe(0.85)
    expect(await em(screen.id)).toBe(0.85)
  })
})

describe('selector rules: a video picker', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('choosing a film shows its screen and hides the others; nothing chosen hides them all', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const picker = await createElement(preset.id, { type: 'widget', name: 'Film', properties: { controlType: 3, options: ['One', 'Two'], value: '' } })
    const lights = await createElement(preset.id, { type: 'widget', name: 'Lights', properties: { controlType: 1, value: false } })
    const s1 = await createElement(preset.id, { type: 'video', name: 'Screen 1' })
    const s2 = await createElement(preset.id, { type: 'video', name: 'Screen 2' })
    const choose = { type: 'choose', choices: [{ option: 'One', elementId: s1.id }, { option: 'Two', elementId: s2.id }] }
    const post = (widgetId: string, actions: unknown) => app.inject({ method: 'POST', url: `/api/presets/${preset.id}/rules`, headers: as(owner), payload: { trigger: { type: 'widget', widgetId, when: 'change' }, actions } as any })
    expect((await post(lights.id, [choose])).json().error).toBe('bad_actions')
    expect((await post(picker.id, [{ type: 'choose', choices: [{ option: 'One', elementId: lights.id }] }])).json().error).toBe('bad_actions')
    expect((await post(picker.id, [choose])).statusCode).toBe(201)
    const pick = (value: string) => app.inject({ method: 'PUT', url: `/api/elements/${picker.id}`, headers: as(owner), payload: { properties: { controlType: 3, options: ['One', 'Two'], value } } })
    const on = async (id: string) => (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!.enabled
    await pick('Two')
    expect([await on(s1.id), await on(s2.id)]).toEqual([false, true])
    await pick('One')
    expect([await on(s1.id), await on(s2.id)]).toEqual([true, false])
    await pick('')
    expect([await on(s1.id), await on(s2.id)]).toEqual([false, false])
  })
})
