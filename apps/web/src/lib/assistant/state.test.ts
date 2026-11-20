import { describe, it, expect } from 'vitest'
import type { AssistantActionView, AssistantStreamEvent } from '@virvixr/shared'
import { reduce, safeHref, type PanelState } from './state'

const empty: PanelState = { messages: [], streaming: true, plan: null, budget: null, error: null }
const act = (o: Partial<AssistantActionView> = {}): AssistantActionView => ({ id: 'a1', tool: 't', label: 'L', orgName: null, status: 'running', canUndo: false, error: null, planId: null, step: null, ...o })
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
    const plan = { planId: 'p', steps: [], token: 't', expiresAt: 'x' }
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

describe('safeHref', () => {
  it('accepts dashboard paths only', () => {
    for (const h of ['/scenes', '/scenes?id=abc', '/scenes/_?id=s1', '/events', '/command-center']) expect(safeHref(h), h).toBe(true)
    for (const h of ['https://evil.example', 'javascript:alert(1)', '//evil.example', '/admin', '/scenes/../admin', '/scenes\\..\\admin', '/scenes/%2e%2e/admin', '/scenes/%2E/x']) expect(safeHref(h), h).toBe(false)
  })
})
