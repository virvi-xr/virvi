import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AssistantActionView, AssistantActivityItem, AssistantPlanView, ShowView } from '@virvixr/shared'
import { PlanCard, type PlanPhase } from './PlanCard'
import { MessageLinks } from './MessageLinks'
import { MessageText } from './MessageText'
import Markdown from '../Markdown'
import { ActivityList } from '../../app/(dashboard)/settings/AssistantActivity'
import { ActionRow } from './ActionRow'
import { ShowChecklist, loadsShows } from './ShowChecklist'
import { activityDate, approveLabel, budgetLine, lockedCopy, planButtonLabel, tokenExpiresWithin, approveRefused, isExpiredCode, reapproveCopy, REAPPROVE, RECONFIRM } from './copy'

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

describe('reapproveCopy', () => {
  it('asks again for steps still waiting after a reload, and not for anything else', () => {
    expect(REAPPROVE).toBe('Ask again to approve this plan.')
    expect(reapproveCopy([{ status: 'done', detail: null }, { status: 'awaiting_confirmation', detail: null }])).toBe(REAPPROVE)
    expect(reapproveCopy([{ status: 'done', detail: null }, { status: 'cancelled', detail: 'x' }])).toBeNull()
    expect(reapproveCopy([])).toBeNull()
  })
  it('asks to confirm a card (the only row with a detail), never to approve a plan', () => {
    expect(RECONFIRM).toBe('Ask again to confirm this.')
    expect(reapproveCopy([{ status: 'awaiting_confirmation', detail: '"Neon cap": Uses 1 of your 3 prompts left today.' }])).toBe(RECONFIRM)
  })
})

const COST = 'Uses 1 of your 3 prompts left today.'
const step = (o: Partial<AssistantActionView> = {}): AssistantActionView => ({ id: 's1', tool: 'send_studio_prompt', label: 'Send a prompt to Blue jacket', orgName: 'Acme', status: 'awaiting_confirmation', canUndo: false, error: null, planId: 'c1', step: 0, detail: COST, ...o })
const FUTURE = '2999-01-01T00:00:00Z'
const card: AssistantPlanView = { planId: 'c1', kind: 'card', detail: COST, steps: [step()], token: 't', expiresAt: FUTURE }
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

  it('says it expired as a card, not a plan', () => {
    const html = renderCard({ ...card, expiresAt: '2000-01-01T00:00:00Z' }, 'pending')
    expect(html).toContain('This expired. Ask again.')
    expect(html).not.toContain('plan')
    expect(html).not.toContain('>Confirm<')
    const plan: AssistantPlanView = { ...card, kind: 'plan', detail: null, expiresAt: '2000-01-01T00:00:00Z', steps: [step({ detail: null }), step({ id: 's2', detail: null })] }
    expect(renderCard(plan, 'pending')).toContain('This plan expired. Ask again to get a fresh one.')
  })

  it("shows the card's detail on separate lines (the text it sends included)", () => {
    const detail = '"Neon cap": Uses 1 of your 3 prompts left today.\nSlots: hat\na neon cap with rivets'
    const html = renderCard({ ...card, detail, steps: [step({ detail })] }, 'pending')
    expect(html).toContain('whitespace-pre-line')
    expect(html).toContain('a neon cap with rivets')
  })

  it('a plan still offers its count button and Undo all', () => {
    const plan: AssistantPlanView = { ...card, kind: 'plan', detail: null, steps: [step({ planId: 'p', detail: null }), step({ id: 's2', planId: 'p', detail: null })] }
    expect(renderCard(plan, 'pending')).toContain('Do these 2 changes')
    expect(renderCard(plan, 'approved', plan.steps.map((s) => ({ ...s, status: 'done' as const })))).toContain('Undo all')
  })
})

