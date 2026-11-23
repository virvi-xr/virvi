import { describe, it, expect } from 'vitest'
import type { AssistantActionView, AssistantActivityItem, AssistantStreamEvent } from '@virvixr/shared'
import { appendActivity, planSteps, reduce, replaceActivity, safeHref, startReply, type PanelState } from './state'

const empty: PanelState = { messages: [], streaming: true, plan: null, budget: null, error: null }
const act = (o: Partial<AssistantActionView> = {}): AssistantActionView => ({ id: 'a1', tool: 't', label: 'L', orgName: null, status: 'running', canUndo: false, error: null, planId: null, step: null, detail: null, ...o })
const run = (events: AssistantStreamEvent[], s = empty) => events.reduce(reduce, s)

describe('reduce', () => {
  it('builds one assistant message from text deltas', () => {
    const s = run([{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }])
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ role: 'assistant', text: 'Hello' })
  })

  it('upserts an action by id', () => {
    const s = run([{ type: 'action', action: act() }, { type: 'action', action: act({ status: 'done', canUndo: true }) }, { type: 'action', action: act({ id: 'a2' }) }])
    expect(s.messages[0].actions.map((a) => [a.id, a.status])).toEqual([['a1', 'done'], ['a2', 'running']])
  })

  it('drops a link to another site and keeps a dashboard link', () => {
    const s = run([{ type: 'link', label: 'x', href: 'https://evil.example' }, { type: 'link', label: 'Scene', href: '/scenes?id=1' }])
    expect(s.messages[0].links).toEqual([{ label: 'Scene', href: '/scenes?id=1' }])
  })

  it('sets plan, budget and error, and done clears streaming', () => {
    const plan = { planId: 'p', kind: 'plan' as const, detail: null, steps: [], token: 't', expiresAt: 'x' }
    const budget = { percentLeft: 50, warn: false, resetsAt: null }
    const s = run([{ type: 'plan', plan }, { type: 'budget', budget }, { type: 'error', code: 'c', message: 'm' }, { type: 'done', messageId: null }])
    expect(s).toMatchObject({ plan, budget, error: 'm', streaming: false })
  })

  it('appends text to the last message when it is the assistant, and starts a new one after a user message', () => {
    const user = { id: 'u', role: 'user' as const, text: 'hi', actions: [], links: [], createdAt: '' }
    const s = run([{ type: 'text', delta: 'a' }], { ...empty, messages: [user] })
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('startReply', () => {
  it('puts the text that follows into a new message, not the one before it', () => {
    const proposed = run([{ type: 'text', delta: 'Approve the plan to go ahead.' }])
    const s = run([{ type: 'text', delta: 'Both changes are done.' }], startReply(proposed))
    expect(s.messages.map((m) => m.text)).toEqual(['Approve the plan to go ahead.', 'Both changes are done.'])
  })
})

describe('safeHref', () => {
  it('accepts dashboard paths only', () => {
    for (const h of ['/scenes', '/scenes?id=abc', '/scenes/_?id=s1', '/events', '/command-center', '/sync?scene=s1', '/drops', '/virvi-cities', '/cities', '/deploy', '/giveaways']) expect(safeHref(h), h).toBe(true)
    for (const h of ['https://evil.example', 'javascript:alert(1)', '//evil.example', '/admin', '/scenes/../admin', '/scenes\\..\\admin', '/scenes/%2e%2e/admin', '/scenes/%2E/x']) expect(safeHref(h), h).toBe(false)
  })
})

describe('cards', () => {
  const card = { planId: 'c1', kind: 'card' as const, detail: 'Uses 1 of your 3 prompts left today.', steps: [act({ id: 's1', status: 'awaiting_confirmation', planId: 'c1', step: 0 })], token: 't', expiresAt: 'x' }

  it('keeps the card and its single step, and the step follows its status updates', () => {
    const s = run([{ type: 'plan', plan: card }])
    expect(s.plan).toEqual(card)
    expect(planSteps(s).map((a) => [a.id, a.status])).toEqual([['s1', 'awaiting_confirmation']])
    const after = run([{ type: 'action', action: act({ id: 's1', status: 'running', planId: 'c1', step: 0 }) }, { type: 'action', action: act({ id: 's1', status: 'done', planId: 'c1', step: 0 }) }], s)
    expect(planSteps(after).map((a) => [a.id, a.status])).toEqual([['s1', 'done']])
  })

  it('has no steps without a plan', () => {
    expect(planSteps(empty)).toEqual([])
  })
})

describe('link detail', () => {
  it('keeps the detail a link carries, and adds none when it has none', () => {
    const s = run([
      { type: 'link', label: 'Finalize', href: '/studio/d1?step=finalize', detail: 'Total $12' },
      { type: 'link', label: 'Scene', href: '/scenes?id=1' },
    ])
    expect(s.messages[0].links).toEqual([{ label: 'Finalize', href: '/studio/d1?step=finalize', detail: 'Total $12' }, { label: 'Scene', href: '/scenes?id=1' }])
  })
})

describe('activity list', () => {
  const item = (id: string, o: Partial<AssistantActivityItem> = {}): AssistantActivityItem => ({ ...act({ id, status: 'done' }), createdAt: '2026-11-20T10:00:00Z', conversationId: 'cv', effect: 'write', ...o })

  it('starts with the first page and appends the next ones, keeping the latest cursor', () => {
    const first = appendActivity(null, { items: [item('a'), item('b')], next: 'c1' })
    expect(first).toEqual({ items: [item('a'), item('b')], next: 'c1' })
    const second = appendActivity(first, { items: [item('c')], next: null })
    expect(second.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(second.next).toBeNull()
  })

  it('does not repeat a row a later page sends again', () => {
    const s = appendActivity(appendActivity(null, { items: [item('a'), item('b')], next: 'c1' }), { items: [item('b'), item('c')], next: null })
    expect(s.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('swaps in an undone action and keeps its date and kind', () => {
    const s = appendActivity(null, { items: [item('a', { canUndo: true }), item('b')], next: null })
    const after = replaceActivity(s, act({ id: 'a', status: 'undone', canUndo: false }))
    expect(after.items[0]).toMatchObject({ id: 'a', status: 'undone', canUndo: false, createdAt: '2026-11-20T10:00:00Z', effect: 'write', conversationId: 'cv' })
    expect(after.items[1]).toEqual(item('b'))
  })
})
