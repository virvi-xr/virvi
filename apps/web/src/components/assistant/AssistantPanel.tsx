'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { AssistantAccess, AssistantActionView, AssistantConversationSummary, AssistantPlanView, AssistantStreamEvent } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDialog } from '@/lib/use-dialog'
import { pageContext } from '@/lib/assistant/context'
import { planSteps as stepsOfPlan, reduce, startReply, type PanelState } from '@/lib/assistant/state'
import { streamAssistant } from '@/lib/assistant/sse'
import { ActionRow, refusalMessage } from './ActionRow'
import { PlanCard, type PlanPhase } from './PlanCard'
import { MessageLinks } from './MessageLinks'
import { approveRefused, budgetLine, isExpiredCode, lockedCopy, needsReapproval, REAPPROVE, tokenExpiresWithin } from './copy'

const EMPTY: PanelState = { messages: [], streaming: false, plan: null, budget: null, error: null }

/** The assistant's slide-over: 420px from `md` up, full screen below. Rendered once, by the dashboard layout. */
export function AssistantPanel({ access, open, onClose, onRefresh }: { access: AssistantAccess; open: boolean; onClose: () => void; onRefresh?: () => void }) {
  const api = useApi()
  const router = useRouter()
  const { token, renew } = useAuth()
  const ref = useDialog(open, onClose)
  const [state, setState] = useState<PanelState>(EMPTY)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<AssistantConversationSummary[] | null>(null)
  const [showList, setShowList] = useState(false)
  const [phase, setPhase] = useState<PlanPhase>('pending')
  const [draft, setDraft] = useState('')
  const [refusedExpired, setRefusedExpired] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const sending = useRef(false)
  const composer = useRef<HTMLTextAreaElement>(null)
  const abort = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const loadedFirst = useRef(false)
  const tokenRef = useRef(token)
  tokenRef.current = token

  const budget = state.budget ?? (access.state === 'ok' ? access.budget : null)
  const locked = access.state === 'locked'

  // An upgrade (or a spent budget) shows up without a reload
  useEffect(() => { if (open) onRefresh?.() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Open on the latest conversation the first time the panel opens
  useEffect(() => {
    if (!open || loadedFirst.current || access.state !== 'ok') return
    loadedFirst.current = true
    api.listAssistantConversations().then(async (list) => {
      setConversations(list)
      if (list[0]) await openConversation(list[0].id)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, access.state])

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.messages, state.plan, state.error, open])

  useEffect(() => () => abort.current?.abort(), [])

  const openConversation = async (id: string) => {
    abort.current?.abort()
    setShowList(false)
    setConversationId(id)
    setPhase('pending')
    setCancelError(null)
    setState((s) => ({ ...EMPTY, budget: s.budget }))
    try {
      const messages = await api.getAssistantMessages(id)
      setState((s) => ({ ...s, messages }))
    } catch (err) {
      setState((s) => ({ ...s, error: refusalMessage(err) }))
    }
  }

  const newConversation = () => {
    abort.current?.abort()
    setShowList(false)
    setConversationId(null)
    setPhase('pending')
    setCancelError(null)
    setState((s) => ({ ...EMPTY, budget: s.budget }))
  }

  const toggleList = () => {
    const next = !showList
    setShowList(next)
    if (next) api.listAssistantConversations().then(setConversations).catch(() => {})
  }

  const removeConversation = async (id: string) => {
    try {
      await api.deleteAssistantConversation(id)
      setConversations((c) => c?.filter((x) => x.id !== id) ?? c)
      if (id === conversationId) newConversation()
    } catch (err) {
      setState((s) => ({ ...s, error: refusalMessage(err) }))
    }
  }

  const announce = (sceneId: string | null) => window.dispatchEvent(new CustomEvent('virvi:assistant-changed', { detail: { sceneId } }))

  /** Runs one streaming call: renews a token about to expire, feeds events to the reducer, always ends with streaming off. */
  const run = async (url: string, body: (page: ReturnType<typeof pageContext>) => unknown, before?: () => void): Promise<{ error: string | null; ran: boolean }> => {
    const outcome = { error: null as string | null, ran: false }
    const page = pageContext(window.location.pathname, window.location.search)
    before?.()
    const controller = new AbortController()
    abort.current = controller
    setState((s) => ({ ...s, streaming: true, error: null }))
    const onEvent = (e: AssistantStreamEvent) => {
      setState((s) => reduce(s, e))
      if (e.type === 'error') outcome.error = e.code
      if (e.type === 'action' && ['running', 'done', 'failed'].includes(e.action.status)) outcome.ran = true
      if (e.type === 'action' && (e.action.status === 'done' || e.action.status === 'undone')) announce(page.sceneId ?? null)
    }
    try {
      let t = tokenRef.current
      if (!t || tokenExpiresWithin(t, 60_000)) t = (await renew()) ?? t
      if (!t) throw new Error('Sign in again to use the assistant.')
      await streamAssistant(url, body(page), t, onEvent, controller.signal)
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') { outcome.error = (err as { name?: string })?.name ?? 'error'; setState((s) => ({ ...s, error: refusalMessage(err) })) }
    } finally {
      setState((s) => ({ ...s, streaming: false }))
      // A finished reply hands the keyboard back
      setTimeout(() => composer.current?.focus(), 0)
    }
    return outcome
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || state.streaming || sending.current) return
    sending.current = true
    setDraft('')
    let id = conversationId
    if (!id) {
      try {
        id = (await api.createAssistantConversation()).id
        setConversationId(id)
      } catch (err) {
        setDraft(text)
        setState((s) => ({ ...s, error: refusalMessage(err) }))
        sending.current = false
        return
      }
    }
    await run(`/api/assistant/conversations/${encodeURIComponent(id)}/messages`, (page) => ({ text, page }), () => {
      setPhase('pending')
      setCancelError(null)
      setState((s) => ({
        ...s,
        plan: null,
        messages: [...s.messages, { id: `local-user-${Date.now()}`, role: 'user', text, actions: [], links: [], createdAt: new Date().toISOString() }],
      }))
    })
    sending.current = false
    api.listAssistantConversations().then(setConversations).catch(() => {})
  }

  const stop = () => abort.current?.abort()

  const approve = async (plan: AssistantPlanView) => {
    setRefusedExpired(false)
    setCancelError(null)
    // The results reply starts its own message, after the one that proposed the plan
    const r = await run(`/api/assistant/plans/${encodeURIComponent(plan.planId)}/approve`, (page) => ({ token: plan.token, page }), () => {
      setPhase('approved')
      setState(startReply)
    })
    if (approveRefused(r)) {
      setRefusedExpired(isExpiredCode(r.error))
      setPhase('refused')
    }
  }

  const cancelPlan = async (plan: AssistantPlanView) => {
    setCancelError(null)
    try {
      await api.cancelAssistantPlan(plan.planId)
      setPhase('cancelled')
    } catch (err) {
      // Shown on the plan card, next to the button that failed
      setCancelError(refusalMessage(err))
    }
  }

  /** Swaps in newer copies of actions (after an undo) wherever they are shown. */
  const applyActions = (views: AssistantActionView[]) => {
    const by = new Map(views.map((v) => [v.id, v]))
    setState((s) => ({ ...s, messages: s.messages.map((m) => ({ ...m, actions: m.actions.map((a) => by.get(a.id) ?? a) })) }))
    if (views.length) announce(pageContext(window.location.pathname, window.location.search).sceneId ?? null)
  }

  const undoOne = async (id: string) => {
    applyActions([await api.undoAssistantAction(id)])
  }

  const undoPlan = async (plan: AssistantPlanView) => {
    try {
      applyActions(await api.undoAssistantPlan(plan.planId))
    } catch (err) {
      const undone = (err as { body?: { undone?: AssistantActionView[] } })?.body?.undone
      if (Array.isArray(undone)) applyActions(undone)
      throw err
    }
  }

  const go = (href: string) => {
    if (window.innerWidth < 768) onClose()
    router.push(href)
  }

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
  }

  if (!open || access.state === 'hidden') return null

  const planId = state.plan?.planId ?? null
  const planSteps = stepsOfPlan(state)
  const line = budgetLine(budget)
  const locks = access.state === 'locked' ? lockedCopy(access.reason) : null

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Assistant" data-assistant-panel
      className="fixed inset-0 z-50 flex flex-col border-gray-800 bg-gray-950 shadow-2xl md:left-auto md:w-[420px] md:border-l">
      <header className="border-b border-gray-800 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-100">Assistant</h2>
          <div className="flex items-center gap-1">
            {!locked && (
              <button type="button" onClick={toggleList} aria-expanded={showList} className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-white/[0.05] hover:text-white">Conversations</button>
            )}
            <button type="button" onClick={onClose} className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-white/[0.05] hover:text-white">Close</button>
          </div>
        </div>
        {!locked && line && (
          <p className="mt-1 text-xs text-gray-500">
            {line.text}{line.upgrade && <> <Link href="/settings" onClick={() => window.innerWidth < 768 && onClose()} className="text-blue-400 underline hover:text-blue-300">Upgrade</Link></>}
          </p>
        )}
      </header>

      {locks ? (
        <div className="p-4 text-sm text-gray-300">
          <p>{locks.text}</p>
          {locks.link && <Link href={locks.link.href} onClick={() => window.innerWidth < 768 && onClose()} className="mt-2 inline-block text-blue-400 underline hover:text-blue-300">{locks.link.label}</Link>}
        </div>
      ) : showList ? (
        <div className="flex-1 overflow-y-auto p-3">
          <button type="button" onClick={newConversation} className="mb-3 w-full rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:text-white">New conversation</button>
          {conversations === null ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : conversations.length === 0 ? (
            <p className="text-sm text-gray-500">No conversations yet.</p>
          ) : (
            <ul className="space-y-1">
              {conversations.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-white/[0.04]">
                  <button type="button" onClick={() => openConversation(c.id)} className={`min-w-0 flex-1 truncate text-left text-sm ${c.id === conversationId ? 'text-white' : 'text-gray-300'}`}>{c.title || 'New conversation'}</button>
                  <button type="button" onClick={() => removeConversation(c.id)} className="shrink-0 text-xs text-gray-500 hover:text-red-300" aria-label={`Delete ${c.title || 'conversation'}`}>Delete</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
            {state.messages.length === 0 && !state.plan && (
              <p className="text-sm text-gray-500">Ask about your scenes, events and giveaways, or ask me to change something.</p>
            )}
            {state.messages.map((m) => {
              const actions = planId ? m.actions.filter((a) => a.planId !== planId) : m.actions
              return (
                <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
                  <div className={m.role === 'user' ? 'max-w-[85%] rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-100' : 'w-full space-y-2'}>
                    {m.text && <p className={`whitespace-pre-wrap break-words text-sm ${m.role === 'user' ? '' : 'text-gray-200'}`}>{m.text}</p>}
                    {actions.length > 0 && <ul className="space-y-1.5">{actions.map((a) => <ActionRow key={a.id} action={a} onUndo={undoOne} />)}</ul>}
                    {needsReapproval(actions) && <p className="text-xs text-gray-400">{REAPPROVE}</p>}
                    <MessageLinks links={m.links} onOpen={go} />
                  </div>
                </div>
              )
            })}
            {state.streaming && <p className="text-xs text-gray-500" role="status">Working…</p>}
            {state.plan && (
              <PlanCard plan={state.plan} steps={planSteps} phase={phase} expired={refusedExpired} busy={state.streaming} error={cancelError ?? (phase === 'refused' && !refusedExpired ? state.error : null)}
                onApprove={() => approve(state.plan!)} onCancel={() => cancelPlan(state.plan!)} onUndoStep={undoOne} onUndoAll={() => undoPlan(state.plan!)} />
            )}
            {state.error && !(phase === 'refused' && state.plan) && <p className="text-sm text-red-300" role="alert">{state.error}</p>}
          </div>
          <div className="border-t border-gray-800 p-3">
            <textarea ref={composer} data-autofocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onComposerKey} disabled={state.streaming} rows={2}
              aria-label="Message the assistant" placeholder="Ask or tell me what to change…"
              className="w-full resize-none rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:border-gray-500 focus:outline-none disabled:opacity-60" />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-gray-500">Enter to send, Shift+Enter for a new line</span>
              {state.streaming ? (
                <button type="button" onClick={stop} className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:text-white">Stop</button>
              ) : (
                <button type="button" onClick={send} disabled={!draft.trim()} className="clip-corner bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50">Send</button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
