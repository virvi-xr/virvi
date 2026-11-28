'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { selectorOptions } from '@virvixr/shared'
import { ACTIONS_PER_RULE, CLICKABLE, ITEM_WHEN, SELECTOR, SLIDER, describeRule, volumeTargets, brightnessTargets, localTimeZone, ruleTargets, timeZones, triggerFor, whenChoices, type DraftWhen, type RuleAction, type SceneRule } from '@/lib/scene-rules'

interface El { id: string; name: string; type: string; properties?: any }
interface Preset { id: string; name: string }

const SELECT = 'rounded border border-gray-800 bg-gray-950 px-2 py-1.5 text-sm text-white outline-none focus:border-blue-400'

type Draft = { name: string; widgetId: string; when: DraftWhen; timezone: string; actions: RuleAction[] }

/** Scene rules (LIV-196): "when this widget does this, do that", for the preset being edited. */
export function SceneRules({ presetId, elements, presets }: { presetId: string; elements: El[]; presets: Preset[] }) {
  const api = useApi()
  const [rules, setRules] = useState<SceneRule[] | null>(null)
  const [limit, setLimit] = useState(50)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const widgets = elements.filter((e) => e.type === 'widget' && Number(e.properties?.controlType ?? 0) !== 0)
  const clickables = elements.filter((e) => CLICKABLE.has(e.type))
  const targets = ruleTargets(elements)
  const loud = volumeTargets(elements)
  const bright = brightnessTargets(elements)
  const poolFor = (type: RuleAction['type']) => (type === 'volume' ? loud : type === 'brightness' ? bright : targets)
  const isItem = (id: string) => clickables.some((c) => c.id === id)
  const choicesFor = (id: string) => (isItem(id) ? ITEM_WHEN : whenChoices(widgetType(id)))

  const load = async () => {
    try { const r = await api.getPresetRules(presetId); setRules(r.rules); setLimit(r.limit); setError(null) } catch (e: any) { setError(e?.message ?? 'Could not load the rules') }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDraft(null); load() }, [presetId])

  const widgetType = (id: string) => Number(widgets.find((w) => w.id === id)?.properties?.controlType ?? 0)
  const start = () => {
    const w = widgets[0] ?? clickables[0]
    if (!w) return
    setDraft({ name: '', widgetId: w.id, when: choicesFor(w.id)[0].value, timezone: localTimeZone(), actions: [targets[0] ? { type: 'show', elementId: targets[0].id } : { type: 'preset', presetId: presets[0]?.id ?? '' }] })
  }
  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await api.createRule(presetId, { name: draft.name.trim(), trigger: triggerFor(draft.widgetId, draft.when, draft.timezone), actions: draft.actions })
      setDraft(null)
      await load()
    } catch (e: any) { setError(e?.message ?? 'Could not save the rule') } finally { setBusy(false) }
  }
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn(); await load() } catch (e: any) { setError(e?.message ?? 'Could not save') } finally { setBusy(false) }
  }
  // A volume action takes the slider's value: only offered for a Slider's change
  const fromSlider = !!draft && !isItem(draft.widgetId) && widgetType(draft.widgetId) === SLIDER
  const fromSelector = !!draft && !isItem(draft.widgetId) && widgetType(draft.widgetId) === SELECTOR
  const selectorOpts = draft && fromSelector ? selectorOptions(widgets.find((w) => w.id === draft.widgetId)?.properties) : []
  const chooseAction = (): RuleAction => ({ type: 'choose', choices: selectorOpts.map((o) => ({ option: o, elementId: targets[0]?.id ?? '' })) })
  const setAction = (i: number, a: RuleAction) => setDraft((d) => d && { ...d, actions: d.actions.map((x, j) => (j === i ? a : x)) })

  return (
    <section aria-labelledby="rules-heading" className="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 id="rules-heading" className="text-sm font-medium text-gray-300">Rules</h2>
        {!draft && (widgets.length > 0 || clickables.length > 0) && rules && rules.length < limit && (
          <button type="button" onClick={start} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500">+ Add rule</button>
        )}
      </div>
      <p className="mb-3 text-sm text-gray-400">
        Make a widget, a moment in time or a click do something without code: show or hide items, or switch the live preset, for everyone in the scene. Widget and timed rules run on Virvi&apos;s side, so they work the same in Decentraland, Hyperfy and AR Spaces; click rules work in Decentraland and Hyperfy.
      </p>
      {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      {widgets.length === 0 && clickables.length === 0 && <p className="text-sm text-gray-400">Add a widget, or an image, video screen or model to click, first: rules start from one.</p>}

      {draft && (
        <div className="mb-4 space-y-3 rounded border border-gray-800 p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
            <span>When</span>
            <select aria-label="Widget or item" className={SELECT} value={draft.widgetId}
              onChange={(e) => {
                const id = e.target.value
                const slider = !isItem(id) && widgetType(id) === SLIDER
                const selector = !isItem(id) && widgetType(id) === SELECTOR
                const actions = draft.actions.map((a): RuleAction =>
                  (!slider && (a.type === 'volume' || a.type === 'brightness')) || (!selector && a.type === 'choose')
                    ? { type: 'show', elementId: targets[0]?.id ?? '' }
                    : a)
                setDraft({ ...draft, widgetId: id, when: choicesFor(id)[0].value, actions })
              }}>
              {widgets.length > 0 && <optgroup label="Widgets">{widgets.map((w) => <option key={w.id} value={w.id}>{w.name || 'Widget'}</option>)}</optgroup>}
              {clickables.length > 0 && <optgroup label="Items to click">{clickables.map((c) => <option key={c.id} value={c.id}>{c.name || c.type}</option>)}</optgroup>}
            </select>
            <select aria-label="When it" className={SELECT} value={draft.when} onChange={(e) => setDraft({ ...draft, when: e.target.value as DraftWhen })}>
              {choicesFor(draft.widgetId).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {draft.when === 'time' && (
              <select aria-label="Time zone" className={SELECT} value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}>
                {timeZones().map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </select>
            )}
          </div>
          {draft.actions.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
              <span>{i === 0 ? 'Do' : 'Then'}</span>
              <select aria-label={`Action ${i + 1}`} className={SELECT} value={a.type} onChange={(e) => {
                const type = e.target.value as RuleAction['type']
                if (type === 'preset') return setAction(i, { type, presetId: presets[0]?.id ?? '' })
                if (type === 'choose') return setAction(i, chooseAction())
                const pool = poolFor(type)
                const keep = 'elementId' in a && pool.some((t) => t.id === a.elementId) ? a.elementId : pool[0]?.id ?? ''
                setAction(i, { type, elementId: keep })
              }}>
                <option value="show" disabled={!targets.length}>Show</option>
                <option value="hide" disabled={!targets.length}>Hide</option>
                <option value="toggle" disabled={!targets.length}>Show or hide (switch)</option>
                <option value="preset">Switch to the preset</option>
                {fromSelector && <option value="choose" disabled={!targets.length || !selectorOpts.length}>Show the item for the chosen option</option>}
                {fromSlider && <option value="volume" disabled={!loud.length}>Set the volume from the slider</option>}
                {fromSlider && <option value="brightness" disabled={!bright.length}>Set the brightness from the slider (Decentraland)</option>}
              </select>
              {a.type === 'choose' ? (
                <span className="flex w-full flex-col gap-1 pl-6">
                  {a.choices.map((c, j) => (
                    <span key={c.option} className="flex items-center gap-2">
                      <span className="w-32 truncate text-gray-400">{c.option}</span>
                      <select aria-label={`Item for ${c.option}`} className={SELECT} value={c.elementId}
                        onChange={(e) => setAction(i, { type: 'choose', choices: a.choices.map((x, k) => (k === j ? { ...x, elementId: e.target.value } : x)) })}>
                        {targets.map((t) => <option key={t.id} value={t.id}>{t.name || t.type}</option>)}
                      </select>
                    </span>
                  ))}
                </span>
              ) : a.type === 'preset' ? (
                <select aria-label={`Preset for action ${i + 1}`} className={SELECT} value={a.presetId} onChange={(e) => setAction(i, { type: 'preset', presetId: e.target.value })}>
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              ) : (
                <select aria-label={`Item for action ${i + 1}`} className={SELECT} value={a.elementId} onChange={(e) => setAction(i, { type: a.type, elementId: e.target.value })}>
                  {poolFor(a.type).map((t) => <option key={t.id} value={t.id}>{t.name || t.type}</option>)}
                </select>
              )}
              {draft.actions.length > 1 && (
                <button type="button" onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })} className="text-xs text-red-300 hover:text-red-200">Remove</button>
              )}
            </div>
          ))}
          {draft.actions.length < ACTIONS_PER_RULE && (
            <button type="button" onClick={() => setDraft({ ...draft, actions: [...draft.actions, draft.actions[draft.actions.length - 1]] })} className="text-xs text-blue-300 underline hover:text-blue-200">+ Another action</button>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Rule name (optional)" placeholder="Name (optional)" maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${SELECT} w-56`} />
            <button type="button" disabled={busy} onClick={save} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">Save rule</button>
            <button type="button" onClick={() => setDraft(null)} className="text-sm text-gray-400 hover:text-gray-200">Cancel</button>
          </div>
          <p className="text-xs text-gray-400">{describeRule({ trigger: triggerFor(draft.widgetId, draft.when, draft.timezone), actions: draft.actions }, elements, presets)}</p>
          {draft.when === 'click' && <p className="text-xs text-gray-400">Anyone in the scene can click it: in Decentraland on @virvixr/dcl 2.24.0 or later, and in Hyperfy with Virvi app 1.2.0 or later. Its click action, if it has one, still runs too.</p>}
          {draft.when === 'time' && <p className="text-xs text-gray-400">It runs once each time the widget&apos;s date and time arrives, within about 20 seconds. Set a new date and time to run it again.</p>}
        </div>
      )}

      {rules && rules.length === 0 && !draft && (widgets.length > 0 || clickables.length > 0) && <p className="text-sm text-gray-400">No rules yet.</p>}
      {rules && rules.length > 0 && (
        <ul className="divide-y divide-gray-800 text-sm">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2">
              <span className={`min-w-0 ${r.enabled ? 'text-gray-200' : 'text-gray-500'}`}>
                {r.name && <span className="font-medium">{r.name}: </span>}
                {describeRule(r, elements, presets)}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <label className="flex items-center gap-1 text-xs text-gray-400">
                  <input type="checkbox" checked={r.enabled} disabled={busy} onChange={() => act(() => api.updateRule(r.id, { enabled: !r.enabled }))} className="accent-blue-500" />
                  On
                </label>
                <button type="button" disabled={busy} onClick={() => act(() => api.deleteRule(r.id))} aria-label={`Delete rule ${r.name || describeRule(r, elements, presets)}`} className="text-xs text-red-300 hover:text-red-200">Delete</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
