import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AssistantActionView, AssistantActivityItem, AssistantPlanView } from '@virvixr/shared'
import { PlanCard, type PlanPhase } from './PlanCard'
import { MessageLinks } from './MessageLinks'
import { ActivityList } from '../../app/(dashboard)/settings/AssistantActivity'
import { activityDate, approveLabel, budgetLine, lockedCopy, planButtonLabel, tokenExpiresWithin, approveRefused, isExpiredCode, needsReapproval, REAPPROVE } from './copy'

describe('budgetLine', () => {
  it('shows what is left when not warning', () => {
    expect(budgetLine({ percentLeft: 80, warn: false, resetsAt: '2026-12-03T00:00:00Z' })).toEqual({ text: "80% of this month's assistant budget left", upgrade: false })
  })
  it('shows what is used when warning', () => {
    expect(budgetLine({ percentLeft: 15, warn: true, resetsAt: '2026-12-03T00:00:00Z' })).toEqual({ text: "You've used 85% of this month's assistant budget", upgrade: false })
  })
  it('says when it comes back at zero, with an upgrade link', () => {
    expect(budgetLine({ percentLeft: 0, warn: true, resetsAt: '2026-12-03T00:00:00Z' })).toEqual({ text: "You've used this month's assistant budget. It comes back on 3 Dec.", upgrade: true })
  })
  it('shows nothing with no cap', () => {
    expect(budgetLine({ percentLeft: 100, warn: false, resetsAt: null })).toBeNull()
    expect(budgetLine(null)).toBeNull()
  })
})

describe('lockedCopy', () => {
  it('plan', () => expect(lockedCopy('plan')).toEqual({ text: 'The assistant is included with paid plans.', link: { label: 'See plans', href: '/settings' } }))
  it('trial', () => expect(lockedCopy('trial')).toEqual({ text: 'Create an account to use the assistant.', link: null }))
})

describe('planButtonLabel', () => {
  it('counts the changes', () => {
    expect(planButtonLabel(3)).toBe('Do these 3 changes')
    expect(planButtonLabel(1)).toBe('Do this change')
  })
})

