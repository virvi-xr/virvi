'use client'
import { useEffect, useReducer, useRef, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { openSignUp } from '@/lib/trial'
import { PrimaryButton } from '@/components/ui'
import {
  agentLabel, canSend, takeUnsent, categoryLabel, checkoutHref, composerState, formatCents, latestRenderUrl, trialCtx, trialNudge, initialTicks, progressFor, refusalMessage, slotSelection,
  type Quote, type Refusal, type StudioDetail, type StudioEvent, type StudioMessage, type StudioProposal, type StudioUsage,
} from '@/lib/studio'
import { canRate, canTryAgain, revisionUnder } from '@/lib/studio-ratings'
import Rating from './Rating'
import { designControls, messageIsViewers, messageLabel, runningPrompt } from '@/lib/studio-support'
import { boxState } from '@/lib/studio-people'
import { customerReply } from '@/lib/studio-reply'
import {
  HELP_IDLE, MAX_PROMPT, NO_CHOICE, canImprove, choiceSlots, helpFailure, helpReducer, helpsWith, outgoingMessage, reaskBody, tooLong,
  type EmoteChoice, type SlotChoice,
} from '@/lib/studio-prompt'
import { IDEA_NONE, ideaIdToSend, ideaReducer } from '@/lib/studio-ideas'
import { EmoteChips, HelpPanel, ImproveButton, PromptGuide, SlotChips } from './PromptHelper'
import { AgentPicker } from '../AgentPicker'
import Markdown from './Markdown'
import Uploads from './Uploads'
import WaitSteps from './WaitSteps'
import { createWarmer, waitSteps } from '@/lib/studio-wait'


type Props = {
  designId: string; detail: StudioDetail; usage: StudioUsage | null; events: StudioEvent[]; onChanged: () => Promise<void>
  /** For a 👍's "Finalize this": the quote, and opening Finalize with these pieces ticked. */
  quote?: Quote | null; onFinalize?: (categories: string[]) => void
}

/** The left column: the agent picker, the conversation, and the message box. */
export default function Conversation({ designId, detail, usage, events, onChanged, quote = null, onFinalize }: Props) {
  const api = useApi()
  const meId = useAuth().user?.id ?? null
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dropped, setDropped] = useState<File[] | null>(null)
  const [dragging, setDragging] = useState(false)
  // Helping with the first prompt: what it is (slots, or the kind of move), and "Improve my prompt"
  const [slotChoice, setSlotChoice] = useState<SlotChoice>(NO_CHOICE)
  const [emoteChoice, setEmoteChoice] = useState<EmoteChoice>({ move: null, playback: null })
  const [help, dispatchHelp] = useReducer(helpReducer, HELP_IDLE)
  const [helpOff, setHelpOff] = useState(false)
  // The example idea the box's words came from (edits keep it), sent with the first message so it is retired
  const [idea, dispatchIdea] = useReducer(ideaReducer, IDEA_NONE)
  // The box holds a suggestion made with the chips' sentence, so Send doesn't add it again (changing a chip does)
  const [chipsInWords, setChipsInWords] = useState(false)
  const chooseSlots = (c: SlotChoice) => { setSlotChoice(c); setChipsInWords(false); warm() }
  const chooseEmote = (c: EmoteChoice) => { setEmoteChoice(c); setChipsInWords(false); warm() }
  // Starting the machine once the person starts on a prompt (typing, a chip, a file), not on opening the page
  const apiRef = useRef(api)
  apiRef.current = api
  const [warmer] = useState(() => createWarmer((id) => apiRef.current.warmStudioDesign(id)))

  // From /try/studio: the design was made but its first prompt was refused; offer it again here (read once, then gone)
  useEffect(() => {
    let store: Storage | null = null
    try { store = sessionStorage } catch { /* blocked storage */ }
    const unsent = takeUnsent(store, designId)
    if (!unsent) return
    setText(unsent.text)
    if (unsent.refusal) setRefusal({ text: unsent.refusal })
  }, [designId])

  const composer = composerState(detail, usage, new Date())
  const controls = designControls(detail)
  // Support's own allowance is no business of this design's
  const nudge = detail.support ? null : trialNudge(usage)
  const active = detail.activeJob?.type === 'prompt' ? detail.activeJob : null
  // While a prompt runs, whose it is ("Working on Sam's prompt"); a viewer has no box (LIV-159)
  const box = boxState(detail.role, runningPrompt(detail, meId), meId)
  const busyLine = composer.mode === 'busy' && typeof box === 'object' ? box.busyFor : null
  const note = busyLine ?? composer.note
  function warm() { if (canSend(composer.mode) && !active) warmer(designId) }
  // Until the agent's first progress line: the steps, timed from when the prompt was sent (or first seen here)
  const steps = active ? waitSteps(active, events) : null
  const seen = useRef<{ id: string; at: number } | null>(null)
  if (active && seen.current?.id !== active.id) seen.current = { id: active.id, at: Date.now() }
  const waitSince = (active?.createdAt && Date.parse(active.createdAt)) || (seen.current?.at ?? Date.now())
  const failing = detail.pieces.filter((p) => p.revision?.checker?.pass === false)
  const lastMessage = detail.messages[detail.messages.length - 1]
  const openProposal = lastMessage?.role === 'agent' && lastMessage.proposal?.slots?.length && !active ? lastMessage : null
  const kind = detail.design.kind
  // Before the first message of a wearable or an emote: the chips and the guide
  const firstPrompt = detail.messages.length === 0 && !active && helpsWith(kind)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [detail.messages.length, !!active])

  const send = async (body: Parameters<typeof api.sendStudioPrompt>[1]) => {
    setSending(true)
    setRefusal(null)
    try {
      await api.sendStudioPrompt(designId, body)
      if (body.text) {
        setText('')
        dispatchIdea({ type: 'replaced' })
      }
      await onChanged()
    } catch (err) {
      setRefusal(refusalMessage(err as never, new Date()))
      // A refusal (busy from another tab, a timeout after the server queued it) may mean the design moved on
      onChanged().catch(() => {})
    } finally {
      setSending(false)
    }
  }

  /** The message the box sends (and Improve my prompt rewrites): the first one carries what the chips say. */
  const outgoing = (t: string) => outgoingMessage(t, firstPrompt && helpsWith(kind) ? { kind, slots: slotChoice, emote: emoteChoice, inWords: chipsInWords } : null)

  const submit = () => {
    const t = text.trim()
    if (!t || !canSend(composer.mode) || sending) return
    const body = outgoing(t)
    const long = tooLong(body)
    if (long) {
      setRefusal({ text: long })
      return
    }
    dispatchHelp({ type: 'dismiss' })
    const ideaId = ideaIdToSend(idea, firstPrompt)
    send(ideaId ? { ...body, ideaId } : body)
  }

  /** With no body: the draft as it would be sent. A question's option re-asks with the suggestion as edited. */
  const askHelp = async (body?: { text: string; selectedSlots?: string[]; answers?: Record<string, string> }) => {
    const ask: { text: string; selectedSlots?: string[]; answers?: Record<string, string> } = body ?? outgoing(text.trim())
    if (!ask.text.trim()) return
    dispatchHelp({ type: 'ask', answers: body?.answers })
    try {
      const { answers, ...rest } = ask
      const r = await api.studioPromptHelp(designId, { ...rest, text: rest.text.slice(0, MAX_PROMPT), ...(answers && Object.keys(answers).length ? { answers } : {}) })
      dispatchHelp({ type: 'answered', help: r })
    } catch (err) {
      const f = helpFailure(err as never)
      if (f.unavailable) {
        setHelpOff(true)
        dispatchHelp({ type: 'dismiss' })
      } else dispatchHelp({ type: 'failed', message: f.message })
    }
  }
  const canHelp = helpsWith(kind) && !helpOff

  const switchAgent = async (agent: string) => {
    setRefusal(null)
    try {
      await api.updateStudioDesign(designId, { agent })
      await onChanged()
    } catch (err) {
      setRefusal(refusalMessage(err as never, new Date()))
    }
  }

  return (
    <section aria-label="Conversation"
      className={`flex min-w-0 flex-col rounded-lg border bg-gray-900 ${dragging ? 'border-blue-400' : 'border-gray-800'}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDropped([...e.dataTransfer.files]) } setDragging(false) }}>
      {/* Switching the agent is the owner's; support sees which it is, other members don't get the picker */}
      {(controls.switchAgent || detail.support) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-800 p-3">
          <AgentPicker name="design-agent" value={detail.design.agent} onChange={switchAgent} disabled={!!active || sending || !controls.switchAgent} />
        </div>
      )}

      <div ref={listRef} className="flex max-h-[60vh] min-h-64 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {detail.messages.length === 0 && !active && (
          <p className="m-auto max-w-sm text-center text-sm text-gray-500">
            {detail.design.kind === 'emote'
              ? 'Describe the emote: the move, its mood, any props or sounds.'
              : 'Describe the wearable or the set: what it is, its look, the slots it fills.'}
          </p>
        )}
        {detail.messages.map((m) => {
          const rev = revisionUnder(m, detail)
          return (
            <Message key={m.id} m={m} label={messageLabel(m, detail, meId)} viewers={messageIsViewers(m, detail, meId)} raw={!!detail.support}>
              {m === openProposal && m.proposal && controls.act && (
                <ProposalPicker proposal={m.proposal} raw={!!detail.support} disabled={sending || composer.mode === 'out' || composer.mode === 'paused'}
                  onBuild={(slots) => send({ text: `Build these: ${slots.map(categoryLabel).join(', ')}`, selectedSlots: slots })} />
              )}
              {rev && (
                <Rating designId={designId} rev={rev} canRate={canRate(detail)} quote={quote} canPrompt={canTryAgain(composer.mode, !!active || sending)} busy={!!active}
                  onChanged={onChanged} onFinalize={(c) => onFinalize?.(c)} onKeepGoing={() => document.getElementById('studio-prompt')?.focus()} />
              )}
            </Message>
          )
        })}
        {/* What the agent is doing, not a reply: no bubble, a dashed rule and muted italics, so it can't pass for its answer */}
        {active && (
          <div className="max-w-[85%] self-start border-l-2 border-dashed border-gray-700 py-1 pl-3 text-sm" aria-live="polite">
            <p className="mb-1 flex items-center gap-2 text-xs text-gray-500">
              <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-400" aria-hidden="true" />
              {agentLabel(detail.design.agent)} is working
            </p>
            <div className="italic text-gray-400">
              {steps ? <WaitSteps steps={steps} since={waitSince} typicalSec={detail.typicalFirstReplySec} />
                : <Markdown text={progressFor(events, active.id) ?? (active.status === 'queued' ? 'Starting the studio…' : 'Working…')} />}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-gray-800 p-3">
        <Uploads designId={designId} kind={detail.design.kind} uploads={detail.uploads ?? []} disabled={composer.mode === 'archived' || composer.mode === 'paused'} dropped={dropped} onChanged={onChanged} readOnly={!controls.uploads} onAttach={warm} />
        {refusal && <RefusalLine refusal={refusal} usage={controls.topup ? usage : null} onFix={() => send({ fixChecks: true })} />}
        {failing.length > 0 && !active && controls.act && (
          <button type="button" disabled={sending} onClick={() => send({ fixChecks: true })}
            className="mb-2 rounded-md border border-amber-500/40 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-500/10 disabled:opacity-50">
            Fix the checker failures (free)
          </button>
        )}
        {composer.mode === 'continue' && (
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm text-gray-400">
            <span>The agent paused before finishing. Continuing doesn’t use a prompt.</span>
            <PrimaryButton type="button" disabled={sending} onClick={() => send({ continue: true })}>Continue</PrimaryButton>
          </div>
        )}
        {composer.mode === 'out' && usage?.trial ? (
          <OutOfPrompts detail={detail} />
        ) : composer.mode === 'out' || composer.mode === 'archived' || composer.mode === 'paused' || composer.mode === 'viewer' ? (
          <div className="text-sm text-gray-400">
            <p>{composer.note}</p>
            {composer.mode === 'out' && usage && controls.topup && <TopupButton usage={usage} onRefusal={setRefusal} />}
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); submit() }}>
            {firstPrompt && kind === 'wearable' && <SlotChips choice={slotChoice} onChange={chooseSlots} disabled={sending} />}
            {firstPrompt && kind === 'emote' && <EmoteChips choice={emoteChoice} onChange={chooseEmote} disabled={sending} />}
            {canHelp && (
              <HelpPanel state={help} onEdit={(prompt) => dispatchHelp({ type: 'edit', prompt })}
                onAnswer={(id, option) => { if (help.status === 'ready') askHelp(reaskBody(help, id, option, outgoing(text.trim()).selectedSlots)) }}
                onUse={(prompt) => { setText(prompt.slice(0, MAX_PROMPT)); dispatchIdea({ type: 'replaced' }); setChipsInWords(firstPrompt); dispatchHelp({ type: 'dismiss' }); document.getElementById('studio-prompt')?.focus() }}
                onDismiss={() => dispatchHelp({ type: 'dismiss' })} />
            )}
            <label htmlFor="studio-prompt" className="sr-only">Message the agent</label>
            <textarea id="studio-prompt" value={text} rows={3} maxLength={MAX_PROMPT}
              disabled={composer.mode === 'busy'}
              onChange={(e) => { setText(e.target.value); dispatchIdea({ type: 'typed', text: e.target.value }); warm() }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
              placeholder={busyLine ?? (detail.support ? 'Message the agent as Virvi support' : 'Describe what you want, or what to change')}
              className="w-full resize-y rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400 disabled:opacity-60" />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-gray-500">
                <p>{note}</p>
                {nudge && <p className="mt-0.5 text-amber-300">{nudge}</p>}
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {canHelp && <ImproveButton disabled={!canImprove(text, canSend(composer.mode) && !sending, help)} onClick={() => askHelp()} />}
                <PrimaryButton type="submit" disabled={!canSend(composer.mode) || sending || !text.trim()}>Send</PrimaryButton>
              </div>
            </div>
            {firstPrompt && helpsWith(kind) && (
              <PromptGuide designId={designId} kind={kind} chips={kind === 'wearable' ? { kind, slots: slotChoice } : { kind, emote: emoteChoice }}
                draft={text} slots={kind === 'wearable' ? choiceSlots(slotChoice) : undefined} hasUploads={(detail.uploads ?? []).length > 0}
                onExample={(i) => { setText(i.text); dispatchIdea({ type: 'tapped', idea: i }); warm(); document.getElementById('studio-prompt')?.focus() }} />
            )}
          </form>
        )}
      </div>
    </section>
  )
}

/**
 * `label`: who said it, when it is said (messageLabel); `viewers`: on the right, as the viewer's own words; `raw`: the
 * agent's reply as written (Virvi support), not in the customer's terms (customerReply).
 */
function Message({ m, label, viewers, raw, children }: { m: StudioMessage; label: string | null; viewers: boolean; raw: boolean; children?: React.ReactNode }) {
  if (m.role === 'system') {
    return (
      <div className="self-center px-4 text-center text-xs text-gray-500">
        <p>{m.text}</p>
        {children}
      </div>
    )
  }
  const words = m.role === 'user'
  const tone = m.support ? 'bg-emerald-600/15 text-emerald-50 border border-emerald-500/30' : words ? 'bg-blue-600/20 text-blue-50' : 'border border-gray-800 bg-gray-950 text-gray-200'
  return (
    <div className={`max-w-[85%] break-words rounded-lg px-3 py-2 text-sm ${viewers ? 'self-end' : 'self-start'} ${words ? 'whitespace-pre-wrap' : ''} ${tone}`}>
      {label && <p className={`mb-1 text-xs ${m.support ? 'font-medium text-emerald-300' : 'text-gray-500'}`}>{label}</p>}
      {words ? m.text : <Markdown text={raw ? m.text : customerReply(m.text)} />}
      {children}
    </div>
  )
}

function ProposalPicker({ proposal, raw, disabled, onBuild }: { proposal: StudioProposal; raw: boolean; disabled: boolean; onBuild: (slots: string[]) => void }) {
  const [ticked, setTicked] = useState(() => initialTicks(proposal))
  const sel = slotSelection(proposal, ticked)
  const toggle = (c: string) => setTicked((prev) => {
    const next = new Set(prev)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    return next
  })
  return (
    <fieldset className="mt-3 space-y-1.5">
      <legend className="mb-1 text-xs text-gray-500">Which pieces should the agent build?</legend>
      {proposal.slots.map((s) => (
        <label key={s.category} className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={ticked.has(s.category)} onChange={() => toggle(s.category)} />
          <span>
            <span className="capitalize">{categoryLabel(s.category)}</span>
            {s.recommended && <span className="ml-2 text-xs text-emerald-300">recommended</span>}
            {s.reason && <span className="block text-xs text-gray-500">{raw ? s.reason : customerReply(s.reason)}</span>}
          </span>
        </label>
      ))}
      <PrimaryButton type="button" className="mt-2" disabled={disabled || !sel.canBuild} onClick={() => onBuild(sel.slots)}>Build these</PrimaryButton>
    </fieldset>
  )
}

function RefusalLine({ refusal, usage, onFix }: { refusal: Refusal; usage: StudioUsage | null; onFix: () => void }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-amber-300" role="alert">
      <span>{refusal.text}</span>
      {refusal.action === 'settings' && <Link href="/settings" className="underline">Settings</Link>}
      {refusal.action === 'fix' && <button type="button" onClick={onFix} className="underline">Fix it</button>}
      {refusal.action === 'topup' && usage && <TopupButton usage={usage} />}
    </div>
  )
}

function TopupButton({ usage, onRefusal }: { usage: StudioUsage; onRefusal?: (r: Refusal) => void }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const buy = async () => {
    // With MANA on, the checkout page offers card and MANA side by side
    if (usage.mana) {
      window.location.assign(checkoutHref({ kind: 'topup', packs: 1 }))
      return
    }
    setBusy(true)
    try {
      const r = await api.buyStudioPrompts(1, 'card')
      // Credit that covers the pack in full is spent at once: there is no Stripe page to go to
      if ('url' in r) window.location.assign(r.url)
      else window.location.reload()
    } catch (err) {
      onRefusal?.(refusalMessage(err as never, new Date()))
      setBusy(false)
    }
  }
  return (
    <PrimaryButton type="button" className="mt-2" disabled={busy} onClick={buy}>
      Buy {usage.topup.prompts} prompts for {formatCents(usage.topup.cents)}
    </PrimaryButton>
  )
}

/** A trial with no free prompts left: the design stays, and an account keeps it going. */
function OutOfPrompts({ detail }: { detail: StudioDetail }) {
  const image = latestRenderUrl(detail)
  const signUp = () => { openSignUp({ action: 'more_prompts', ctx: trialCtx(detail) }).catch(() => {}) }
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-4 text-sm">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {image && <img src={image} alt={`${detail.design.name}, latest render`} className="mb-3 max-h-48 w-full rounded-md bg-gray-900 object-contain" />}
      <p className="text-gray-200">Create a free account to keep designing. You'll get your daily prompts (3 a day on Free), and everything you made stays here.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <PrimaryButton type="button" onClick={signUp}>Create account</PrimaryButton>
        <a href="/#features" className="text-blue-300 underline">See plans</a>
      </div>
    </div>
  )
}
