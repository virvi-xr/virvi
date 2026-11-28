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
export type RuleAction =
  | { type: 'show' | 'hide' | 'toggle'; elementId: string }
  | { type: 'preset'; presetId: string }
export interface RuleInput { name?: unknown; enabled?: unknown; trigger?: unknown; actions?: unknown }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Toggle (1) and Trigger (5) first; any widget for 'change'; Date and time (4) for timed rules. */
const WIDGET_TOGGLE = 1
const WIDGET_DATETIME = 4
const WIDGET_TRIGGER = 5
/** A timed rule whose time passed longer ago than this (the server was down, or the time was set in the past) is skipped. */
export const TIMED_GRACE_MS = 10 * 60_000

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
    const shape = "A trigger is { type: 'widget', widgetId, when: 'on' | 'off' | 'press' | 'change' } or { type: 'time', widgetId, timezone }"
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
      } else if (a && a.type === 'preset' && typeof a.presetId === 'string' && UUID.test(a.presetId)) {
        const p = await db.query.scenePresets.findFirst({ where: and(eq(scenePresets.id, a.presetId), eq(scenePresets.sceneId, sceneId)), columns: { id: true } })
        if (!p) return bad('bad_actions', "Switching presets works with this scene's presets")
        actions.push({ type: 'preset', presetId: a.presetId })
      } else {
        return bad('bad_actions', "An action is { type: 'show' | 'hide' | 'toggle', elementId } or { type: 'preset', presetId }")
      }
    }
    out.actions = actions
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
    await runActions(opts.sceneId, opts.presetId, rule, opts.elementChanged, opts.actor)
  }
  return ran
}

/** A rule's actions, in order; one failing doesn't stop the rest. */
async function runActions(sceneId: string, presetId: string, rule: typeof sceneRules.$inferSelect, elementChanged: ElementChangedHook, actor: ActivityActor): Promise<void> {
  for (const a of (rule.actions as RuleAction[]) ?? []) {
    try {
      await runAction(sceneId, presetId, a, rule.name, elementChanged, actor)
    } catch (err) {
      console.error(`[rules] rule ${rule.id} action failed:`, err)
    }
  }
}

async function runAction(sceneId: string, presetId: string, a: RuleAction, ruleName: string, elementChanged: ElementChangedHook, actor: ActivityActor): Promise<void> {
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

/** A preset was copied: copy its rules too, pointing at the copies of its elements. */
export async function copyRules(tx: { select: typeof db.select; insert: typeof db.insert }, fromPresetId: string, toPresetId: string, elementIds: Map<string, string>): Promise<void> {
  const rules = await tx.select().from(sceneRules).where(eq(sceneRules.presetId, fromPresetId))
  if (!rules.length) return
  const map = (id: string) => elementIds.get(id) ?? id
  await tx.insert(sceneRules).values(rules.map((r) => ({
    presetId: toPresetId,
    name: r.name,
    enabled: r.enabled,
    trigger: { ...(r.trigger as RuleTrigger), widgetId: map((r.trigger as RuleTrigger).widgetId) },
    firedFor: r.firedFor,
    actions: ((r.actions as RuleAction[]) ?? []).map((a) => (a.type === 'preset' ? a : { ...a, elementId: map(a.elementId) })),
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