describe('ActionRow', () => {
  it("shows a waiting card's detail in the history (it has no token there, so no Confirm)", () => {
    const html = renderToStaticMarkup(createElement(ActionRow, { action: step() }))
    expect(html).toContain(COST)
    expect(html).toContain('Waiting')
    expect(html).not.toContain('Confirm')
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
  const render = (props: Partial<Parameters<typeof ActivityList>[0]>) => renderToStaticMarkup(createElement(ActivityList, { list: null, loadingMore: false, error: null, onMore: noop, onRetry: noop, onUndo: async () => {}, ...props }))

  it('shows why the first page failed, with Try again', () => {
    const html = render({ list: null, error: 'The server is down.' })
    expect(html).toContain('The server is down.')
    expect(html).toContain('Try again')
    expect(html).not.toContain('Loading…')
    expect(render({ list: { items: [item('a')], next: 'cur' }, error: 'Load more failed.' })).not.toContain('Try again')
  })

  it("shows a card's detail with its date", () => {
    const html = render({ list: { items: [item('a', { effect: 'paid', detail: '"Neon cap": Uses 1 gifted prompt (2 left).' })], next: null } })
    expect(html).toContain('Uses 1 gifted prompt (2 left).')
    expect(html).toContain('Nov 2026')
  })

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

describe('MessageText', () => {
  const reply = (text: string) => renderToStaticMarkup(createElement(MessageText, { role: 'assistant', text, onOpen: () => {} }))

  it('links dashboard paths and Virvi addresses, and shows any other address as text', () => {
    const html = reply('[Your scene](/scenes?id=x), [docs](https://docs.virvi.io/x) and [bad](https://evil.example)')
    expect(html).toContain('<a href="/scenes?id=x"')
    expect(html).not.toMatch(/<a href="\/scenes\?id=x"[^>]*target=/)
    expect(html).toMatch(/<a href="https:\/\/docs\.virvi\.io\/x" target="_blank" rel="noopener noreferrer"/)
    expect(html).toContain('bad (https://evil.example)')
    expect(html).not.toContain('href="https://evil.example"')
  })

  it('does not link a relative path outside the dashboard, or a look-alike host', () => {
    const html = reply('[a](/admin/x) [b](https://virvi.io.evil.example/) [c](http://virvi.io/)')
    expect(html).not.toContain('<a ')
    expect(html).toContain('a (/admin/x)')
  })

  it('shows virvi.io as user info, or a host that only ends in virvi.io, as text', () => {
    const html = reply('[a](https://virvi.io@evil.example/x) and [b](https://evilvirvi.io/)')
    expect(html).not.toContain('<a ')
    expect(html).toContain('a (https://virvi.io@evil.example/x)')
    expect(html).toContain('b (https://evilvirvi.io/)')
  })

  it('renders a table inside a sideways-scrolling wrapper', () => {
    expect(reply('| a | b |\n|---|:-:|\n| 1 | 2 |')).toMatch(/<div class="[^"]*overflow-x-auto[^"]*"><table/)
  })

  it('renders headings below the page’s own levels', () => {
    const html = reply('# One\n## Two\n### Three')
    expect(html).toContain('<h3')
    expect(html).toContain('<h4')
    expect(html).toContain('<h5')
  })

  it('escapes html in a reply', () => {
    const html = reply('<b>hi</b>')
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;')
    expect(html).not.toContain('<b>')
  })

  it('shows a user message as plain text', () => {
    const html = renderToStaticMarkup(createElement(MessageText, { role: 'user', text: '**x**', onOpen: () => {} }))
    expect(html).toContain('**x**')
    expect(html).not.toContain('<strong')
  })
})

describe('Markdown, external links (Studio)', () => {
  const studio = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))

  it('shows a path as its label only, and opens a web address in a new tab', () => {
    const path = studio('[x](/scenes)')
    expect(path).not.toContain('<a ')
    expect(path).toContain('x')
    expect(path).not.toContain('/scenes')
    expect(studio('[x](https://e.com)')).toContain('<a href="https://e.com" target="_blank" rel="noopener noreferrer"')
  })
})

describe('loadsShows', () => {
  it('asks for the shows only outside the demo, once the assistant is there (locked still reads them)', () => {
    expect(loadsShows({ state: 'hidden' }, false)).toBe(false)
    expect(loadsShows({ state: 'locked', reason: 'plan' }, false)).toBe(true)
    expect(loadsShows({ state: 'ok', budget: { percentLeft: 100, warn: false, resetsAt: null } }, false)).toBe(true)
    expect(loadsShows({ state: 'ok', budget: { percentLeft: 100, warn: false, resetsAt: null } }, true)).toBe(false)
  })
})

describe('ShowChecklist', () => {
  const show = (over: Partial<ShowView> = {}): ShowView => ({
    id: 's1', title: 'Launch party', eventId: 'e1', orgName: null, createdAt: '2026-11-20T00:00:00Z', closedAt: null,
    timeline: null, warning: null,
    items: [
      { id: 'i1', kind: 'event', label: 'Create the event', state: 'done', note: 'Created for 3 Dec', ref: {}, wearable: null },
      { id: 'i2', kind: 'wearable', label: 'Design the wearable', state: 'waiting', note: 'In <b>Studio</b>', ref: {}, wearable: null },
      { id: 'i3', kind: 'raffle', label: 'Raffle', state: 'todo', note: null, ref: {}, wearable: null },
      { id: 'i4', kind: 'beat', label: 'BEAT', state: 'skipped', note: null, ref: {}, wearable: null },
    ] as ShowView['items'],
    ...over,
  })
  const html = (shows: ShowView[]) => renderToStaticMarkup(createElement(ShowChecklist, { shows, onAsk: () => {} }))
  it('shows each item with its state badge and note', () => {
    const h = html([show()])
    for (const t of ['Create the event', 'Done', 'Waiting', 'To do', 'Skipped', 'Created for 3 Dec']) expect(h).toContain(t)
  })
  it('renders notes as plain text', () => {
    const h = html([show()])
    expect(h).toContain('In &lt;b&gt;Studio&lt;/b&gt;')
    expect(h).not.toContain('<b>')
  })
  it('shows the timeline and warning when set, and one Ask the assistant button', () => {
    const h = html([show({ timeline: 'Takes a few days.', warning: 'Starts soon.' })])
    expect(h).toContain('Takes a few days.')
    expect(h).toContain('Starts soon.')
    expect(h.match(/Ask the assistant/g)).toHaveLength(1)
  })
  it('renders nothing when there is no show', () => {
    expect(html([])).toBe('')
  })
})
