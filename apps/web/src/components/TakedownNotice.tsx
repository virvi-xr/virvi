'use client'
import { useEffect, useState } from 'react'
import { useApi, type AssetAppeal } from '@/lib/api'
import { appealLine } from '@/lib/moderation'

/** What the owner of a model Virvi took down sees: why, and their appeal (LIV-34). */
export function TakedownNotice({ assetId, reason }: { assetId: string; reason: string | null }) {
  const api = useApi()
  const [appeal, setAppeal] = useState<AssetAppeal | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { api.getAssetAppeal(assetId).then((r) => setAppeal(r.appeal), () => setAppeal(null)) }, [assetId])

  const send = async () => {
    setBusy(true); setError(null)
    try {
      await api.appealAsset(assetId, message.trim())
      setAppeal((await api.getAssetAppeal(assetId)).appeal)
      setOpen(false)
    } catch (e: any) { setError(e?.message ?? 'Could not send the appeal') } finally { setBusy(false) }
  }
  const line = appeal ? appealLine(appeal) : null
  const canAppeal = appeal !== undefined && (!appeal || appeal.status === 'rejected')

  return (
    <div className="rounded-md border border-red-900/60 bg-red-900/20 p-3 text-sm text-red-300" role="status">
      <p>Virvi took this model down{reason ? `: ${reason}` : ''}. It stays in your library and in scenes that have it, but it can’t be shared.</p>
      {line && <p className="mt-2 text-gray-200">{line}</p>}
      {canAppeal && !open && (
        <button type="button" onClick={() => setOpen(true)} className="mt-2 rounded-md border border-red-800 px-3 py-1 text-xs text-red-200 hover:border-red-600">
          {appeal ? 'Appeal again' : 'Appeal'}
        </button>
      )}
      {open && (
        <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void send() }}>
          <label className="block text-xs text-gray-300">Why should it come back? Include anything that shows you have the rights to it.
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={2000} required
              className="mt-1 w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400" />
          </label>
          {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !message.trim()} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">Send appeal</button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-3 py-1.5 text-xs text-gray-300 hover:text-white">Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}
