import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneElements, scenePresets, sceneRules } from '../db/schema.js'
import { activatePreset } from '../scenes/presets.js'
import { isTimeZone, zonedToUtc } from '../scenes/schedule-time.js'
import { recordSceneActivity, type ActivityActor } from '../scenes/activity.js'

/**
 * Scene rules (LIV-196, first part): "when this widget does this, do that", saved with a preset. The server runs them
 * when a widget's value changes, so their effects reach every platform through the feeds that already exist
 * (Decentraland rooms, the Hyperfy feed, AR), with nothing new for the clients to run.
 *
 * Actions only show, hide or switch: they never change a widget, so a rule can't set itself off (no loops).
 */
export const RULES_PER_PRESET = 50
export const ACTIONS_PER_RULE = 10
export const RULE_NAME_MAX = 80

export const WIDGET_WHEN = ['on', 'off', 'press', 'change'] as const
export type WidgetWhen = (typeof WIDGET_WHEN)[number]
export type RuleTrigger =
  | { type: 'widget'; widgetId: string; when: WidgetWhen }
  /** A Date and time widget's value arriving, read in `timezone` (the widget stores a wall time with no zone). */
  | { type: 'time'; widgetId: string; timezone: string }
  /** A visitor clicking a placed item (any copy) in-world; the SDK sends `rule_click`. */
  | { type: 'click'; elementId: string }
export type RuleAction =
  | { type: 'show' | 'hide' | 'toggle'; elementId: string }
  | { type: 'preset'; presetId: string }
  /** A sound's or screen's volume follows the Slider that set the rule off (0 to 100 → 0 to 1). */
  | { type: 'volume'; elementId: string }
  /** An image's or screen's brightness (emission) follows the Slider (0 to 100 → 0 to 1). Decentraland draws it. */
  | { type: 'brightness'; elementId: string }
  /** A Selector's choice shows its item and hides the other options' items: a video picker, say. */
  | { type: 'choose'; choices: { option: string; elementId: string }[] }
export interface RuleInput { name?: unknown; enabled?: unknown; trigger?: unknown; actions?: unknown }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Toggle (1) and Trigger (5) first; any widget for 'change'; Date and time (4) for timed rules. */
const WIDGET_TOGGLE = 1
const WIDGET_DATETIME = 4
const WIDGET_TRIGGER = 5
const WIDGET_SELECTOR = 3
const WIDGET_SLIDER = 6
export const CHOICES_MAX = 50
/** What a volume action can set. */
const HAS_VOLUME = new Set(['sound', 'video'])
/** What a brightness action can set. */
const HAS_BRIGHTNESS = new Set(['image', 'video'])
/** The property and the element types each slider action sets. */
const SLIDER_ACTIONS = { volume: { prop: 'volume', types: HAS_VOLUME }, brightness: { prop: 'emission', types: HAS_BRIGHTNESS } } as const
/** A timed rule whose time passed longer ago than this (the server was down, or the time was set in the past) is skipped. */
export const TIMED_GRACE_MS = 10 * 60_000
/** What a visitor can click in-world (the types whose copies take click actions). */
export const CLICKABLE = new Set(['image', 'video', 'model'])

/** Whether a widget going from `prev` to `next` sets off `when`. */
export function triggerFires(when: WidgetWhen, controlType: number, prev: unknown, next: unknown): boolean {
  if (same(prev, next)) return false
  switch (when) {
    case 'on': return controlType === WIDGET_TOGGLE && next === true
    case 'off': return controlType === WIDGET_TOGGLE && next !== true && prev === true
    case 'press': return controlType === WIDGET_TRIGGER
    case 'change': return true
  }
}

export type RuleError = { error: string; message: string }
const bad = (error: string, message: string): RuleError => ({ error, message })

/**
 * Checks a rule against its preset: the trigger is a widget of this preset, shown/hidden items are elements of this
 * preset (not widgets), and switched-to presets belong to the same scene. Returns the clean rule, or why not.
 */
