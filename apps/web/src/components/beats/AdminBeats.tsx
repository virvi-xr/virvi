'use client'
import { BEAT_CHAIN_INFO, beatAddressUrl, type BeatChain } from '@virvixr/shared'
import { CopyWallet } from '@/components/CopyWallet'
import { Badge, ConfirmAction, tableHeadBand } from '@/components/ui'
import { balanceLabel, pauseMessage, type AdminBeatChain, type AdminBeatsOverview } from '@/lib/admin-beats'

const link = 'text-blue-400 hover:underline'
const btn = 'rounded-md border border-gray-700 px-3 py-1.5 text-xs hover:border-gray-500 disabled:opacity-50'
const label = (chain: BeatChain) => BEAT_CHAIN_INFO[chain]?.label ?? chain

function ChainCard({ c, busy, onClearPause }: { c: AdminBeatChain; busy: boolean; onClearPause: (chain: BeatChain) => void }) {
  const pause = pauseMessage(c)
  return (
    <section className="rounded-lg border border-gray-800 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{label(c.chain)}</h2>
        {c.missing.length ? <Badge tone="danger">Not set up</Badge> : pause ? <Badge tone="danger">Paused</Badge> : <Badge tone="success">Minting</Badge>}
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-gray-500">Minter</dt>
        {c.minter
          ? <dd className="flex flex-wrap items-center gap-3"><CopyWallet wallet={c.minter} /><a href={beatAddressUrl(c.chain, c.minter)} target="_blank" rel="noreferrer" className={`${link} text-xs`}>Polygonscan</a></dd>
          : <dd className="text-gray-500">Not set</dd>}
        {c.minter && <>
          <dt className="text-gray-500">Balance</dt>
          <dd className={c.balanceError ? 'text-amber-300' : 'tabular-nums'}>{balanceLabel(c)}</dd>
        </>}
        <dt className="text-gray-500">Contract</dt>
        <dd>{c.contract ? <a href={beatAddressUrl(c.chain, c.contract)} target="_blank" rel="noreferrer" className={`${link} break-all font-mono text-xs`}>{c.contract}</a> : <span className="text-gray-500">Not set</span>}</dd>
      </dl>
      {pause && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p role="status" className="text-amber-300">{pause}</p>
          {c.reason === 'id_conflict' && (
            <ConfirmAction prompt={`Clear the pause on ${label(c.chain)}? Minting starts again.`} confirmLabel="Clear pause" onConfirm={() => onClearPause(c.chain)} disabled={busy} className={btn}>
              Clear pause
            </ConfirmAction>
          )}
        </div>
      )}
    </section>
  )
}

/** The admin BEATs page body: minters per chain, claim counts, failed claims and recent transactions. */
export function AdminBeatsView({ data, busy, onRetry, onClearPause }: {
  data: AdminBeatsOverview; busy: boolean; onRetry: (beatId?: string) => void; onClearPause: (chain: BeatChain) => void
}) {
  return (
    <div className="space-y-4">
      {data.chains.length === 0
        ? <p className="text-sm text-gray-500">No chain has a minter set up.</p>
        : <div className="grid gap-4 md:grid-cols-2">{data.chains.map((c) => <ChainCard key={c.chain} c={c} busy={busy} onClearPause={onClearPause} />)}</div>}

      <section className="rounded-lg border border-gray-800 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex flex-wrap gap-4">
            <span>Claimed <strong className="tabular-nums text-white">{data.counts.claimed}</strong></span>
            <span>Minting <strong className="tabular-nums text-white">{data.counts.minting}</strong></span>
            <span>Failed <strong className="tabular-nums text-white">{data.counts.failed}</strong></span>
          </p>
          <button type="button" className={btn} disabled={busy || data.counts.failed === 0} onClick={() => onRetry()}>Retry failed</button>
        </div>
      </section>

      <section className="rounded-lg border border-gray-800">
        <h2 className="border-b border-gray-800 px-3 py-2 text-sm font-semibold">Failed claims</h2>
        {data.failed.length === 0 ? <p className="p-3 text-sm text-gray-500">No failed claims.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className={tableHeadBand}><tr><th className="p-2">BEAT</th><th className="p-2">Wallet</th><th className="p-2">Reason</th><th className="p-2" /></tr></thead>
              <tbody>
                {data.failed.map((f) => (
                  <tr key={`${f.beatId}-${f.wallet}`} className="border-t border-gray-800">
                    <td className="p-2">{f.name}</td>
                    <td className="p-2"><CopyWallet wallet={f.wallet} /></td>
                    <td className="p-2 text-xs text-gray-400">{f.failReason ?? '—'}</td>
                    <td className="p-2 text-right"><button type="button" className="text-xs text-blue-300 hover:underline disabled:opacity-50" disabled={busy} onClick={() => onRetry(f.beatId)}>Retry this BEAT</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-gray-800">
        <h2 className="border-b border-gray-800 px-3 py-2 text-sm font-semibold">Recent transactions</h2>
        {data.batches.length === 0 ? <p className="p-3 text-sm text-gray-500">No transactions yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className={tableHeadBand}><tr><th className="p-2">When</th><th className="p-2">Chain</th><th className="p-2">Kind</th><th className="p-2">Token</th><th className="p-2">Nonce</th><th className="p-2">Status</th><th className="p-2">Tries</th><th className="p-2">Transaction</th></tr></thead>
              <tbody>
                {data.batches.map((b) => (
                  <tr key={b.id} className="border-t border-gray-800">
                    <td className="p-2 text-xs text-gray-400">{new Date(b.createdAt).toLocaleString()}</td>
                    <td className="p-2 text-xs">{label(b.chain)}</td>
                    <td className="p-2">{b.kind}</td>
                    <td className="p-2 tabular-nums">{b.tokenId}</td>
                    <td className="p-2 tabular-nums">{b.nonce}</td>
                    <td className="p-2"><Badge tone={b.status === 'confirmed' ? 'success' : b.status === 'failed' ? 'danger' : 'info'}>{b.status}</Badge></td>
                    <td className="p-2 tabular-nums">{b.attempts}</td>
                    <td className="p-2">{b.txUrl ? <a href={b.txUrl} target="_blank" rel="noreferrer" className={link}>Polygonscan</a> : <span className="text-gray-500">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
