'use client'
import { useEffect, useState } from 'react'
import { PrimaryButton } from '@/components/ui'
import { CheckIcon, ChevronDownIcon, SparkleIcon } from '@/components/icons'
import {
  EXAMPLES, GUIDE, MOVE_KINDS, MOVE_LABELS, PLAYBACKS, PLAYBACK_LABELS, SLOT_GROUPS, guideTicks, pickOpen, readGuideFolded, slotChipLabel, toggleSlot,
  writeGuideFolded, type EmoteChoice, type HelpKind, type HelpState, type SlotChoice,
} from '@/lib/studio-prompt'

const chip = (on: boolean) =>
  `rounded-full border px-2.5 py-1 text-xs capitalize transition-colors disabled:opacity-40 ${on ? 'border-blue-400 bg-blue-500/15 text-blue-100' : 'border-gray-800 text-gray-300 hover:bg-white/[0.04]'}`

/** "What are you making?" before a wearable's first message: the slots go with it; the last two leave them to the agent. */
export function SlotChips({ choice, onChange, disabled }: { choice: SlotChoice; onChange: (c: SlotChoice) => void; disabled: boolean }) {
  const ticked = (s: string) => choice.mode === 'slots' && choice.slots.includes(s)
  return (
    <fieldset className="mb-3 min-w-0">
      <legend className="mb-1.5 text-xs text-gray-400">What are you making?</legend>
      <div className="space-y-1.5">
        {SLOT_GROUPS.map((g) => (
          <div key={g.label} className="flex flex-wrap items-center gap-1.5">
            <span className="w-10 shrink-0 text-xs text-gray-500">{g.label}</span>
            {g.slots.map((s) => (
              <button key={s} type="button" aria-pressed={ticked(s)} disabled={disabled} onClick={() => onChange(toggleSlot(choice, s))} className={chip(ticked(s))}>
                {slotChipLabel(s)}
              </button>
            ))}
          </div>
        ))}
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <button type="button" aria-pressed={choice.mode === 'outfit'} disabled={disabled} onClick={() => onChange(pickOpen(choice, 'outfit'))} className={chip(choice.mode === 'outfit')}>A full outfit</button>
          <button type="button" aria-pressed={choice.mode === 'unsure'} disabled={disabled} onClick={() => onChange(pickOpen(choice, 'unsure'))} className={chip(choice.mode === 'unsure')}>Not sure, suggest some</button>
        </div>
      </div>
    </fieldset>
  )
}

/** Before an emote's first message: the kind of move, and whether it loops. Both go into the message's words. */
export function EmoteChips({ choice, onChange, disabled }: { choice: EmoteChoice; onChange: (c: EmoteChoice) => void; disabled: boolean }) {
  return (
    <fieldset className="mb-3 min-w-0">
      <legend className="mb-1.5 text-xs text-gray-400">What kind of move?</legend>
      <div className="flex flex-wrap gap-1.5">
        {MOVE_KINDS.map((m) => (
          <button key={m} type="button" aria-pressed={choice.move === m} disabled={disabled}
            onClick={() => onChange({ ...choice, move: choice.move === m ? null : m })} className={`${chip(choice.move === m)} normal-case`}>{MOVE_LABELS[m]}</button>
        ))}
        <span className="mx-1 self-center text-gray-700" aria-hidden="true">|</span>
        {PLAYBACKS.map((p) => (
          <button key={p} type="button" aria-pressed={choice.playback === p} disabled={disabled}
            onClick={() => onChange({ ...choice, playback: choice.playback === p ? null : p })} className={`${chip(choice.playback === p)} normal-case`}>{PLAYBACK_LABELS[p]}</button>
        ))}
      </div>
    </fieldset>
  )
}