export async function checkRule(presetId: string, sceneId: string, input: RuleInput, partial = false): Promise<{ name?: string; enabled?: boolean; trigger?: RuleTrigger; actions?: RuleAction[] } | RuleError> {
  const out: { name?: string; enabled?: boolean; trigger?: RuleTrigger; actions?: RuleAction[] } = {}
  if (input.name !== undefined || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name.length > RULE_NAME_MAX) return bad('bad_name', `A rule's name can be up to ${RULE_NAME_MAX} characters`)
    out.name = name
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return bad('bad_enabled', 'enabled is true or false')
    out.enabled = input.enabled
  }
  const elements = await db.select({ id: sceneElements.id, type: sceneElements.type, properties: sceneElements.properties }).from(sceneElements).where(eq(sceneElements.presetId, presetId))
  const byId = new Map(elements.map((e) => [e.id, e]))
  if (input.trigger !== undefined || !partial) {
    const t = input.trigger as any
    const shape = "A trigger is { type: 'widget', widgetId, when: 'on' | 'off' | 'press' | 'change' }, { type: 'time', widgetId, timezone } or { type: 'click', elementId }"
    if (t?.type === 'click') {
      const el = typeof t.elementId === 'string' ? byId.get(t.elementId) : undefined
      if (!el || !CLICKABLE.has(el.type)) return bad('bad_trigger', 'A click rule starts from an image, video screen or model of this preset')
      out.trigger = { type: 'click', elementId: t.elementId }
    } else {
      if (!t || typeof t.widgetId !== 'string' || (t.type !== 'widget' && t.type !== 'time')) return bad('bad_trigger', shape)
      const w = byId.get(t.widgetId)
      if (!w || w.type !== 'widget') return bad('bad_trigger', "The trigger's widget isn't in this preset")
      const controlType = Number((w.properties as Record<string, unknown> | null)?.controlType ?? 0)
      if (t.type === 'time') {
        if (controlType !== WIDGET_DATETIME) return bad('bad_trigger', 'A timed rule starts from a Date and time widget')
        if (typeof t.timezone !== 'string' || !isTimeZone(t.timezone)) return bad('bad_trigger', 'A timed rule needs a time zone, such as Europe/London')
        out.trigger = { type: 'time', widgetId: t.widgetId, timezone: t.timezone }
      } else {
        if (!WIDGET_WHEN.includes(t.when)) return bad('bad_trigger', shape)
        if ((t.when === 'on' || t.when === 'off') && controlType !== WIDGET_TOGGLE) return bad('bad_trigger', "'on' and 'off' are for Toggle widgets")
        if (t.when === 'press' && controlType !== WIDGET_TRIGGER) return bad('bad_trigger', "'press' is for Trigger widgets")
        out.trigger = { type: 'widget', widgetId: t.widgetId, when: t.when as WidgetWhen }
      }
    }
  }
  if (input.actions !== undefined || !partial) {
    const list = input.actions
    if (!Array.isArray(list) || list.length === 0) return bad('bad_actions', 'A rule needs at least one action')
    if (list.length > ACTIONS_PER_RULE) return bad('bad_actions', `A rule can have up to ${ACTIONS_PER_RULE} actions`)
    const actions: RuleAction[] = []
    for (const a of list as any[]) {
      if (a && (a.type === 'show' || a.type === 'hide' || a.type === 'toggle') && typeof a.elementId === 'string') {
        const el = byId.get(a.elementId)
        if (!el || el.type === 'widget') return bad('bad_actions', 'Show and hide work on items of this preset')
        actions.push({ type: a.type, elementId: a.elementId })
      } else if (a && (a.type === 'volume' || a.type === 'brightness') && typeof a.elementId === 'string') {
        const el = byId.get(a.elementId)
        if (!el || !SLIDER_ACTIONS[a.type as 'volume' | 'brightness'].types.has(el.type)) {
          return bad('bad_actions', a.type === 'volume' ? 'Volume works on sounds and video screens of this preset' : 'Brightness works on images and video screens of this preset')
        }
        actions.push({ type: a.type, elementId: a.elementId })
      } else if (a && a.type === 'choose' && Array.isArray(a.choices)) {
        if (!a.choices.length || a.choices.length > CHOICES_MAX) return bad('bad_actions', `Give each option an item, up to ${CHOICES_MAX}`)
        const choices: { option: string; elementId: string }[] = []
        for (const c of a.choices) {
          const el = c && typeof c.elementId === 'string' ? byId.get(c.elementId) : undefined
          if (!c || typeof c.option !== 'string' || !c.option.trim() || !el || el.type === 'widget') return bad('bad_actions', 'Each option needs an item of this preset')
          choices.push({ option: c.option.trim(), elementId: c.elementId })
        }
        actions.push({ type: 'choose', choices })
      } else if (a && a.type === 'preset' && typeof a.presetId === 'string' && UUID.test(a.presetId)) {
        const p = await db.query.scenePresets.findFirst({ where: and(eq(scenePresets.id, a.presetId), eq(scenePresets.sceneId, sceneId)), columns: { id: true } })
        if (!p) return bad('bad_actions', "Switching presets works with this scene's presets")
        actions.push({ type: 'preset', presetId: a.presetId })
      } else {
        return bad('bad_actions', "An action is { type: 'show' | 'hide' | 'toggle' | 'volume' | 'brightness', elementId }, { type: 'choose', choices: [{ option, elementId }] } or { type: 'preset', presetId }")
      }
    }
    out.actions = actions
  }
  // Volume and brightness take their value from a Slider: only a Slider's change can set them off
  if (out.actions?.some((a) => a.type === 'volume' || a.type === 'brightness')) {
    const t = out.trigger
    const w = t && t.type === 'widget' ? byId.get(t.widgetId) : undefined
    if (!w || Number((w.properties as Record<string, unknown> | null)?.controlType ?? 0) !== WIDGET_SLIDER) {
      return bad('bad_actions', 'Volume and brightness follow a Slider: start the rule from a Slider changing')
    }
  }
  // Choosing follows a Selector
  if (out.actions?.some((a) => a.type === 'choose')) {
    const t = out.trigger
    const w = t && t.type === 'widget' ? byId.get(t.widgetId) : undefined
    if (!w || Number((w.properties as Record<string, unknown> | null)?.controlType ?? 0) !== WIDGET_SELECTOR) {
      return bad('bad_actions', 'Showing the chosen item follows a Selector: start the rule from a Selector changing')
    }
  }
  return out
}

