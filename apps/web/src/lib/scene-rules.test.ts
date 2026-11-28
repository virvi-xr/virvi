import { describe, it, expect } from 'vitest'
import { describeRule, ruleTargets, triggerFor, whenChoices, DATETIME, TOGGLE, TRIGGER } from './scene-rules'

const els = [{ id: 'w', name: 'Stage lights' }, { id: 'r1', name: 'Light rig 1' }, { id: 'r2', name: 'Light rig 2' }]
const presets = [{ id: 'p', name: 'Show time' }]

describe('scene rules wording (LIV-196)', () => {
  it('says what a rule does in plain words', () => {
    expect(describeRule({ trigger: { type: 'widget', widgetId: 'w', when: 'off' }, actions: [{ type: 'hide', elementId: 'r1' }, { type: 'hide', elementId: 'r2' }] }, els, presets))
      .toBe('When Stage lights is turned off, hide Light rig 1, then hide Light rig 2.')
    expect(describeRule({ trigger: { type: 'widget', widgetId: 'w', when: 'press' }, actions: [{ type: 'toggle', elementId: 'r1' }, { type: 'hide', elementId: 'x' }, { type: 'preset', presetId: 'p' }] }, els, presets))
      .toBe('When Stage lights is pressed, show or hide Light rig 1, hide a deleted item, then switch to the preset Show time.')
  })

  it('offers the triggers each control can set off, and never widgets as targets', () => {
    expect(whenChoices(TOGGLE).map((c) => c.value)).toEqual(['on', 'off', 'change'])
    expect(whenChoices(TRIGGER).map((c) => c.value)).toEqual(['press'])
    expect(whenChoices(6).map((c) => c.value)).toEqual(['change'])
    expect(ruleTargets([{ type: 'widget' }, { type: 'image' }])).toEqual([{ type: 'image' }])
  })

  it('timed rules', () => {
    expect(whenChoices(DATETIME).map((c) => c.value)).toEqual(['time', 'change'])
    expect(triggerFor('w', 'time', 'Europe/London')).toEqual({ type: 'time', widgetId: 'w', timezone: 'Europe/London' })
    expect(triggerFor('w', 'on', 'UTC')).toEqual({ type: 'widget', widgetId: 'w', when: 'on' })
    expect(describeRule({ trigger: { type: 'time', widgetId: 'w', timezone: 'America/New_York' }, actions: [{ type: 'hide', elementId: 'r1' }] }, els, presets))
      .toBe('When the date and time in Stage lights arrives (America/New York time), hide Light rig 1.')
  })

  it('click rules', () => {
    expect(triggerFor('r1', 'click', 'UTC')).toEqual({ type: 'click', elementId: 'r1' })
    expect(describeRule({ trigger: { type: 'click', elementId: 'r1' }, actions: [{ type: 'toggle', elementId: 'r2' }] }, els, presets))
      .toBe('When someone clicks Light rig 1, show or hide Light rig 2.')
  })
})
