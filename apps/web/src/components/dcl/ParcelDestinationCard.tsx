'use client'
// One scene's Genesis City parcels destination on the deploy page: status, last deploy, Redeploy now (signed in the
// browser by an owner or operator, or by Virvi once it is an operator), "Use the live version", signing each deploy
// yourself again (free), and the optional operator grant.
import { useEffect, useState } from 'react'
import { useApi, type DclDeployment, type DclDestination } from '@/lib/api'
import { deploymentStatusLabel, destinationLocation, formatDateTime, modeLabel, signErrorMessage, statusView } from '@/lib/deploy'
import { placeLabel, SIGNERS_UNKNOWN_NOTE } from '@/lib/import'
import { jumpInUrl, progressLines } from '@/lib/wizard/run'
import { Badge, ConfirmAction } from '@/components/ui'
import { ProgressLines, useShownPhase } from '@/components/wizard/ProgressLines'
import { useWorldSigning } from './useWorldSigning'
import { DownloadLiveButton } from './DownloadLiveButton'
import { DownloadBackupButton } from './DownloadBackupButton'
import { ParcelGrantCard } from './ParcelGrantCard'

const button = 'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50'
const secondary = 'rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50'

export function ParcelDestinationCard({ destination, history, onChanged }: {
  destination: DclDestination
  /** This destination's deployments, newest first. */
  history: DclDeployment[]
  onChanged: (dest: DclDestination) => void
}) {
  const api = useApi()
  const [dest, setDest] = useState(destination)
  const [signers, setSigners] = useState<string[] | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'rebase' | 'mode'>(null)
  /** Bumped to make the grant card read the rights again after the mode changed here. */
  const [grantKey, setGrantKey] = useState(0)
  const signing = useWorldSigning({ ...dest, signers })
  const { view } = signing
  const shownPhase = useShownPhase(view.phase)

  const load = () =>
    api.getDclDestination(dest.id)
      .then((d) => { setDest(d.destination); setSigners(d.signers) })
      .catch((err) => setError(signErrorMessage(err, { ...dest, kind: 'parcels' })))
  useEffect(() => { load() }, [dest.id])

  const loc = destinationLocation(dest)
  const status = statusView(dest)
  const last = history[0] ?? null
  const redeploying = view.status === 'running'
  const running = redeploying || busy !== null
  const active = dest.mode === 'virvi' && !!dest.grantedAt

  const act = async (kind: NonNullable<typeof busy>, fn: () => Promise<{ destination: DclDestination; message?: string }>, done: string) => {
    setBusy(kind)
    setError(null)
    setNotice(null)
    signing.reset()
    try {
      const r = await fn()
      setDest(r.destination)
      onChanged(r.destination)
      setNotice(r.message ?? done)
      setGrantKey((k) => k + 1)
      load()
    } catch (err) {
      setError(signErrorMessage(err, { ...dest, kind: 'parcels' }))
    }
    setBusy(null)
  }
  // Free: Virvi stays an operator on-chain (removing that is the grant card's transaction), it just stops deploying
  const signEach = () => act('mode', () => api.patchDclDestination(dest.id, { mode: 'sign' }), 'You sign each deploy from now on.')
  const rebase = () => act('rebase', () => api.rebaseDclDestination(dest.id), "Virvi now builds on what's live on your parcels.")

  const redeploy = async () => {
    setError(null)
    setNotice(null)
    // Signers are read before the wallet is asked, so the right wallets are accepted
    await signing.deploy()
    onChanged(dest)
    load()
  }

  return (
    <div className="space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-5 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <a href={jumpInUrl(loc)} target="_blank" rel="noreferrer" className="truncate text-base font-medium text-white hover:text-blue-300">{placeLabel(loc)}</a>
          <p className="text-gray-400">{modeLabel(dest)}</p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      {status.line && <p className={status.tone === 'danger' ? 'text-red-300' : 'text-yellow-200'}>{status.line}</p>}

      <div>
        <p className="text-xs text-gray-500">Last deploy</p>
        <p className="text-gray-200">
          {last ? `${deploymentStatusLabel(last.status)} · ${formatDateTime(last.deployedAt ?? last.createdAt)}` : 'Not deployed by Virvi yet'}
        </p>
        {last?.status === 'deployed' && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            <DownloadLiveButton deploymentId={last.id} className={secondary} />
            <DownloadBackupButton sceneId={dest.sceneId} destinationId={dest.id} className={secondary} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={redeploy} disabled={running} className={button}>
          {redeploying ? 'Deploying…' : 'Redeploy now'}
        </button>
        {active && (
          <button type="button" onClick={signEach} disabled={running} className={secondary}>
            {busy === 'mode' ? 'Working…' : 'Sign each deploy myself'}
          </button>
        )}
        {dest.status === 'needs_review' && (
          <ConfirmAction
            disabled={running}
            danger={false}
            confirmLabel="Use it"
            prompt={`Keep what's live on ${placeLabel(loc)} now, and add Virvi's models on top of it from here on?`}
            onConfirm={rebase}
            className={secondary}
          >
            Use the live version
          </ConfirmAction>
        )}
      </div>
      {signers === null && <p className="text-yellow-200">{SIGNERS_UNKNOWN_NOTE}</p>}

      {view.underway && <ProgressLines lines={progressLines(shownPhase, view.models, view.status === 'failed')} />}
      {signing.asking && (
        <p className="rounded-md border border-blue-900/60 bg-blue-950/40 px-3 py-2 text-blue-200" role="status">
          Check your wallet: sign once with the wallet that owns or operates these parcels.
        </p>
      )}
      {view.status === 'done' && <p className="text-green-300">Live in {placeLabel(loc)}.</p>}
      {notice && <p className="rounded-md border border-blue-900/60 bg-blue-950/40 px-3 py-2 text-blue-200" role="status">{notice}</p>}
      {(error || view.error) && <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300" role="alert">{error ?? view.error}</p>}

      <ParcelGrantCard key={grantKey} destinationId={dest.id} onChanged={() => { load(); onChanged(dest) }} />
    </div>
  )
}
