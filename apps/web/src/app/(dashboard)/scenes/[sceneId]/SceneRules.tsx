'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { ACTIONS_PER_RULE, describeRule, localTimeZone, ruleTargets, timeZones, triggerFor, whenChoices, type DraftWhen, type RuleAction, type SceneRule } from '@/lib/scene-rules'

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
  const targets = ruleTargets(elements)

  const load = async () => {
    try { const r = await api.getPresetRules(presetId); setRules(r.rules); setLimit(r.limit); setError(null) } catch (e: any) { setError(e?.message ?? 'Could not load the rules') }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDraft(null); load() }, [presetId])

  const widgetType = (id: string) => Number(widgets.find((w) => w.id === id)?.properties?.controlType ?? 0)
  const start = () => {
    const w = widgets[0]
    if (!w) return
    setDraft({ name: '', widgetId: w.id, when: whenChoices(widgetType(w.id))[0].value, timezone: localTimeZone(), actions: [targets[0] ? { type: 'show', elementId: targets[0].id } : { type: 'preset', presetId: presets[0]?.id ?? '' }] })
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
  const setAction = (i: number, a: RuleAction) => setDraft((d) => d && { ...d, actions: d.actions.map((x, j) => (j === i ? a : x)) })

  return (
    <section aria-labelledby="rules-heading" className="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 id="rules-heading" className="text-sm font-medium text-gray-300">Rules</h2>
        {!draft && widgets.length > 0 && rules && rules.length < limit && (
          <button type="button" onClick={start} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500">+ Add rule</button>
        )}
      </div>
      <p className="mb-3 text-sm text-gray-400">
        Make a widget do something without code: when it changes, show or hide items or switch the live preset. Rules run on Virvi&apos;s side, so they work the same in Decentraland, Hyperfy and AR Spaces, for everyone in the scene.
      </p>
      {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      {widgets.length === 0 && <p className="text-sm text-gray-400">Add a Toggle, Trigger or other widget first; rules start from a widget.</p>}

      {draft && (
        <div className="mb-4 space-y-3 rounded border border-gray-800 p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
            <span>When</span>
            <select aria-label="Widget" className={SELECT} value={draft.widgetId}
              onChange={(e) => setDraft({ ...draft, widgetId: e.target.value, when: whenChoices(widgetType(e.target.value))[0].value })}>
              {widgets.map((w) => <option key={w.id} value={w.id}>{w.name || 'Widget'}</option>)}
            </select>
            <select aria-label="When it" className={SELECT} value={draft.when} onChange={(e) => setDraft({ ...draft, when: e.target.value as DraftWhen })}>
              {whenChoices(widgetType(draft.widgetId)).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
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
                setAction(i, type === 'preset' ? { type, presetId: presets[0]?.id ?? '' } : { type, elementId: 'elementId' in a ? a.elementId : targets[0]?.id ?? '' })
              }}>
                <option value="show" disabled={!targets.length}>Show</option>
                <option value="hide" disabled={!targets.length}>Hide</option>
                <option value="toggle" disabled={!targets.length}>Show or hide (switch)</option>
                <option value="preset">Switch to the preset</option>
              </select>
              {a.type === 'preset' ? (
                <select aria-label={`Preset for action ${i + 1}`} className={SELECT} value={a.presetId} onChange={(e) => setAction(i, { type: 'preset', presetId: e.target.value })}>
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              ) : (
                <select aria-label={`Item for action ${i + 1}`} className={SELECT} value={a.elementId} onChange={(e) => setAction(i, { type: a.type, elementId: e.target.value })}>
                  {targets.map((t) => <option key={t.id} value={t.id}>{t.name || t.type}</option>)}
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
          {draft.when === 'time' && <p className="text-xs text-gray-400">It runs once each time the widget&apos;s date and time arrives, within about 20 seconds. Set a new date and time to run it again.</p>}
        </div>
      )}

      {rules && rules.length === 0 && !draft && widgets.length > 0 && <p className="text-sm text-gray-400">No rules yet.</p>}
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
