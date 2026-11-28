import { describe, it, expect, vi } from 'vitest'
import { clickHandler } from '../src/edit/controller.js'
import { RuleClickLimiter, RULE_CLICK_BURST } from '../src/rule-clicks.js'

/** LIV-196: items a click rule starts from send their clicks to Virvi, through the server half. */
describe('Hyperfy click rules', () => {
  const on = () => ({ select: vi.fn(), open: vi.fn(), rule: vi.fn() })

  it('makes a marked item clickable with no action, and runs its link and the rule together', () => {
    const o = on()
    clickHandler({ key: 'k', clickUrl: null, ruleElement: 'el-1' }, false, o)!()
    expect(o.rule).toHaveBeenCalledWith('el-1')
    const o2 = on()
    clickHandler({ key: 'k', clickUrl: 'https://example.com', ruleElement: 'el-2' }, false, o2)!()
    expect(o2.open).toHaveBeenCalledWith('https://example.com')
    expect(o2.rule).toHaveBeenCalledWith('el-2')
  })

  it('editing still selects, and an unmarked item with no action has no handler', () => {
    const o = on()
    clickHandler({ key: 'k', clickUrl: null, ruleElement: 'el-1' }, true, o)!()
    expect(o.select).toHaveBeenCalledWith('k')
    expect(o.rule).not.toHaveBeenCalled()
    expect(clickHandler({ key: 'k', clickUrl: null, ruleElement: null }, false, on())).toBeUndefined()
  })

  it('limits each visitor to a burst, then refills', () => {
    const l = new RuleClickLimiter()
    const sent = Array.from({ length: RULE_CLICK_BURST + 3 }, () => l.take('p1', 1000)).filter(Boolean).length
    expect(sent).toBe(RULE_CLICK_BURST)
    expect(l.take('p2', 1000)).toBe(true)
    expect(l.take('p1', 2000)).toBe(true)
  })
})
