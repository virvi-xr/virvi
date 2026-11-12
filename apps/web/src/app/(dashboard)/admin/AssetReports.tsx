'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useApi, type AdminAssetReport } from '@/lib/api'
import { Skeleton } from '@/components/ui'
import { REPORT_REASONS, shareErrorMessage } from '@/lib/asset-sharing'
import { licenseLabel } from '@/lib/catalog'

const reasonLabel = (key: string) => REPORT_REASONS.find(([k]) => k === key)?.[1] ?? key

/**
 * Open reports of shared 3D models (LIV-20). Take down hides the model from everyone who doesn't already have it and
 * stops its owner sharing it again; Dismiss closes the report and leaves the model shared.
 */
export default function AssetReports() {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [rows, setRows] = useState<AdminAssetReport[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [takingDown, setTakingDown] = useState<string | null>(null)
  const [why, setWhy] = useState('')

  const load = useCallback(async () => {
    try { setRows((await apiRef.current.getAdminAssetReports()).reports) } catch (e) { setError(shareErrorMessage(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    setError(null)
    try { await fn(); setTakingDown(null); setWhy(''); await load() } catch (e) { setError(shareErrorMessage(e)) } finally { setBusy(null) }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
      <h2 className="text-lg font-semibold">Model reports{rows && rows.length > 0 ? ` (${rows.length})` : ''}</h2>
      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      {!rows ? (error ? null : <Skeleton rows={1} className="h-12" />) : rows.length === 0 ? (
        <p className="text-sm text-gray-400">No open reports of shared models.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-md border border-gray-800 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    <Link href={`/assets?id=${r.asset.id}`} className="hover:underline">{r.asset.name}</Link>
                    <span className="text-sm text-gray-500"> · {r.asset.author ? `by ${r.asset.author}` : 'no credit'}{r.asset.license ? ` · ${licenseLabel(r.asset.license)}` : ''}</span>
                  </p>
                  <p className="text-sm text-gray-300">{reasonLabel(r.reason)} <span className="text-gray-500">· {new Date(r.createdAt).toLocaleString()}</span></p>
                  {r.details && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-400">{r.details}</p>}
                  <p className="mt-1 text-xs text-gray-500">Owner: {r.owner ? `${r.owner.displayName || 'unnamed'}${r.owner.email ? ` (${r.owner.email})` : ''}` : 'deleted account'}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button type="button" disabled={busy === r.id} onClick={() => setTakingDown(takingDown === r.asset.id ? null : r.asset.id)}
                    className="rounded-md bg-red-900/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-900/60 disabled:opacity-50">Take down</button>
                  <button type="button" disabled={busy === r.id} onClick={() => act(r.id, () => api.dismissAdminAssetReport(r.id))}
                    className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50">Dismiss</button>
                </div>
              </div>
              {takingDown === r.asset.id && (
                <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void act(r.id, () => api.takeDownAsset(r.asset.id, why.trim())) }}>
                  <input type="text" value={why} maxLength={500} onChange={(e) => setWhy(e.target.value)} aria-label="Why it's taken down (the owner sees this)"
                    placeholder="Why (the owner sees this)" className="min-w-0 flex-1 rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-sm outline-none focus:border-blue-400" />
                  <button type="submit" disabled={!why.trim() || busy === r.id} className="rounded-md bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-600 disabled:opacity-50">
                    {busy === r.id ? 'Taking down…' : 'Take it down'}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
