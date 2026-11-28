/**
 * Scene rules (LIV-196): types and plain-words wording for the dashboard. Mirrors apps/server src/rules/rules.ts.
 */
export type RuleWhen = 'on' | 'off' | 'press' | 'change'
export interface RuleTrigger { type: 'widget'; widgetId: string; when: RuleWhen }
export type RuleAction = { type: 'show' | 'hide' | 'toggle'; elementId: string } | { type: 'preset'; presetId: string }
export interface SceneRule { id: string; presetId: string; name: string; enabled: boolean; trigger: RuleTrigger; actions: RuleAction[] }

export const TOGGLE = 1
export const TRIGGER = 5
export const ACTIONS_PER_RULE = 10

/** What a widget of this control type can set off. */
export function whenChoices(controlType: number): { value: RuleWhen; label: string }[] {
  if (controlType === TOGGLE) return [{ value: 'on', label: 'is turned on' }, { value: 'off', label: 'is turned off' }, { value: 'change', label: 'is switched either way' }]
  if (controlType === TRIGGER) return [{ value: 'press', label: 'is pressed' }]
  return [{ value: 'change', label: 'changes' }]
}

const WHEN_WORDS: Record<RuleWhen, string> = { on: 'is turned on', off: 'is turned off', press: 'is pressed', change: 'changes' }

interface Named { id: string; name: string }

/** "When Stage lights is turned off, hide Light rig 1, then switch to the preset Show time." */
export function describeRule(rule: Pick<SceneRule, 'trigger' | 'actions'>, elements: Named[], presets: Named[]): string {
  const el = (id: string) => elements.find((e) => e.id === id)?.name || 'a deleted item'
  const pr = (id: string) => presets.find((p) => p.id === id)?.name || 'a deleted preset'
  const when = WHEN_WORDS[rule.trigger.when]
  const steps = rule.actions.map((a) => {
    if (a.type === 'preset') return `switch to the preset ${pr(a.presetId)}`
    // A toggle action flips it: hidden items appear, shown ones go
    const verb = a.type === 'show' ? 'show' : a.type === 'hide' ? 'hide' : 'show or hide'
    return `${verb} ${el(a.elementId)}`
  })
  const list = steps.length <= 1 ? steps.join('') : `${steps.slice(0, -1).join(', ')}, then ${steps[steps.length - 1]}`
  return `When ${el(rule.trigger.widgetId)} ${when}, ${list}.`
}

/** Items a rule can show or hide: everything in the preset except widgets. */
export const ruleTargets = <T extends { type: string }>(elements: T[]): T[] => elements.filter((e) => e.type !== 'widget')
