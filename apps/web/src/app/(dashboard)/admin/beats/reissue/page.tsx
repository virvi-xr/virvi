'use client'

import { useCallback, useEffect, useState } from 'react'
import type { BeatChain } from '@virvixr/shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { PageHeader, Skeleton } from '@/components/ui'
import { ReissueRequestCard, type ReissueActions } from '@/components/beats/ReissueQueue'
import { REISSUE_FILTERS, REISSUE_STATUS_LABELS, adminReissueError, saveJson, type AdminReissueRequest } from '@/lib/reissue'

const PAGE = 25
const FILTER_LABELS: Record<(typeof REISSUE_FILTERS)[number], string> = { open: 'Open', all: 'All', ...REISSUE_STATUS_LABELS }

/** Admin: requests to move a person's BEATs to a new wallet (LIV-11). */
export default function AdminReissuePage() {
  const { user } = useAuth()
  const api = useApi()
  const [status, setStatus] = useState<(typeof REISSUE_FILTERS)[number]>('open')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<AdminReissueRequest[] | 'off' | null>(null)
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.listAdminReissueRequests(status, offset).then(setList, (e: any) => (e?.status === 404 ? setList('off') : setError(adminReissueError(e))))
  }, [api, status, offset])
  useEffect(() => { if (user?.role === 'admin') load() }, [user?.role, load])

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>

  async function run<T>(act: () => Promise<T>, done?: string): Promise<T | null> {
    setBusy(true); setError(null); setNote(null)
    try {
      const out = await act()
      if (done) setNote(done)
      load()
      return out
    } catch (e) {
      setError(adminReissueError(e))
      return null
    } finally {
      setBusy(false)
    }
  }

  const actions: ReissueActions = {
    busy,
    me: user?.id,
    approve: (r, n, wallets) => { run(() => api.reviewAdminReissue(r.id, 'approve', { ...(n.trim() ? { note: n } : {}), wallets }), 'Approved. The old wallet is blocked.') },
    reject: (r, n) => { run(() => api.reviewAdminReissue(r.id, 'reject', { note: n }), 'Rejected.') },
    preview: (r, chain: BeatChain) => run(() => api.previewAdminReissue(r.id, chain)),
    propose: async (r, chain) => (await run(() => api.proposeAdminReissue(r.id, chain), 'Files prepared. Download each one for the Safe.'))?.files ?? null,
    download: (r, f) => { run(async () => { const { blob, filename } = await api.downloadAdminReissueFile(r.id, f.id, f.filename); const url = URL.createObjectURL(blob); const el = document.createElement('a'); el.href = url; el.download = filename; el.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }) },
    saveFile: (f) => saveJson(f.file, f.filename),
    withdraw: (r, body) => { run(() => api.withdrawAdminReissue(r.id, body), body.fileId ? 'File withdrawn. Reject its pending transaction in the Safe too.' : 'Request withdrawn. Reject its pending transactions in the Safe too.') },
    unlink: (r, wallet) => { run(() => api.unlinkAdminReissueWallet(r.id, wallet), 'Wallet removed from the account and blocked.') },
    liftBlock: (wallet, n) => { run(() => api.liftAdminWalletBlock(wallet, n), 'Block lifted.') },
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader crumbs={['System', { label: 'Admin', href: '/admin' }, { label: 'BEATs', href: '/admin/beats' }, 'Reissue requests']} title="Reissue requests"
        subtitle={<p className="max-w-2xl">People asking to move their BEATs from a lost or stolen wallet to a new one. Check the red flags and the wallet history before approving.</p>} />
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="reissue-filter" className="text-sm text-gray-400">Show</label>
        <select id="reissue-filter" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setOffset(0) }}
          className="rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-sm">
          {REISSUE_FILTERS.map((f) => <option key={f} value={f}>{FILTER_LABELS[f]}</option>)}
        </select>
      </div>
      {error && (
        <div role="alert" className="text-sm text-red-400">
          <p>{error.message}</p>
          {error.code && <p className="text-xs text-gray-400">Code: {error.code}</p>}
        </div>
      )}
      {note && <p role="status" className="text-sm text-gray-300">{note}</p>}
      {list === null ? (!error && <Skeleton rows={3} />)
        : list === 'off' ? <p className="text-sm text-gray-400">BEATs are off.</p>
        : list.length === 0 ? <p className="text-sm text-gray-400">No requests here.</p>
        : <div className="space-y-4">{list.map((r) => <ReissueRequestCard key={r.id} r={r} a={actions} />)}</div>}
      {Array.isArray(list) && (offset > 0 || list.length === PAGE) && (
        <div className="flex gap-2">
          <button type="button" className="rounded-md border border-gray-700 px-3 py-1.5 text-xs disabled:opacity-50" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
          <button type="button" className="rounded-md border border-gray-700 px-3 py-1.5 text-xs disabled:opacity-50" disabled={list.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Older</button>
        </div>
      )}
    </div>
  )
}
