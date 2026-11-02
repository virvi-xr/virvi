'use client'
import { useEffect, useState, type Dispatch } from 'react'
import { useApi, type WizardAsset, type WizardCatalog } from '@/lib/api'
import { mb, toWizardAsset } from '@/lib/wizard/helpers'
import { stateBudget, type WizardAction, type WizardState } from '@/lib/wizard/state'
import { SearchField } from '@/components/ui'

const n = (v: number) => v.toLocaleString('en-US')
const SEARCH_DEBOUNCE_MS = 300

/** The running count: items, triangles against the plot, size against the World's storage. */
export function countLine(state: WizardState): string {
  const b = stateBudget(state)
  const items = `${b.entities.used} ${b.entities.used === 1 ? 'item' : 'items'}`
  const tris = b.triangles.limit !== null ? `${n(b.triangles.used)} of ${n(b.triangles.limit)} triangles` : `${n(b.triangles.used)} triangles`
  const size = b.bytes.remaining !== null ? `${mb(b.bytes.used)} of your World's storage` : mb(b.bytes.used)
  return `In this scene: ${items} · ${tris} · ${size}`
}

export function AssetsStep({ state, dispatch, catalog }: { state: WizardState; dispatch: Dispatch<WizardAction>; catalog: WizardCatalog | null }) {
  const api = useApi()
  const [chipId, setChipId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<WizardAsset[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [pendingTheme, setPendingTheme] = useState<string | null>(null)
  const budget = stateBudget(state)
  const chip = catalog?.chips.find((c) => c.id === chipId) ?? null

  useEffect(() => {
    if (!chip || !q.trim()) {
      setResults(null)
      setSearchError('')
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      setSearching(true)
      api.getAssets({ category: chip.categories.join(','), q: q.trim(), limit: '24' })
        .then((r) => { if (!stale) { setResults(r.assets.map(toWizardAsset).filter((a): a is WizardAsset => !!a)); setSearchError('') } })
        .catch(() => { if (!stale) setSearchError("Search didn't work just now. Try again.") })
        .finally(() => { if (!stale) setSearching(false) })
    }, SEARCH_DEBOUNCE_MS)
    return () => { stale = true; clearTimeout(timer) }
  }, [chip?.id, q])

  const applyTheme = (id: string) => {
    const theme = catalog?.themes.find((t) => t.id === id)
    if (!theme) return
    dispatch({ type: 'applyTheme', themeId: theme.id, items: theme.items })
    setPendingTheme(null)
  }
  const chooseTheme = (id: string) => {
    if (id === state.themeId) return
    if (state.items.length > 0) setPendingTheme(id)
    else applyTheme(id)
  }

  if (!catalog) return <p className="text-sm text-gray-500">Loading the catalog…</p>
  const shown = results ?? chip?.assets ?? []

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-gray-200">Start from a theme</h3>
        <div className="grid grid-cols-2 gap-2">
          {catalog.themes.map((t) => (
            <button key={t.id} type="button" onClick={() => chooseTheme(t.id)} aria-pressed={state.themeId === t.id}
              className={`rounded-md border px-3 py-2 text-left text-sm ${state.themeId === t.id ? 'border-blue-400 bg-blue-400/10 text-white' : 'border-gray-800 bg-gray-950 text-gray-300 hover:border-gray-700'}`}>
              <span className="block font-medium">{t.name}</span>
              <span className="block text-xs text-gray-500">{t.items.length ? `${t.items.length} ${t.items.length === 1 ? 'item' : 'items'}` : 'Nothing placed'}</span>
            </button>
          ))}
        </div>
        {pendingTheme && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-yellow-700/60 bg-yellow-950/30 px-3 py-2 text-sm text-yellow-100" role="alertdialog" aria-label="Replace what's in the scene?">
            <span className="mr-auto">Replace what&apos;s in the scene?</span>
            <button type="button" onClick={() => applyTheme(pendingTheme)} className="rounded bg-yellow-600/30 px-3 py-1 hover:bg-yellow-600/50">Replace</button>
            <button type="button" onClick={() => setPendingTheme(null)} className="rounded px-3 py-1 text-yellow-200 hover:bg-white/5">Keep what&apos;s there</button>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-gray-200">Add or swap items</h3>
        <div className="flex flex-wrap gap-1.5">
          {catalog.chips.map((c) => (
            <button key={c.id} type="button" aria-pressed={chipId === c.id} onClick={() => { setChipId(chipId === c.id ? null : c.id); setQ('') }}
              className={`rounded-full border px-3 py-1 text-xs ${chipId === c.id ? 'border-blue-400 bg-blue-400/10 text-blue-200' : 'border-gray-700 text-gray-300 hover:border-gray-500'}`}>
              {c.label}
            </button>
          ))}
        </div>
        {chip && (
          <div className="space-y-2">
            <SearchField value={q} onChange={setQ} placeholder={`Search ${chip.label.toLowerCase()}…`} label={`Search ${chip.label}`} className="w-full" />
            {searchError && <p className="text-xs text-red-300">{searchError}</p>}
            {searching && <p className="text-xs text-gray-500">Searching…</p>}
            {!searching && shown.length === 0 && <p className="text-xs text-gray-500">{q.trim() ? 'Nothing that fits matches that.' : 'Nothing here yet.'}</p>}
            <ul className="grid grid-cols-3 gap-2">
              {shown.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => dispatch({ type: 'addAsset', asset: a })} title={`Add ${a.name}`}
                    className="group w-full overflow-hidden rounded-md border border-gray-800 bg-gray-950 text-left hover:border-blue-400">
                    <span className="flex aspect-square items-center justify-center bg-gray-900">
                      {a.thumbnailUrl ? <img src={a.thumbnailUrl} alt="" className="h-full w-full object-contain" loading="lazy" /> : <span className="text-xs text-gray-600">No preview</span>}
                    </span>
                    <span className="block truncate px-1.5 pt-1 text-xs text-gray-200">{a.name}</span>
                    <span className="block px-1.5 pb-1 text-[11px] text-gray-500">{n(a.triangleCount ?? 0)} tris</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="space-y-2 border-t border-gray-800 pt-4">
        <p className="text-sm text-gray-300" role="status">{countLine(state)}</p>
        {budget.bytes.remaining !== null && budget.bytes.remaining >= 0 && (
          <p className="text-xs text-gray-500">{mb(budget.bytes.remaining)} of World storage left after this scene.</p>
        )}
        {state.lastDropped > 0 && (
          <p className="text-sm text-yellow-300">Left out {state.lastDropped} {state.lastDropped === 1 ? 'item' : 'items'} to fit this plot.</p>
        )}
        {(state.notice || budget.over) && <p className="text-sm text-yellow-300" role="alert">{state.notice ?? budget.over}</p>}
        {!state.notice && !budget.over && budget.warning && <p className="text-sm text-yellow-300" role="status">{budget.warning}</p>}
        {state.items.length > 0 && (
          <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
            {state.items.map((i) => (
              <li key={i.key} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-white/[0.03]">
                <span className="truncate">{i.asset.name}</span>
                <button type="button" onClick={() => dispatch({ type: 'removeItem', key: i.key })} aria-label={`Remove ${i.asset.name}`}
                  className="shrink-0 rounded px-1.5 text-gray-500 hover:bg-white/5 hover:text-red-300">×</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
