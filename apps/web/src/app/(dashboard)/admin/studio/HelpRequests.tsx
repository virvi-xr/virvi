'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { Skeleton } from '@/components/ui'
import { adminActionMessage, type AdminHelpRequest } from '@/lib/studio'

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/**
 * People who pressed Help on a design, oldest first. Replying on the design (a note or a prompt) resolves a request;
 * Resolve here is for one handled elsewhere.
 */
export default function HelpRequests() {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [rows, setRows] = useState<AdminHelpRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setRows((await apiRef.current.getAdminStudioHelp()).requests) } catch (e) { setError(adminActionMessage(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const resolve = async (id: string) => {
    setBusy(id)
    setError(null)
    try { await api.resolveAdminStudioHelp(id); await load() } catch (e) { setError(adminActionMessage(e)) } finally { setBusy(null) }
  }

  return (
    <section aria-labelledby="help-requests-title" className="mt-10">
      <h2 id="help-requests-title" className="mb-1 text-lg font-semibold">
        Help requests{rows && rows.length > 0 ? ` (${rows.length})` : ''}
      </h2>
      <p className="mb-3 text-sm text-gray-400">People who pressed Help on a design. Reply on the design and the request is resolved.</p>
      {error && <p className="mb-3 text-sm text-red-400" role="alert">{error}</p>}
      {!rows ? (error ? null : <Skeleton rows={1} className="h-16" />) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">Nobody is waiting on help.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {r.displayName || 'Someone'} <span className="text-sm text-gray-500">on</span> {r.designName}
                    <span className="text-sm text-gray-500"> · {r.kind} · {dateFmt.format(new Date(r.createdAt))}</span>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-300">{r.text}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Link href={`/studio/${r.designId}`} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500">Open the design</Link>
                  <button type="button" disabled={busy === r.id} onClick={() => resolve(r.id)}
                    className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50">
                    {busy === r.id ? 'Resolving…' : 'Resolve'}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