export async function countRules(presetId: string): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(sceneRules).where(eq(sceneRules.presetId, presetId))
  return n
}

/** What the server does after each change a rule makes (broadcast, platform callbacks, activity). */
export type ElementChangedHook = (e: { sceneId: string; presetId: string; elementId: string; elementType: string; deleted: false }, name: string, ruleName: string) => Promise<void>

/**
 * A widget's value changed: run this preset's enabled rules it sets off, each rule's actions in order. Returns how
 * many rules ran. One failing action doesn't stop the others; nothing here throws.
 */
export async function runWidgetRules(opts: {
  sceneId: string
  presetId: string
  widget: { id: string; properties: unknown }
  prev: unknown
  next: unknown
  elementChanged: ElementChangedHook
  /** Who changed the widget, for the activity of a preset switch. */
  actor: ActivityActor
}): Promise<number> {
  const controlType = Number((opts.widget.properties as Record<string, unknown> | null)?.controlType ?? 0)
  let rules: (typeof sceneRules.$inferSelect)[]
  try {
    rules = await db.select().from(sceneRules).where(and(eq(sceneRules.presetId, opts.presetId), eq(sceneRules.enabled, true)))
  } catch (err) {
    console.error('[rules] load failed:', err)
    return 0
  }
  let ran = 0
  for (const rule of rules) {
    const t = rule.trigger as RuleTrigger
    if (t?.type !== 'widget' || t.widgetId !== opts.widget.id || !triggerFires(t.when, controlType, opts.prev, opts.next)) continue
    ran++
    await runActions(opts.sceneId, opts.presetId, rule, opts.elementChanged, opts.actor, opts.next)
  }
  return ran
}

/** A rule's actions, in order; one failing doesn't stop the rest. `value`: the widget's new value, for volume. */
async function runActions(sceneId: string, presetId: string, rule: typeof sceneRules.$inferSelect, elementChanged: ElementChangedHook, actor: ActivityActor, value?: unknown): Promise<void> {
  for (const a of (rule.actions as RuleAction[]) ?? []) {
    try {
      await runAction(sceneId, presetId, a, rule.name, elementChanged, actor, value)
    } catch (err) {
      console.error(`[rules] rule ${rule.id} action failed:`, err)
    }
  }
}

