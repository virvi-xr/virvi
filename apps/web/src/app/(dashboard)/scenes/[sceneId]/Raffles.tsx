'use client'
import { useEffect, useState } from 'react'
import { MIN_PRESENT_MAX_MINUTES, RAFFLE_HOST_TERMS, RAFFLE_WINNERS_MAX } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  AUTO_SNAPSHOT_CHOICES, MODE_LABELS, STATUS_LABELS, blankRaffle, fillRules, minutesPresent, raffleActions, raffleBody, raffleErrorMessage,
  raffleFormError, rulesHost, winnerLabel,
} from '@/lib/raffles'
import type { HostRaffle, RaffleDetail, RaffleInput, RaffleMode, RaffleStatus, RaffleWinner } from '@/lib/raffles'

const ACTION_LABELS = { open: 'Open', snapshot: 'Snapshot', draw: 'Spin', close: 'Close', cancel: 'Cancel' } as const
const CHIP: Record<RaffleStatus, string> = {
  draft: 'bg-gray-700 text-gray-200', open: 'bg-green-900 text-green-300', drawn: 'bg-orange-900 text-orange-300',
  closed: 'bg-gray-800 text-gray-400', cancelled: 'bg-gray-800 text-gray-500',
}
const INPUT = 'rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none border border-gray-800 focus:border-blue-400'
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

