import { describe, it, expect, vi, afterEach } from 'vitest'
import { bindClick, setRuleClickSender } from '../src/managers/click.js'

/** LIV-196: an item a click rule starts from is clickable and sends its clicks to the room. */
function adapter() {
  const handlers: Array<{ opts: any; fn: () => void }> = []
  return {
    handlers,
    a: {
      onPointerDown: vi.fn((_e: unknown, opts: any, fn: () => void) => handlers.push({ opts, fn })),
      removePointerEvents: vi.fn(),
      openUrl: vi.fn(),
    } as any,
  }
}

afterEach(() => setRuleClickSender(null))

describe('click rules in bindClick', () => {
  it('makes a marked item clickable with no action, and sends its id', () => {
    const sent: string[] = []
    setRuleClickSender((id) => sent.push(id))
    const { a, handlers } = adapter()
    bindClick(a, 1, undefined, { type: 0, ruleElement: 'el-1', hoverText: 'Flip the lights' })
    expect(handlers).toHaveLength(1)
    expect(handlers[0].opts).toEqual({ hoverText: 'Flip the lights', showFeedback: true })
    handlers[0].fn()
    expect(sent).toEqual(['el-1'])
  })

  it('runs the click action and the rule together', () => {
    const sent: string[] = []
    setRuleClickSender((id) => sent.push(id))
    const { a, handlers } = adapter()
    bindClick(a, 1, undefined, { type: 1, externalLink: 'https://example.com', ruleElement: 'el-2' })
    handlers[0].fn()
    expect(a.openUrl).toHaveBeenCalledWith('https://example.com')
    expect(sent).toEqual(['el-2'])
  })

  it('an unmarked item with no action stays unclickable', () => {
    const { a, handlers } = adapter()
    bindClick(a, 1, undefined, { type: 0 })
    expect(handlers).toHaveLength(0)
  })
})