describe('tokenExpiresWithin', () => {
  const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`
  it('is true near expiry, false far from it, true when unreadable', () => {
    const now = 1_000_000_000_000
    expect(tokenExpiresWithin(jwt(now / 1000 + 30), 60_000, now)).toBe(true)
    expect(tokenExpiresWithin(jwt(now / 1000 + 600), 60_000, now)).toBe(false)
    expect(tokenExpiresWithin('garbage', 60_000, now)).toBe(true)
  })
})

describe('approveRefused', () => {
  it('is a refusal only when it errored before any step ran', () => {
    expect(approveRefused({ error: 'expired', ran: false })).toBe(true)
    expect(approveRefused({ error: 'boom', ran: true })).toBe(false)
    expect(approveRefused({ error: null, ran: false })).toBe(false)
  })
  it('knows the expired codes', () => {
    expect(isExpiredCode('expired')).toBe(true)
    expect(isExpiredCode('http_410')).toBe(true)
    expect(isExpiredCode('invalid_token')).toBe(false)
    expect(isExpiredCode(null)).toBe(false)
  })
})

describe('needsReapproval', () => {
  it('asks again for steps still waiting after a reload, and not for anything else', () => {
    expect(REAPPROVE).toBe('Ask again to approve this plan.')
    expect(needsReapproval([{ status: 'done' }, { status: 'awaiting_confirmation' }])).toBe(true)
    expect(needsReapproval([{ status: 'done' }, { status: 'cancelled' }])).toBe(false)
    expect(needsReapproval([])).toBe(false)
  })
})

const step = (o: Partial<AssistantActionView> = {}): AssistantActionView => ({ id: 's1', tool: 'send_studio_prompt', label: 'Send a prompt to Blue jacket', orgName: 'Acme', status: 'awaiting_confirmation', canUndo: false, error: null, planId: 'c1', step: 0, ...o })
const FUTURE = '2999-01-01T00:00:00Z'
const card: AssistantPlanView = { planId: 'c1', kind: 'card', detail: 'Uses 1 of your 3 prompts left today.', steps: [step()], token: 't', expiresAt: FUTURE }
const noop = () => {}
const renderCard = (plan: AssistantPlanView, phase: PlanPhase, steps = plan.steps) => renderToStaticMarkup(createElement(PlanCard, {
  plan, steps, phase, busy: false, error: null, onApprove: noop, onCancel: noop, onUndoStep: async () => {}, onUndoAll: async () => {},
}))

describe('approveLabel', () => {
  it('is Confirm for a card and counts the changes for a plan', () => {
    expect(approveLabel(card)).toBe('Confirm')
    expect(approveLabel({ kind: 'plan', steps: [step(), step({ id: 's2' })] })).toBe('Do these 2 changes')
  })
})

describe('PlanCard as a card', () => {
  it('shows the label, the organization and the cost line, with Confirm and Cancel', () => {
    const html = renderCard(card, 'pending')
    expect(html).toContain('Send a prompt to Blue jacket')
    expect(html).toContain('Acme')
    expect(html).toContain('Uses 1 of your 3 prompts left today.')
    expect(html).toContain('>Confirm<')
    expect(html).toContain('>Cancel<')
    expect(html).not.toContain('Do this change')
    expect(html).not.toMatch(/Do these \d+ changes/)
    expect(html).not.toContain('>1.<')
  })

  it('after approval is the step row, with no Undo all', () => {
    const html = renderCard(card, 'approved', [step({ status: 'done', canUndo: true })])
    expect(html).toContain('Done')
    expect(html).toContain('>Undo<')
    expect(html).not.toContain('Undo all')
    expect(html).not.toContain('>Confirm<')
  })

  it('says it expired the way a plan does', () => {
    const html = renderCard({ ...card, expiresAt: '2000-01-01T00:00:00Z' }, 'pending')
    expect(html).toContain('This plan expired. Ask again to get a fresh one.')
    expect(html).not.toContain('>Confirm<')
  })

  it('a plan still offers its count button and Undo all', () => {
    const plan: AssistantPlanView = { ...card, kind: 'plan', detail: null, steps: [step({ planId: 'p' }), step({ id: 's2', planId: 'p' })] }
    expect(renderCard(plan, 'pending')).toContain('Do these 2 changes')
    expect(renderCard(plan, 'approved', plan.steps.map((s) => ({ ...s, status: 'done' as const })))).toContain('Undo all')
  })
})

describe('MessageLinks', () => {
  it('shows a link detail under its button', () => {
    const html = renderToStaticMarkup(createElement(MessageLinks, { links: [{ label: 'Finalize', href: '/studio/d1?step=finalize', detail: 'Total $12' }, { label: 'Scene', href: '/scenes' }], onOpen: noop }))
    expect(html).toContain('Finalize')
    expect(html).toContain('Total $12')
    expect(html.indexOf('Finalize')).toBeLessThan(html.indexOf('Total $12'))
    expect(html).toContain('Scene')
  })
})

describe('activityDate', () => {
  it('shows the day, month, year and time', () => {
    expect(activityDate('2026-11-20T09:05:00Z', 'UTC')).toBe('20 Nov 2026, 09:05')
  })
})

describe('ActivityList', () => {
  const item = (id: string, o: Partial<AssistantActivityItem> = {}): AssistantActivityItem => ({ ...step({ id, status: 'done', planId: null, step: null }), createdAt: '2026-11-20T09:05:00Z', conversationId: null, effect: 'write', ...o })
  const render = (props: Partial<Parameters<typeof ActivityList>[0]>) => renderToStaticMarkup(createElement(ActivityList, { list: null, loadingMore: false, error: null, onMore: noop, onUndo: async () => {}, ...props }))

  it('says nothing has happened yet', () => {
    expect(render({ list: { items: [], next: null } })).toContain('Nothing yet. Changes the assistant makes show here.')
  })

  it('shows each change with its organization, status, date and Undo, and Load more while there is more', () => {
    const html = render({ list: { items: [item('a', { canUndo: true }), item('b', { status: 'undone' })], next: 'cur' } })
    expect(html).toContain('Send a prompt to Blue jacket')
    expect(html).toContain('Acme')
    expect(html).toContain('Done')
    expect(html).toContain('Undone')
    expect(html).toContain('>Undo<')
    expect(html).toContain('Nov 2026')
    expect(html).toContain('Load more')
  })

  it('has no Load more on the last page', () => {
    expect(render({ list: { items: [item('a')], next: null } })).not.toContain('Load more')
  })
})