/** "What makes a good prompt": what to cover, ticked as the draft covers it, and examples that fill the box. */
export function PromptGuide({ kind, draft, slots, hasUploads, onExample }: {
  kind: HelpKind; draft: string; slots?: string[]; hasUploads: boolean; onExample: (text: string) => void
}) {
  // Open on the server render; the viewer's choice is read once the page is in the browser
  const [folded, setFolded] = useState(false)
  useEffect(() => {
    let store: Storage | null = null
    try { store = localStorage } catch { /* blocked storage */ }
    setFolded(readGuideFolded(store))
  }, [])
  const toggle = () => {
    const next = !folded
    setFolded(next)
    let store: Storage | null = null
    try { store = localStorage } catch { /* blocked storage */ }
    writeGuideFolded(store, next)
  }
  const ticks = guideTicks(kind, draft, { slots, hasUploads })
  return (
    <div className="mt-3 rounded-md border border-gray-800 bg-gray-950/60 text-sm">
      <button type="button" onClick={toggle} aria-expanded={!folded} aria-controls="studio-prompt-guide"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-gray-400 hover:text-gray-200">
        <span>What makes a good prompt</span>
        <ChevronDownIcon size={14} className={`shrink-0 transition-transform ${folded ? '' : 'rotate-180'}`} />
      </button>
      {!folded && (
        <div id="studio-prompt-guide" className="border-t border-gray-800 px-3 pb-3 pt-2">
          <ul className="space-y-1.5">
            {GUIDE[kind].map((item) => {
              const on = ticks.has(item.id)
              return (
                <li key={item.id} className="flex items-start gap-2">
                  <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${on ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300' : 'border-gray-700 text-transparent'}`}>
                    <CheckIcon size={11} />
                  </span>
                  <span className="min-w-0">
                    <span className={on ? 'text-gray-200' : 'text-gray-400'}>{item.label}</span>
                    <span className="sr-only">{on ? ' (covered)' : ''}</span>
                    <span className="block text-xs text-gray-500">{item.example}</span>
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="mb-1.5 mt-3 text-xs text-gray-500">Try one of these</p>
          <div className="flex flex-col gap-1.5">
            {EXAMPLES[kind].map((e) => (
              <button key={e} type="button" onClick={() => onExample(e)}
                className="rounded-md border border-gray-800 px-2.5 py-1.5 text-left text-xs text-gray-300 hover:bg-white/[0.04]">{e}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** The button beside Send. */
export function ImproveButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-gray-800 px-3 py-2 text-sm text-gray-300 hover:bg-white/[0.04] disabled:opacity-40">
      <SparkleIcon size={14} />
      Improve my prompt
    </button>
  )
}

/** The suggestion above the box: a warning, the rewrite to edit, quick-pick questions, then Use this or Dismiss. */
export function HelpPanel({ state, onEdit, onAnswer, onUse, onDismiss }: {
  state: HelpState; onEdit: (prompt: string) => void; onAnswer: (id: string, option: string) => void; onUse: (prompt: string) => void; onDismiss: () => void
}) {
  if (state.status === 'idle') return null
  if (state.status === 'error') {
    return (
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-amber-300" role="alert">
        <span>{state.message}</span>
        <button type="button" onClick={onDismiss} className="underline">Dismiss</button>
      </div>
    )
  }
  const shown = state.status === 'ready' ? state.help : state.previous
  const answers = state.answers
  const loading = state.status === 'loading'
  return (
    <section aria-label="Suggested prompt" aria-busy={loading} className="mb-3 rounded-lg border border-blue-500/30 bg-gray-950 p-3 text-sm">
      {loading && (
        <p className="mb-2 flex items-center gap-2 text-xs text-gray-400" aria-live="polite">
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-400" aria-hidden="true" />
          Improving your prompt…
        </p>
      )}
      {shown?.note && <p className="mb-2 text-amber-300">{shown.note}</p>}
      {state.status === 'ready' && state.help.prompt && (
        <>
          <label htmlFor="studio-prompt-suggestion" className="mb-1 block text-xs text-gray-500">Suggested prompt (you can edit it)</label>
          <textarea id="studio-prompt-suggestion" value={state.prompt} rows={4} onChange={(e) => onEdit(e.target.value)}
            className="w-full resize-y rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-white outline-none focus:border-blue-400" />
        </>
      )}
      {shown && shown.prompt && shown.questions.map((q) => (
        <fieldset key={q.id} className="mt-2 min-w-0">
          <legend className="mb-1 text-xs text-gray-400">{q.label}</legend>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((o) => (
              <button key={o} type="button" aria-pressed={answers[q.id] === o} disabled={loading} onClick={() => onAnswer(q.id, o)} className={`${chip(answers[q.id] === o)} normal-case`}>{o}</button>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {state.status === 'ready' && state.help.prompt && (
          <PrimaryButton type="button" disabled={!state.prompt.trim()} onClick={() => onUse(state.prompt)}>Use this</PrimaryButton>
        )}
        <button type="button" onClick={onDismiss} className="text-sm text-gray-400 underline hover:text-gray-200">Dismiss</button>
      </div>
    </section>
  )
}