async function runAction(sceneId: string, presetId: string, a: RuleAction, ruleName: string, elementChanged: ElementChangedHook, actor: ActivityActor, value?: unknown): Promise<void> {
  if (a.type === 'choose') {
    // An item listed for several options shows when any of them is chosen; nothing chosen hides them all
    const shown = new Set(a.choices.filter((c) => c.option === value).map((c) => c.elementId))
    for (const id of new Set(a.choices.map((c) => c.elementId))) {
      await runAction(sceneId, presetId, { type: shown.has(id) ? 'show' : 'hide', elementId: id }, ruleName, elementChanged, actor, value)
    }
    return
  }
  if (a.type === 'volume' || a.type === 'brightness') {
    const n = Number(value)
    if (!Number.isFinite(n)) return
    const { prop, types } = SLIDER_ACTIONS[a.type]
    const el = await db.query.sceneElements.findFirst({ where: and(eq(sceneElements.id, a.elementId), eq(sceneElements.presetId, presetId)) })
    if (!el || !types.has(el.type)) return
    const level = Math.round(Math.min(100, Math.max(0, n))) / 100
    const props = (el.properties as Record<string, unknown> | null) ?? {}
    if (props[prop] === level) return
    await db.update(sceneElements).set({ properties: { ...props, [prop]: level }, updatedAt: new Date() }).where(eq(sceneElements.id, el.id))
    await elementChanged({ sceneId, presetId, elementId: el.id, elementType: el.type, deleted: false }, el.name, ruleName)
    return
  }
  if (a.type === 'preset') {
    const p = await db.query.scenePresets.findFirst({ where: and(eq(scenePresets.id, a.presetId), eq(scenePresets.sceneId, sceneId)), columns: { id: true, name: true } })
    if (!p) return
    await activatePreset(sceneId, p.id)
    await recordSceneActivity(sceneId, actor, 'preset.activated', { type: 'preset', id: p.id, name: p.name }, { rule: ruleName })
    return
  }
  const el = await db.query.sceneElements.findFirst({ where: and(eq(sceneElements.id, a.elementId), eq(sceneElements.presetId, presetId)) })
  if (!el || el.type === 'widget') return
  const enabled = a.type === 'show' ? true : a.type === 'hide' ? false : !el.enabled
  if (enabled === el.enabled) return
  await db.update(sceneElements).set({ enabled, updatedAt: new Date() }).where(eq(sceneElements.id, el.id))
  await elementChanged({ sceneId, presetId, elementId: el.id, elementType: el.type, deleted: false }, el.name, ruleName)
}

function copyTrigger(t: RuleTrigger, map: (id: string) => string): RuleTrigger {
  return t.type === 'click' ? { ...t, elementId: map(t.elementId) } : { ...t, widgetId: map(t.widgetId) }
}

/** A preset was copied: copy its rules too, pointing at the copies of its elements. */
export async function copyRules(tx: { select: typeof db.select; insert: typeof db.insert }, fromPresetId: string, toPresetId: string, elementIds: Map<string, string>): Promise<void> {
  const rules = await tx.select().from(sceneRules).where(eq(sceneRules.presetId, fromPresetId))
  if (!rules.length) return
  const map = (id: string) => elementIds.get(id) ?? id
  // Every action but a preset switch points at an element
  await tx.insert(sceneRules).values(rules.map((r) => ({
    presetId: toPresetId,
    name: r.name,
    enabled: r.enabled,
    trigger: copyTrigger(r.trigger as RuleTrigger, map),
    firedFor: r.firedFor,
    actions: ((r.actions as RuleAction[]) ?? []).map((a) =>
      a.type === 'preset' ? a : a.type === 'choose' ? { ...a, choices: a.choices.map((c) => ({ ...c, elementId: map(c.elementId) })) } : { ...a, elementId: map(a.elementId) }),
  })))
}

/** The rules of these presets (the dashboard lists a preset's). */
export async function rulesOf(presetIds: string[]) {
  if (!presetIds.length) return []
  return db.select().from(sceneRules).where(inArray(sceneRules.presetId, presetIds)).orderBy(sceneRules.createdAt)
}


// ── Timed rules ──────────────────────────────────────────────────────────

/** When a Date and time widget's value ('2026-12-31T20:00', as the dashboard stores it) happens in `tz`; null when it isn't one. */
export function dueAt(value: unknown, tz: string): Date | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value.trim())
  if (!m || !isTimeZone(tz)) return null
  const at = zonedToUtc(m[1], m[2], tz)
  return Number.isNaN(at.getTime()) ? null : at
}

const RULE_ACTOR: ActivityActor = { userId: null, wallet: null, via: 'rule' }

/**
 * Runs every timed rule whose widget's date and time has arrived, once per value. A time that passed more than
 * TIMED_GRACE_MS ago is marked done without running (set in the past, or the server was down). Returns how many ran.
 */
