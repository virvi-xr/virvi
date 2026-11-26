'use client'
import { useState } from 'react'
import { useApi } from '@/lib/api'
import { useDialog } from '@/lib/use-dialog'
import { dropsError, notReadyLines, pickerItems, type HostGiveaway, type PickerItem } from '@/lib/drops'

const ITEMS_MAX = 10
const keyOf = (i: { contractAddress: string | null; itemId: string | null }) => `${(i.contractAddress ?? '').toLowerCase()}:${i.itemId ?? ''}`

/**
 * "Choose items": the giveaway owner's wearables and emotes on its chain, up to 10, saved together. Current items the
 * owner's list no longer shows stay as rows (selected), so saving never drops them silently.
 */
export function ItemPicker({ giveaway: g, onSaved }: { giveaway: HostGiveaway; onSaved: (g: HostGiveaway) => void }) {
  const api = useApi()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<PickerItem[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ message: string; items: string[] } | null>(null)
  const dialog = useDialog(open, () => setOpen(false))

  const start = () => {
    setOpen(true)
    setError(null)
    setItems(null)
    setPicked(new Set(g.items.map(keyOf)))
    api.getGiveawayCreatorItems(g.id).then((d) => setItems(pickerItems(d.items, g.items)))
      .catch((err) => { setItems(pickerItems([], g.items)); setError({ message: dropsError(err), items: [] }) })
  }

  const flip = (k: string) => setPicked((p) => {
    const next = new Set(p)
    if (next.has(k)) next.delete(k)
    else if (next.size < ITEMS_MAX) next.add(k)
    return next
  })

  const save = async () => {
    if (!items) return
    setSaving(true)
    setError(null)
    try {
      const chosen = items.filter((i) => picked.has(keyOf(i))).map((i) => ({ contractAddress: i.contractAddress, itemId: i.itemId }))
      onSaved(await api.setGiveawayItems(g.id, chosen))
      setOpen(false)
    } catch (err) {
      const named = items.map(({ missing: _m, available: _a, ...i }) => ({ ...i, id: keyOf(i), mintState: null, remaining: null, checkedAt: null }))
      setError({ message: dropsError(err), items: notReadyLines(err, named, g.walletAddress) })
    }
    setSaving(false)
  }

  const chosenCount = items ? items.filter((i) => picked.has(keyOf(i))).length : 0

  if (!open) {
    return <button type="button" onClick={start} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm hover:bg-blue-700">Choose items</button>
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Choose items" className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold">Choose items</h2>
        <p className="mb-3 text-sm text-gray-400">
          Wearables and emotes the giveaway owner created, or can mint from someone else's collection, with a wallet linked to their account. Pick up to {ITEMS_MAX}.
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!items ? (
            <p role="status" className="text-sm text-gray-400">Loading your items…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-gray-500">No published items found for the wallets linked to the giveaway owner's account.</p>
          ) : (
            <ul className="space-y-1">
              {items.map((i) => {
                const k = keyOf(i)
                return (
                  <li key={k}>
                    <label className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-gray-800/60">
                      <input type="checkbox" checked={picked.has(k)} onChange={() => flip(k)}
                        disabled={!picked.has(k) && picked.size >= ITEMS_MAX} className="rounded" />
                      {i.thumbnail
                        ? <img src={i.thumbnail} alt="" className="h-9 w-9 rounded object-cover" />
                        : <span aria-hidden="true" className="h-9 w-9 rounded bg-gray-800" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{i.name}</span>
                        <span className="block text-xs text-gray-500">
                          {i.missing ? 'Not published by the owner any more. Untick it to save' : [i.rarity, `${i.available.toLocaleString('en-US')} left`].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {error && (
          <div role="alert" className="mt-3 text-sm text-red-400">
            <p>{error.message}</p>
            {error.items.length > 0 && <ul className="mt-1 list-disc pl-5">{error.items.map((l) => <li key={l}>{l}</li>)}</ul>}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setOpen(false)} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          <button type="button" onClick={save} disabled={saving || chosenCount === 0}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Saving…' : `Save ${chosenCount} item${chosenCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
