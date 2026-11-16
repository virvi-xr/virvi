'use client'
// The admin reissue queue (LIV-11): requests to move a person's BEATs off a compromised wallet, with the red flags,
// the account's wallet history, per-BEAT checks, review, the Safe files and their steps, withdraw, unlink and lift block.
import { useState } from 'react'
import { BEAT_REISSUE_NOTE_MAX, type BeatChain } from '@virvixr/shared'
import { CopyWallet } from '@/components/CopyWallet'
import { Badge, ConfirmAction, tableHeadBand } from '@/components/ui'
import {
  APPROVE_WARNING, FLAG_LABELS, REISSUE_STATUS_LABELS, REVIEW_WHY, SAFE_ORDER_NOTE, SAFE_STATE_NOTE, SAFE_STEPS, UNLINK_WARNING, WITHDRAW_WARNING,
  blockerLabel, chainLabel, itemStateLabel, linkedByLabel, lossLabel, requestChains, revocationNote,
  type AdminReissueFile, type AdminReissueRequest, type ProposedReissueFile, type SafeBatchPreview,
} from '@/lib/reissue'

const btn = 'rounded-md border border-gray-700 px-3 py-1.5 text-xs hover:border-gray-500 disabled:opacity-50'
const primary = 'rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50'
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—')

export interface ReissueActions {
  busy: boolean
  /** The signed-in admin's account id: an admin can't review (approve or reject) their own request. */
  me?: string
  approve: (r: AdminReissueRequest, note: string, wallets: { wallet: string; action: 'keep' | 'unlink' }[]) => void
  reject: (r: AdminReissueRequest, note: string) => void
  preview: (r: AdminReissueRequest, chain: BeatChain) => Promise<SafeBatchPreview | null>
  propose: (r: AdminReissueRequest, chain: BeatChain) => Promise<ProposedReissueFile[] | null>
  download: (r: AdminReissueRequest, f: AdminReissueFile) => void
  saveFile: (f: ProposedReissueFile) => void
  withdraw: (r: AdminReissueRequest, body: { fileId?: string; note?: string }) => void
  unlink: (r: AdminReissueRequest, wallet: string) => void
  liftBlock: (wallet: string, note: string) => void
}

/** The steps the Safe's signers follow, with the order rule. */
export function SafeSteps() {
  return (
    <div className="rounded-md border border-gray-700 bg-gray-950 p-3 text-sm text-gray-200">
      <p className="font-medium">For each file, in order:</p>
      <ol className="mt-1 list-decimal space-y-0.5 pl-5">{SAFE_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
      <p className="mt-2 text-gray-300">{SAFE_ORDER_NOTE}</p>
      <p className="mt-1 text-gray-400">{SAFE_STATE_NOTE}</p>
    </div>
  )
}

function NoteBox({ id, label, value, onChange, required }: { id: string; label: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-gray-400">{label}{required ? '' : ' (optional)'}</label>
      <textarea id={id} rows={2} maxLength={BEAT_REISSUE_NOTE_MAX} value={value} onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400" />
    </div>
  )
}

/** Whether this is the signed-in admin's own request, which another admin has to review. */
const ownRequest = (r: AdminReissueRequest, a: ReissueActions) => !!a.me && r.account?.id === a.me

function Review({ r, a }: { r: AdminReissueRequest; a: ReissueActions }) {
  const [note, setNote] = useState('')
  const [choice, setChoice] = useState<Record<string, 'keep' | 'unlink'>>({})
  const decided = r.reviewWallets.every((w) => choice[w.wallet])
  if (ownRequest(r, a)) {
    return (
      <div className="space-y-1 border-t border-gray-800 pt-3">
        <h4 className="text-sm font-semibold">Review</h4>
        <p className="text-sm text-amber-200">This is your own request, so another admin has to approve or reject it. To drop it, cancel it in Settings, under Move BEATs, signed in with your email or your new wallet.</p>
      </div>
    )
  }
  return (
    <div className="space-y-3 border-t border-gray-800 pt-3">
      <h4 className="text-sm font-semibold">Review</h4>
      {r.reviewWallets.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm text-amber-200">Wallets to decide on: keep or unlink each one before approving.</legend>
          {r.reviewWallets.map((w) => (
            <div key={w.wallet} className="flex flex-wrap items-center gap-3 text-sm">
              <CopyWallet wallet={w.wallet} />
              <span className="text-xs text-gray-400">{REVIEW_WHY[w.why]} · linked {when(w.linkedAt)}, {linkedByLabel(w.linkedBy)}</span>
              {(['keep', 'unlink'] as const).map((act) => (
                <label key={act} className="inline-flex items-center gap-1 text-xs">
                  <input type="radio" name={`rw-${r.id}-${w.wallet}`} checked={choice[w.wallet] === act} onChange={() => setChoice((c) => ({ ...c, [w.wallet]: act }))} />
                  {act === 'keep' ? 'Keep' : 'Unlink and block'}
                </label>
              ))}
            </div>
          ))}
        </fieldset>
      )}
      <NoteBox id={`note-${r.id}`} label="Note to the person (they see it; required to reject)" value={note} onChange={setNote} required />
      <p className="text-xs text-amber-200">{APPROVE_WARNING}</p>
      <div className="flex flex-wrap gap-2">
        <ConfirmAction prompt={`Approve? ${APPROVE_WARNING}`} confirmLabel="Approve" danger={false} disabled={a.busy || !decided} className={primary}
          onConfirm={() => a.approve(r, note, r.reviewWallets.map((w) => ({ wallet: w.wallet, action: choice[w.wallet] })))}>
          Approve
        </ConfirmAction>
        <ConfirmAction prompt="Reject this request? The person sees your note." confirmLabel="Reject" disabled={a.busy || !note.trim()} className={btn}
          onConfirm={() => a.reject(r, note)}>
          Reject
        </ConfirmAction>
      </div>
      {!decided && <p className="text-xs text-gray-400">Choose keep or unlink for every wallet above to approve.</p>}
    </div>
  )
}