export async function sweepTimedRules(elementChanged: ElementChangedHook, now = new Date()): Promise<number> {
  const rules = await db.select().from(sceneRules).where(and(eq(sceneRules.enabled, true), sql`${sceneRules.trigger}->>'type' = 'time'`))
  let ran = 0
  for (const rule of rules) {
    try {
      const t = rule.trigger as Extract<RuleTrigger, { type: 'time' }>
      const widget = await db.query.sceneElements.findFirst({ where: and(eq(sceneElements.id, t.widgetId), eq(sceneElements.presetId, rule.presetId)), with: { preset: { columns: { sceneId: true } } } })
      if (!widget?.enabled) continue
      const value = (widget.properties as Record<string, unknown> | null)?.value
      if (typeof value !== 'string' || value === rule.firedFor) continue
      const due = dueAt(value, t.timezone)
      if (!due || due.getTime() > now.getTime()) continue
      // Claimed first, so another server, or a slow action, never runs it twice
      const claimed = await db.update(sceneRules).set({ firedFor: value }).where(and(eq(sceneRules.id, rule.id), sql`${sceneRules.firedFor} IS DISTINCT FROM ${value}`)).returning({ id: sceneRules.id })
      if (!claimed.length || now.getTime() - due.getTime() > TIMED_GRACE_MS) continue
      ran++
      await runActions(widget.preset.sceneId, rule.presetId, rule, elementChanged, RULE_ACTOR)
    } catch (err) {
      console.error(`[rules] timed rule ${rule.id} failed:`, err)
    }
  }
  return ran
}

export const TIMED_SWEEP_MS = 20_000


// ── Click rules ──────────────────────────────────────────────────────────

/** The items of this preset that an enabled click rule starts from. */
export async function clickRuleTargets(presetId: string): Promise<Set<string>> {
  const rows = await db.select({ trigger: sceneRules.trigger }).from(sceneRules)
    .where(and(eq(sceneRules.presetId, presetId), eq(sceneRules.enabled, true), sql`${sceneRules.trigger}->>'type' = 'click'`))
  return new Set(rows.map((r) => (r.trigger as Extract<RuleTrigger, { type: 'click' }>).elementId))
}

type Tagged = { sk: string; clickEvent?: unknown }
/** The element's clickEvent marked for click rules: the SDK makes the item clickable and sends `rule_click` with this id. */
function tag<E extends Tagged>(el: E, targets: Set<string>): E {
  if (!targets.has(el.sk)) return el
  const click = el.clickEvent && typeof el.clickEvent === 'object' ? el.clickEvent as Record<string, unknown> : { type: 0 }
  return { ...el, clickEvent: { ...click, ruleElement: el.sk } }
}

/** A serialized preset (sk = its id) with its click-rule items marked. Never throws: unmarked on a failure. */
export async function withRuleClicks<P extends { sk: string; images?: Tagged[]; videos?: Tagged[]; models?: Tagged[] }>(preset: P): Promise<P> {
  try {
    const targets = await clickRuleTargets(preset.sk)
    if (!targets.size) return preset
    return {
      ...preset,
      ...(preset.images ? { images: preset.images.map((e) => tag(e, targets)) } : {}),
      ...(preset.videos ? { videos: preset.videos.map((e) => tag(e, targets)) } : {}),
      ...(preset.models ? { models: preset.models.map((e) => tag(e, targets)) } : {}),
    }
  } catch (err) {
    console.error('[rules] click marks failed:', err)
    return preset
  }
}

/** One serialized element of `presetId`, marked if a click rule starts from it. */
export async function withRuleClickElement<E extends Tagged>(presetId: string, type: string, element: E): Promise<E> {
  if (!CLICKABLE.has(type)) return element
  try { return tag(element, await clickRuleTargets(presetId)) } catch { return element }
}

/** A visitor clicked `elementId` in-world: run the enabled click rules of its preset. Returns how many ran. */
export async function runClickRules(opts: { sceneId: string; presetId: string; elementId: string; elementChanged: ElementChangedHook; actor: ActivityActor }): Promise<number> {
  const rules = await db.select().from(sceneRules).where(and(eq(sceneRules.presetId, opts.presetId), eq(sceneRules.enabled, true), sql`${sceneRules.trigger}->>'type' = 'click'`))
  let ran = 0
  for (const rule of rules) {
    if ((rule.trigger as Extract<RuleTrigger, { type: 'click' }>).elementId !== opts.elementId) continue
    ran++
    await runActions(opts.sceneId, opts.presetId, rule, opts.elementChanged, opts.actor)
  }
  return ran
}

/** Items whose click marks may have changed when a rule changed: its click trigger's item, before and after. */
export function clickItemsOf(...triggers: unknown[]): string[] {
  return [...new Set(triggers.filter((t): t is Extract<RuleTrigger, { type: 'click' }> => !!t && (t as any).type === 'click').map((t) => t.elementId))]
}
