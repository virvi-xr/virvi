'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { PrimaryButton } from '@/components/ui'
import {
  agentLabel, canSend, categoryLabel, composerState, formatCents, initialTicks, progressFor, refusalMessage, slotSelection,
  type Refusal, type StudioDetail, type StudioEvent, type StudioMessage, type StudioProposal, type StudioUsage,
} from '@/lib/studio'
import { AgentPicker } from '../AgentPicker'
import Markdown from './Markdown'
import Uploads from './Uploads'

const MAX_PROMPT = 4000

type Props = { designId: string; detail: StudioDetail; usage: StudioUsage | null; events: StudioEvent[]; onChanged: () => Promise<void> }

/** The left column: the agent picker, the conversation, and the message box. */
export default function Conversation({ designId, detail, usage, events, onChanged }: Props) {
  const api = useApi()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dropped, setDropped] = useState<File[] | null>(null)
  const [dragging, setDragging] = useState(false)

  const composer = composerState(detail, usage, new Date())
  const active = detail.activeJob?.type === 'prompt' ? detail.activeJob : null
  const failing = detail.pieces.filter((p) => p.revision?.checker?.pass === false)
  const lastMessage = detail.messages[detail.messages.length - 1]
  const openProposal = lastMessage?.role === 'agent' && lastMessage.proposal?.slots?.length && !active ? lastMessage : null

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [detail.messages.length, !!active])

  const send = async (body: Parameters<typeof api.sendStudioPrompt>[1]) => {
    setSending(true)
    setRefusal(null)
    try {
      await api.sendStudioPrompt(designId, body)
      if (body.text) setText('')
      await onChanged()
    } catch (err) {
      setRefusal(refusalMessage(err as never, new Date()))
      // A refusal (busy from another tab, a timeout after the server queued it) may mean the design moved on
      onChanged().catch(() => {})
    } finally {
      setSending(false)
    }
  }

  const submit = () => {
    const t = text.trim()
    if (!t || t.length > MAX_PROMPT || !canSend(composer.mode) || sending) return
    send({ text: t })
  }

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
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-800 p-3">
        <AgentPicker name="design-agent" value={detail.design.agent} onChange={switchAgent} disabled={!!active || sending} />
      </div>

      <div ref={listRef} className="flex max-h-[60vh] min-h-64 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {detail.messages.length === 0 && !active && (
          <p className="m-auto max-w-sm text-center text-sm text-gray-500">
            {detail.design.kind === 'emote'
              ? 'Describe the emote: the move, its mood, any props or sounds.'
              : 'Describe the wearable or the set: what it is, its look, the slots it fills.'}
          </p>
        )}
        {detail.messages.map((m) => (
          <Message key={m.id} m={m}>
            {m === openProposal && m.proposal && (
              <ProposalPicker proposal={m.proposal} disabled={sending || composer.mode === 'out' || composer.mode === 'paused'}
                onBuild={(slots) => send({ text: `Build these: ${slots.map(categoryLabel).join(', ')}`, selectedSlots: slots })} />
            )}
          </Message>
        ))}
        {/* What the agent is doing, not a reply: no bubble, a dashed rule and muted italics, so it can't pass for its answer */}
        {active && (
          <div className="max-w-[85%] self-start border-l-2 border-dashed border-gray-700 py-1 pl-3 text-sm" aria-live="polite">
            <p className="mb-1 flex items-center gap-2 text-xs text-gray-500">
              <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-400" aria-hidden="true" />
              {agentLabel(detail.design.agent)} is working
            </p>
            <div className="italic text-gray-400">
              <Markdown text={progressFor(events, active.id) ?? (active.status === 'queued' ? 'Starting the studio…' : 'Working…')} />
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-gray-800 p-3">
        <Uploads designId={designId} kind={detail.design.kind} uploads={detail.uploads ?? []} disabled={composer.mode === 'archived' || composer.mode === 'paused'} dropped={dropped} onChanged={onChanged} />
        {refusal && <RefusalLine refusal={refusal} usage={usage} onFix={() => send({ fixChecks: true })} />}
        {failing.length > 0 && !active && (
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
        {composer.mode === 'out' || composer.mode === 'archived' || composer.mode === 'paused' ? (
          <div className="text-sm text-gray-400">
            <p>{composer.note}</p>
            {composer.mode === 'out' && usage && <TopupButton usage={usage} onRefusal={setRefusal} />}
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); submit() }}>
            <label htmlFor="studio-prompt" className="sr-only">Message the agent</label>
            <textarea id="studio-prompt" value={text} rows={3} maxLength={MAX_PROMPT}
              disabled={composer.mode === 'busy'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
              placeholder={composer.mode === 'busy' ? 'The agent is still working on your last message.' : 'Describe what you want, or what to change'}
              className="w-full resize-y rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400 disabled:opacity-60" />
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-500">{composer.note}</p>
              <PrimaryButton type="submit" disabled={!canSend(composer.mode) || sending || !text.trim()}>Send</PrimaryButton>
            </div>
          </form>
        )}
      </div>
    </section>
  )
}

function Message({ m, children }: { m: StudioMessage; children?: React.ReactNode }) {
  if (m.role === 'system') return <p className="self-center px-4 text-center text-xs text-gray-500">{m.text}</p>
  const mine = m.role === 'user'
  return (
    <div className={`max-w-[85%] break-words rounded-lg px-3 py-2 text-sm ${mine ? 'self-end whitespace-pre-wrap bg-blue-600/20 text-blue-50' : 'self-start border border-gray-800 bg-gray-950 text-gray-200'}`}>
      {!mine && <p className="mb-1 text-xs text-gray-500">{agentLabel(m.agent)}</p>}
      {mine ? m.text : <Markdown text={m.text} />}
      {children}
    </div>
  )
}

function ProposalPicker({ proposal, disabled, onBuild }: { proposal: StudioProposal; disabled: boolean; onBuild: (slots: string[]) => void }) {
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
            {s.reason && <span className="block text-xs text-gray-500">{s.reason}</span>}
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
    setBusy(true)
    try {
      const { url } = await api.buyStudioPrompts(1)
      window.location.assign(url)
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