function SafeChain({ r, chain, a }: { r: AdminReissueRequest; chain: BeatChain; a: ReissueActions }) {
  const [preview, setPreview] = useState<SafeBatchPreview | null>(null)
  const [made, setMade] = useState<ProposedReissueFile[] | null>(null)
  const recorded = r.files.filter((f) => f.chain === chain)
  return (
    <div className="space-y-2 rounded-md border border-gray-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="text-sm font-semibold">{chainLabel(chain)}</h5>
        <button type="button" className={btn} disabled={a.busy} onClick={async () => setPreview(await a.preview(r, chain))}>Check what would be sent</button>
        <ConfirmAction prompt="Prepare the Safe files? This marks the request as being sent. Then give the files to the Safe's signers." confirmLabel="Prepare files" danger={false}
          disabled={a.busy} className={primary} onConfirm={async () => { const f = await a.propose(r, chain); if (f) setMade(f) }}>
          Prepare Safe files
        </ConfirmAction>
      </div>
      {preview && (
        <p className="text-xs text-gray-300">
          Now: {preview.files.length} {preview.files.length === 1 ? 'file' : 'files'} ({preview.files.map((f) => `${f.kind === 'plain' ? 'non-tradeable' : 'tradeable'}: ${f.tokenIds.join(', ')}`).join('; ') || 'nothing eligible'}).
        </p>
      )}
      {made && made.length > 0 && (
        <div className="space-y-2">
          <ul className="space-y-1 text-sm">
            {made.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2">
                <span>File {f.callIndex + 1} of {made.length}: {f.kind === 'plain' ? 'non-tradeable' : 'tradeable'} BEATs {f.tokenIds.join(', ')}</span>
                <button type="button" className={primary} onClick={() => a.saveFile(f)}>Download {f.filename}</button>
              </li>
            ))}
          </ul>
          <SafeSteps />
        </div>
      )}
      {recorded.length > 0 && (
        <table className="w-full text-xs">
          <thead className={tableHeadBand}><tr><th className="p-1">File</th><th className="p-1">BEATs</th><th className="p-1">Status</th><th className="p-1"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {recorded.map((f) => (
              <tr key={f.id} className="border-t border-gray-800">
                <td className="p-1">{f.callIndex + 1} ({f.kind === 'plain' ? 'non-tradeable' : 'tradeable'}) · {when(f.proposedAt)}</td>
                <td className="p-1 tabular-nums">{f.tokenIds.join(', ')}</td>
                <td className="p-1"><Badge tone={f.status === 'done' ? 'success' : f.status === 'voided' ? 'neutral' : 'info'}>{f.status === 'proposed' ? 'Waiting for the Safe' : f.status === 'done' ? 'Done' : 'Withdrawn'}</Badge></td>
                <td className="p-1 text-right">
                  {f.status !== 'voided' && <button type="button" className={btn} onClick={() => a.download(r, f)}>Download</button>}
                  {f.status === 'proposed' && (
                    <ConfirmAction prompt={`Withdraw this file? ${WITHDRAW_WARNING}`} confirmLabel="Withdraw file" disabled={a.busy} className={`${btn} ml-2`}
                      onConfirm={() => a.withdraw(r, { fileId: f.id })}>
                      Withdraw file
                    </ConfirmAction>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Wallets({ r, a }: { r: AdminReissueRequest; a: ReissueActions }) {
  const [lifting, setLifting] = useState<string | null>(null)
  const [note, setNote] = useState('')
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Wallets on this account, now and before</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className={tableHeadBand}><tr><th className="p-1">Wallet</th><th className="p-1">State</th><th className="p-1">Linked</th><th className="p-1">How</th><th className="p-1">Last sign-in</th><th className="p-1"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {r.wallets.map((w) => (
              <tr key={w.wallet} className="border-t border-gray-800">
                <td className="p-1"><CopyWallet wallet={w.wallet} />{w.wallet === r.oldWallet && <span className="ml-1 text-amber-200">old</span>}{w.wallet === r.newWallet && <span className="ml-1 text-green-300">new</span>}</td>
                <td className="p-1">{w.blocked ? <Badge tone="danger">Blocked</Badge> : w.linked ? 'Linked' : 'Removed'}</td>
                <td className="p-1">{when(w.linkedAt)}</td>
                <td className="p-1">{linkedByLabel(w.linkedBy)}</td>
                <td className="p-1">{when(w.lastSignInAt)}</td>
                <td className="p-1 text-right">
                  {w.linked && w.wallet !== r.newWallet && (
                    <ConfirmAction prompt={UNLINK_WARNING} confirmLabel="Unlink and block" disabled={a.busy} className={btn} onConfirm={() => a.unlink(r, w.wallet)}>Unlink</ConfirmAction>
                  )}
                  {w.blocked && <button type="button" className={`${btn} ml-2`} onClick={() => { setLifting(w.wallet); setNote('') }}>Lift block</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lifting && (
        <div className="space-y-2 rounded-md border border-gray-700 p-3">
          <p className="text-sm">Lift the block on {lifting}? It can sign in to Virvi again. Only do this when the wrong wallet was blocked.</p>
          <NoteBox id={`lift-${r.id}`} label="Why (kept on the account and the request)" value={note} onChange={setNote} required />
          <div className="flex gap-2">
            <button type="button" className={primary} disabled={a.busy || !note.trim()} onClick={() => { a.liftBlock(lifting, note); setLifting(null) }}>Lift block</button>
            <button type="button" className={btn} onClick={() => setLifting(null)}>Back</button>
          </div>
        </div>
      )}
      {r.walletEvents.length > 0 && (
        <ul className="text-xs text-gray-300">
          {r.walletEvents.map((e, i) => <li key={i}>{when(e.at)} · {e.event} · {e.wallet}{e.note ? ` · ${e.note}` : ''}</li>)}
        </ul>
      )}
    </div>
  )
}

export function ReissueRequestCard({ r, a }: { r: AdminReissueRequest; a: ReissueActions }) {
  const [withdrawNote, setWithdrawNote] = useState('')
  const revoked = revocationNote(r)
  const landedAlert = r.audit.filter((x) => x.action === 'voided_file_landed')
  const clash = r.flags.includes('clash') || r.beats.some((b) => b.state === 'clash')
  return (
    <article className="space-y-3 rounded-lg border border-gray-800 p-4 text-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">{r.account ? `${r.account.displayName}${r.account.email ? ` · ${r.account.email}` : ''}` : 'The person deleted their data'}</h3>
          <p className="text-xs text-gray-400">Asked {when(r.createdAt)}{r.reviewer ? ` · reviewed by ${r.reviewer.displayName}` : ''}{r.filedVia ? ` · ${linkedByLabel(r.filedVia)}` : ''}</p>
        </div>
        <Badge tone={r.status === 'done' ? 'success' : r.status === 'rejected' || r.status === 'withdrawn' ? 'neutral' : 'info'}>{REISSUE_STATUS_LABELS[r.status]}</Badge>
      </header>

      {clash && <p role="alert" className="rounded-md border border-red-700 bg-red-900/40 px-3 py-2 text-red-200">{FLAG_LABELS.clash}. Look at the claims, then withdraw the request.</p>}
      {landedAlert.map((x, i) => (
        <p key={i} role="alert" className="rounded-md border border-red-700 bg-red-900/40 px-3 py-2 text-red-200">
          A withdrawn Safe file went through anyway ({when(x.at)}). Virvi recorded it and moved the BEATs. {x.note ?? ''} Check the old wallet is blocked, and unlink it below if not.
        </p>
      ))}
      {r.flags.filter((f) => f !== 'clash').length > 0 && (
        <ul className="space-y-1">
          {r.flags.filter((f) => f !== 'clash').map((f) => <li key={f} className="rounded-md border border-amber-700 bg-amber-900/30 px-3 py-1 text-amber-200">Red flag: {FLAG_LABELS[f]}</li>)}
        </ul>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-gray-400">Old wallet</dt><dd><CopyWallet wallet={r.oldWallet} /></dd>
        <dt className="text-gray-400">New wallet</dt><dd><CopyWallet wallet={r.newWallet} /></dd>
        <dt className="text-gray-400">Lost or stolen</dt><dd>{lossLabel(r.loss)}</dd>
        <dt className="text-gray-400">Reason</dt><dd className="whitespace-pre-wrap">{r.reason ?? '(deleted)'}</dd>
        {r.reviewNote && <><dt className="text-gray-400">Note</dt><dd className="whitespace-pre-wrap">{r.reviewNote}</dd></>}
        <dt className="text-gray-400">Other sign-ins</dt>
        <dd>{[r.otherSignIns.email && 'email', r.otherSignIns.password && 'password', r.otherSignIns.oauth && 'Google or Discord'].filter(Boolean).join(', ') || 'None: wallets only'}</dd>
      </dl>
      {revoked && <p className="rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-gray-200">{revoked}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className={tableHeadBand}><tr><th className="p-1">BEAT</th><th className="p-1">Network</th><th className="p-1">Token</th><th className="p-1">Tradeable</th><th className="p-1">State</th><th className="p-1">Can move now?</th></tr></thead>
          <tbody>
            {r.beats.map((b) => (
              <tr key={`${b.chain}-${b.tokenId}`} className="border-t border-gray-800">
                <td className="p-1">{b.name}</td>
                <td className="p-1">{chainLabel(b.chain)}</td>
                <td className="p-1 tabular-nums">{b.tokenId}</td>
                <td className="p-1">{b.tradeable ? 'Yes' : 'No'}</td>
                <td className="p-1">{itemStateLabel(b.state)}{b.landed ? ' (on chain, confirming)' : ''}{b.txUrl && <> · <a href={b.txUrl} target="_blank" rel="noreferrer" className="text-blue-300 hover:underline">Polygonscan</a></>}</td>
                <td className="p-1">{b.eligible ? 'Yes' : b.blockers.length ? b.blockers.map(blockerLabel).join('; ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Wallets r={r} a={a} />

      {r.history.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold">Earlier requests from this account</h4>
          <ul className="text-xs text-gray-300">
            {r.history.map((h) => <li key={h.id}>{when(h.createdAt)} · {REISSUE_STATUS_LABELS[h.status]} · {h.oldWallet} → {h.newWallet}{h.cancelledVia ? ` · cancelled, ${linkedByLabel(h.cancelledVia)}` : ''}</li>)}
          </ul>
        </div>
      )}

      {r.audit.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-gray-400">History of this request ({r.audit.length})</summary>
          <ul className="mt-1 text-xs text-gray-300">{r.audit.map((x, i) => <li key={i}>{when(x.at)} · {x.action}{x.note ? ` · ${x.note}` : ''}</li>)}</ul>
        </details>
      )}

      {r.status === 'pending' && <Review r={r} a={a} />}

      {(r.status === 'approved' || r.status === 'proposed') && (
        <div className="space-y-3 border-t border-gray-800 pt-3">
          <h4 className="text-sm font-semibold">Send with the Safe</h4>
          {requestChains(r).map((c) => <SafeChain key={c} r={r} chain={c} a={a} />)}
          <div className="space-y-2">
            <NoteBox id={`withdraw-${r.id}`} label="Note to the person" value={withdrawNote} onChange={setWithdrawNote} />
            <p className="text-xs text-amber-200">{WITHDRAW_WARNING}</p>
            <ConfirmAction prompt={`Withdraw this request? ${WITHDRAW_WARNING}`} confirmLabel="Withdraw request" disabled={a.busy} className={btn}
              onConfirm={() => a.withdraw(r, withdrawNote.trim() ? { note: withdrawNote } : {})}>
              Withdraw request
            </ConfirmAction>
            {r.status === 'approved' && !ownRequest(r, a) && (
              <ConfirmAction prompt="Reject this approved request? This lifts the old wallet's block." confirmLabel="Reject" disabled={a.busy || !withdrawNote.trim()} className={`${btn} ml-2`}
                onConfirm={() => a.reject(r, withdrawNote)}>
                Reject (uses the note)
              </ConfirmAction>
            )}
          </div>
        </div>
      )}
    </article>
  )
}
