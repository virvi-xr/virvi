import type { AssistantActionView, AssistantBudget, AssistantMessageView, AssistantPlanView, AssistantStreamEvent } from '@virvixr/shared'

export type PanelState = {
  messages: AssistantMessageView[]
  streaming: boolean
  plan: AssistantPlanView | null
  budget: AssistantBudget | null
  error: string | null
}

/** Dashboard pages a link may open. Same list and logic as the server's `isDashboardPath` (apps/server/src/assistant/tools/local.ts); keep them in step. */
const PAGES = ['scenes', 'events', 'analytics', 'deploy', 'media', 'streaming', 'giveaways', 'beats', 'studio', 'settings', 'publish', 'assets', 'import', 'command-center']
const PAGE_RE = new RegExp(`^/(${PAGES.join('|')})(/[^\\s?#\\\\]*)?(\\?[\\w=&%-]*)?$`)

/** A dashboard path, with no `.`/`..` segment (plain or percent-encoded) that a browser would resolve elsewhere. */
export function safeHref(href: string): boolean {
  if (!PAGE_RE.test(href)) return false
  return !href.split('?')[0].split('/').some((seg) => {
    const s = seg.toLowerCase().replaceAll('%2e', '.')
    return s === '.' || s === '..'
  })
}

const blankAssistant = (): AssistantMessageView => ({ id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: 'assistant', text: '', actions: [], links: [], createdAt: new Date().toISOString() })

/** A fresh, empty assistant message at the end: what streams next lands there, not in the message before it. */
export function startReply(state: PanelState): PanelState {
  return { ...state, messages: [...state.messages, blankAssistant()] }
}

/** The last message when it is the assistant's, else a new one; `update` returns it changed. */
function withAssistant(state: PanelState, update: (m: AssistantMessageView) => AssistantMessageView): PanelState {
  const last = state.messages[state.messages.length - 1]
  if (last?.role === 'assistant') return { ...state, messages: [...state.messages.slice(0, -1), update(last)] }
  return { ...state, messages: [...state.messages, update(blankAssistant())] }
}

function upsert(actions: AssistantActionView[], a: AssistantActionView): AssistantActionView[] {
  return actions.some((x) => x.id === a.id) ? actions.map((x) => (x.id === a.id ? a : x)) : [...actions, a]
}

export function reduce(state: PanelState, e: AssistantStreamEvent): PanelState {
  switch (e.type) {
    case 'text':
      return withAssistant(state, (m) => ({ ...m, text: m.text + e.delta }))
    case 'action':
      return withAssistant(state, (m) => ({ ...m, actions: upsert(m.actions, e.action) }))
    case 'plan':
      return { ...state, plan: e.plan }
    case 'link':
      return safeHref(e.href) ? withAssistant(state, (m) => ({ ...m, links: [...m.links, { label: e.label, href: e.href }] })) : state
    case 'budget':
      return { ...state, budget: e.budget }
    case 'error':
      return { ...state, error: e.message }
    case 'done':
      return { ...state, streaming: false }
  }
}
