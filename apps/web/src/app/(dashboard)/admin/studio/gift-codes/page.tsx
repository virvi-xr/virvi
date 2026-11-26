'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { Badge, ConfirmAction, PageHeader, PrimaryButton, Skeleton, type Tone, TableScroll } from '@/components/ui'
import { giftCodeStatus, type AdminGiftCode } from '@/lib/studio'

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
const dayFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' })
const STATUS_TONE: Record<ReturnType<typeof giftCodeStatus>, Tone> = { Active: 'success', Off: 'warning', Expired: 'warning', 'Used up': 'warning' }
const inputClass = 'w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400'

/**
 * Admin: make Design Studio gift codes (prompts and free finalizes), see who redeemed each, and turn one off. The full
 * code shows once, when it's made; the list keeps only its last four characters.
 */
export default function AdminGiftCodesPage() {
  const { user } = useAuth()
  const api = useApi()
  const [codes, setCodes] = useState<AdminGiftCode[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [prompts, setPrompts] = useState('20')
  const [finalizes, setFinalizes] = useState('0')
  const [maxUses, setMaxUses] = useState('1')
  const [expires, setExpires] = useState('')
  const [note, setNote] = useState('')

  // load isn't memoized (it is a new function each render), so the effect keys on the role, not on load itself
  const load = async () => {
    try {
      setCodes((await api.listGiftCodes()).codes)
    } catch (e) {
      setError((e as Error)?.message ?? 'Something went wrong')
    }
  }

  useEffect(() => {
    if (user?.role === 'admin') load()
  }, [user?.role]) // eslint-disable-line react-hooks/exhaustive-deps

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>

  const p = Number(prompts)
  const f = Number(finalizes)
  const m = Number(maxUses)
  const valid = Number.isInteger(p) && p >= 0 && Number.isInteger(f) && f >= 0 && p + f > 0 && Number.isInteger(m) && m >= 1

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.createGiftCode({
        prompts: p, finalizes: f, maxUses: m,
        expiresAt: expires ? `${expires}T23:59:59.999Z` : null,
        note: note.trim() || null,
      })
      setMade(r.code)
      setCopied(false)
      setNote('')
      await load()
    } catch (err) {
      setError((err as { status?: number }).status === 400 ? 'Check the numbers and the expiry date (it must be in the future).' : (err as Error)?.message ?? 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(made ?? '')
      setCopied(true)
    } catch {
      setError('Copy failed. Select the code and copy it by hand.')
    }
  }

  const turnOff = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.disableGiftCode(id)
      await load()
    } catch (err) {
      setError((err as Error)?.message ?? 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const now = new Date()

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        crumbs={['System', { label: 'Admin', href: '/admin' }, { label: 'Studio', href: '/admin/studio' }, 'Gift codes']}
        title="Gift codes"
        subtitle="Codes that give someone Design Studio prompts and free finalizes. Turning a code off stops new redemptions; what was given stays."
      />
      {error && <p className="mb-4 text-sm text-red-400" role="alert">{error}</p>}

      <form onSubmit={create} className="mb-8 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-3 text-lg font-semibold">Make a code</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm text-gray-400">Prompts
            <input type="number" min={0} step={1} value={prompts} onChange={(e) => setPrompts(e.target.value)} className={`mt-1 ${inputClass}`} />
          </label>
          <label className="block text-sm text-gray-400">Free finalizes
            <input type="number" min={0} step={1} value={finalizes} onChange={(e) => setFinalizes(e.target.value)} className={`mt-1 ${inputClass}`} />
          </label>
          <label className="block text-sm text-gray-400">Uses
            <input type="number" min={1} step={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} className={`mt-1 ${inputClass}`} />
          </label>
          <label className="block text-sm text-gray-400">Expires (optional)
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className={`mt-1 ${inputClass}`} />
          </label>
          <label className="block text-sm text-gray-400 sm:col-span-2">Note (optional)
            <input type="text" value={note} maxLength={200} placeholder="for Sam" onChange={(e) => setNote(e.target.value)} className={`mt-1 ${inputClass}`} />
          </label>
        </div>
        <div className="mt-4">
          <PrimaryButton type="submit" disabled={busy || !valid}>{busy ? 'Working…' : 'Make code'}</PrimaryButton>
        </div>
        {made && (
          <div className="mt-4 rounded-md border border-emerald-500/40 p-3" role="status">
            <p className="text-sm text-emerald-200">Here is the code. You won&apos;t see this code again.</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <code className="select-all break-all rounded bg-gray-950 px-3 py-2 font-mono text-lg">{made}</code>
              <button type="button" onClick={copy} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        )}
      </form>

      <section aria-labelledby="codes-title">
        <h2 id="codes-title" className="mb-3 text-lg font-semibold">Codes</h2>
        {!codes ? <Skeleton rows={2} className="h-12" /> : codes.length === 0 ? (
          <p className="text-gray-400">No codes yet.</p>
        ) : (
          <TableScroll label="Gift codes" className="rounded-lg border border-gray-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-900 text-xs text-gray-500">
                <tr>
                  {['Code', 'Note', 'Prompts', 'Finalizes', 'Uses', 'Expires', 'Status', 'Redeemed by', ''].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {codes.map((c) => {
                  const status = giftCodeStatus(c, now)
                  return (
                    <tr key={c.id} className="align-top">
                      <td className="px-3 py-2 font-mono">…{c.hint}</td>
                      <td className="px-3 py-2 text-gray-300">{c.note ?? '—'}</td>
                      <td className="px-3 py-2">{c.prompts}</td>
                      <td className="px-3 py-2">{c.finalizes}</td>
                      <td className="px-3 py-2">{c.uses} / {c.maxUses}</td>
                      <td className="px-3 py-2">{c.expiresAt ? dayFmt.format(new Date(c.expiresAt)) : 'Never'}</td>
                      <td className="px-3 py-2"><Badge tone={STATUS_TONE[status]}>{status}</Badge></td>
                      <td className="px-3 py-2 text-gray-300">
                        {c.redemptions.length === 0 ? '—' : (
                          <ul className="space-y-1">
                            {c.redemptions.map((r, i) => (
                              <li key={i}>{r.name || r.email || 'Unknown'}{r.name && r.email ? ` (${r.email})` : ''} <span className="text-xs text-gray-500">{dateFmt.format(new Date(r.at))}</span></li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {!c.disabledAt && (
                          <ConfirmAction prompt="Turn this code off? It can't be redeemed any more; what it already gave stays." confirmLabel="Turn off"
                            onConfirm={() => turnOff(c.id)} disabled={busy}
                            className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">
                            Turn off
                          </ConfirmAction>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>
    </div>
  )
}