function StatusChip({ status }: { status: RaffleStatus }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs ${CHIP[status]}`}>{STATUS_LABELS[status]}</span>
}

function CopyWallet({ wallet }: { wallet: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-xs text-gray-400" title={wallet}>{`${wallet.slice(0, 6)}…${wallet.slice(-4)}`}</span>
      <button type="button" aria-label={`Copy wallet ${wallet}`} className="text-xs text-orange-400 hover:underline"
        onClick={() => { navigator.clipboard?.writeText(wallet).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {}) }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

function Winner({ w }: { w: RaffleWinner }) {
  const { name, wallet } = winnerLabel(w)
  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className={wallet ? 'text-gray-100' : 'text-gray-500 italic'}>{name}</span>
      {wallet && <CopyWallet wallet={wallet} />}
    </li>
  )
}

/** Host-side raffles for one scene: a list, a create form and a page to run each raffle. */
export function Raffles({ sceneId, sceneName }: { sceneId: string; sceneName: string }) {
  const { token } = useAuth()
  const api = useApi()
  const [raffles, setRaffles] = useState<HostRaffle[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try { setRaffles((await api.listRaffles(sceneId)).raffles); setError(null) } catch (err) { setError(raffleErrorMessage(err)) }
  }
  // useApi() returns new functions every render; reload when the scene or session changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [sceneId, token])

  if (openId) return <RafflePage raffleId={openId} onBack={() => { setOpenId(null); load() }} />
  if (creating) return <RaffleForm sceneId={sceneId} sceneName={sceneName} onCancel={() => setCreating(false)} onCreated={(r) => { setCreating(false); setOpenId(r.id) }} />

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">Raffles</h3>
        <button type="button" onClick={() => setCreating(true)} className="rounded-md bg-orange-600 px-3 py-1.5 text-sm text-white hover:bg-orange-500">New raffle</button>
      </div>
      {error && <div className="mb-3 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>}
      {raffles && raffles.length === 0 && <p className="text-sm text-gray-500">No raffles yet.</p>}
      <ul className="space-y-2">
        {raffles?.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => setOpenId(r.id)} className="flex w-full items-center justify-between rounded-md bg-gray-800 px-4 py-2 text-left text-sm hover:bg-gray-700">
              <span className="text-gray-100">{r.name}</span>
              <span className="flex items-center gap-3">
                <StatusChip status={r.status} />
                <span className="text-xs text-gray-400">{r.entryCount} {r.entryCount === 1 ? 'entry' : 'entries'}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RaffleForm({ sceneId, sceneName, onCancel, onCreated }: { sceneId: string; sceneName: string; onCancel: () => void; onCreated: (r: HostRaffle) => void }) {
  const api = useApi()
  const { user } = useAuth()
  const host = rulesHost(user?.displayName, sceneName)
  const [f, setF] = useState<RaffleInput>(() => ({ ...blankRaffle(), rules: fillRules('', 1, host) }))
  // The rules follow the prize and winners until the host edits them
  const [rulesEdited, setRulesEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (patch: Partial<RaffleInput>) => setF((cur) => {
    const next = { ...cur, ...patch }
    return rulesEdited || patch.rules !== undefined ? next : { ...next, rules: fillRules(next.prize, next.winnersCount, host) }
  })
  const blocked = raffleFormError(f)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (blocked) { setError(blocked); return }
    setBusy(true)
    try { onCreated((await api.createRaffle(sceneId, raffleBody(f))).raffle) } catch (err) { setError(raffleErrorMessage(err)) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-gray-800 bg-gray-900 p-6 space-y-4">
      <h3 className="text-sm font-medium text-gray-300">New raffle</h3>
      {error && <div role="alert" className="rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>}
      <label className="block text-xs text-gray-400">Name
        <input className={`${INPUT} mt-1 w-full`} value={f.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="block text-xs text-gray-400">Prize
        <input className={`${INPUT} mt-1 w-full`} value={f.prize} maxLength={200} onChange={(e) => set({ prize: e.target.value })} />
      </label>
      <div className="flex flex-wrap gap-4">
        <label className="text-xs text-gray-400">Winners
          <input type="number" min={1} max={RAFFLE_WINNERS_MAX} className={`${INPUT} mt-1 block w-24`} value={f.winnersCount}
            onChange={(e) => set({ winnersCount: Number(e.target.value) })} />
        </label>
        <label className="text-xs text-gray-400">Mode
          <select className={`${INPUT} mt-1 block`} value={f.mode} onChange={(e) => set({ mode: e.target.value as RaffleMode })}>
            {(Object.keys(MODE_LABELS) as RaffleMode[]).map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-400">Minimum minutes present
          <input type="number" min={0} max={MIN_PRESENT_MAX_MINUTES} className={`${INPUT} mt-1 block w-24`} value={f.minPresentMinutes}
            onChange={(e) => set({ minPresentMinutes: Number(e.target.value) })} />
        </label>
        <label className="text-xs text-gray-400">Auto-snapshot
          <select className={`${INPUT} mt-1 block`} value={f.autoSnapshotMinutes ?? ''} onChange={(e) => set({ autoSnapshotMinutes: e.target.value === '' ? null : Number(e.target.value) })}>
            {AUTO_SNAPSHOT_CHOICES.map((m) => <option key={m ?? 'off'} value={m ?? ''}>{m === null ? 'Off' : `Every ${m} min`}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-xs text-gray-400">Rules
        <textarea className={`${INPUT} mt-1 w-full font-mono`} rows={8} value={f.rules} onChange={(e) => { setRulesEdited(true); set({ rules: e.target.value }) }} />
      </label>
      <label className="flex items-start gap-2 text-xs text-gray-300">
        <input type="checkbox" className="mt-0.5" checked={f.acceptHostTerms} onChange={(e) => set({ acceptHostTerms: e.target.checked })} />
        <span>{RAFFLE_HOST_TERMS}</span>
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={busy || blocked !== null} className="rounded-md bg-orange-600 px-3 py-1.5 text-sm text-white hover:bg-orange-500 disabled:opacity-50">Create raffle</button>
        <button type="button" onClick={onCancel} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700">Back</button>
      </div>
    </form>
  )
}

function RafflePage({ raffleId, onBack }: { raffleId: string; onBack: () => void }) {
  const { token } = useAuth()
  const api = useApi()
  const [detail, setDetail] = useState<RaffleDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [spun, setSpun] = useState<RaffleWinner[] | null>(null)
  const [record, setRecord] = useState<{ id: string; json: string } | null>(null)

  const load = async () => {
    try { setDetail(await api.getRaffle(raffleId)) } catch (err) { setError(raffleErrorMessage(err)) }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [raffleId, token])

  const act = async (action: keyof typeof ACTION_LABELS) => {
    setBusy(true); setError(null)
    try {
      if (action === 'draw') setSpun((await api.drawRaffle(raffleId)).winners)
      else await api.raffleAction(raffleId, action)
      await load()
    } catch (err) { setError(raffleErrorMessage(err)) } finally { setBusy(false) }
  }

  const viewRecord = async (drawId: string) => {
    try { setRecord({ id: drawId, json: JSON.stringify(await api.getRaffleDraw(raffleId, drawId), null, 2) }) } catch (err) { setError(raffleErrorMessage(err)) }
  }

  const r = detail?.raffle
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 space-y-6">
      <button type="button" onClick={onBack} className="text-xs text-orange-400 hover:underline">← All raffles</button>
      {error && <div role="alert" className="rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>}
      {r && detail && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-medium text-white">{r.name}</h3>
              <p className="text-xs text-gray-400">Prize: {r.prize} · {r.winnersCount} {r.winnersCount === 1 ? 'winner' : 'winners'} · {MODE_LABELS[r.mode]}</p>
            </div>
            <div className="flex items-center gap-2">
              <StatusChip status={r.status} />
              {raffleActions(r.status).map((a) => (
                <button key={a} type="button" disabled={busy} onClick={() => act(a)}
                  className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${a === 'cancel' || a === 'close' ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-orange-600 text-white hover:bg-orange-500'}`}>
                  {ACTION_LABELS[a]}
                </button>
              ))}
            </div>
          </div>

          {spun && (
            <section aria-label="Winners">
              <h4 className="mb-2 text-sm font-medium text-gray-300">Winners</h4>
              <ul className="space-y-1 rounded-md bg-gray-800 p-3">{spun.map((w) => <Winner key={w.entryId} w={w} />)}</ul>
            </section>
          )}

          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-300">Entries ({detail.entries.length})</h4>
            {detail.entries.length === 0 ? <p className="text-sm text-gray-500">No entries yet.</p> : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-gray-500"><tr><th className="py-1">Name</th><th>Wallet</th><th>Minutes present</th><th>Last seen</th></tr></thead>
                <tbody>
                  {detail.entries.map((e) => (
                    <tr key={e.id} className="border-t border-gray-800">
                      <td className="py-1 text-gray-100">{e.displayName}</td>
                      <td><CopyWallet wallet={e.wallet} /></td>
                      <td className="text-gray-300">{minutesPresent(e.secondsPresent)}</td>
                      <td className="text-gray-400">{when(e.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-300">Snapshots ({detail.snapshots.length})</h4>
            {detail.snapshots.length === 0 ? <p className="text-sm text-gray-500">No snapshots yet. A spin only counts entrants who were present in a snapshot.</p> : (
              <ul className="space-y-1 text-sm text-gray-300">
                {detail.snapshots.map((s) => <li key={s.id}>{when(s.takenAt)} · {s.trigger === 'auto' ? 'Automatic' : 'Manual'} · {s.entryIds.length} present</li>)}
              </ul>
            )}
          </section>

          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-300">Draws ({detail.draws.length})</h4>
            {detail.draws.length === 0 ? <p className="text-sm text-gray-500">No draws yet.</p> : (
              <ul className="space-y-3">
                {detail.draws.map((d) => (
                  <li key={d.id} className="rounded-md bg-gray-800 p-3">
                    <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
                      <span>{when(d.drawnAt)}</span>
                      <button type="button" onClick={() => (record?.id === d.id ? setRecord(null) : viewRecord(d.id))} className="text-orange-400 hover:underline">View record</button>
                    </div>
                    <ul className="space-y-1">{d.winners.map((w) => <Winner key={w.entryId} w={w} />)}</ul>
                    {record?.id === d.id && <pre className="mt-2 max-h-64 overflow-auto rounded bg-gray-950 p-2 text-xs text-gray-300">{record.json}</pre>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
