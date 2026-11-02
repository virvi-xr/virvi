'use client'
// One scene's Decentraland World on the deploy page: mode, status, models waiting, Redeploy now, the
// permission for Virvi, "Use the live version", and the deploy history.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useApi, type DclDeployment, type DclDestination, type DclPendingModel } from '@/lib/api'
import {
  deploymentStatusLabel, deploymentSummary, formatDateTime, modeLabel, pendingLine, signErrorMessage, statusView,
} from '@/lib/deploy'
import { errorCode, grantVirvi, jumpInUrl, progressLines, revokeVirvi } from '@/lib/wizard/run'
import { Badge, ConfirmAction } from '@/components/ui'
import { ProgressLines, useShownPhase } from '@/components/wizard/ProgressLines'
import { useWorldSigning } from './useWorldSigning'

interface Detail {
  /** Over the triangles Decentraland recommends: shown, never a stop. */
  warning: string | null
  pending: DclPendingModel[]
  refused: Array<{ name: string; reason: string }>
  lastDeployment: DclDeployment | null
}

const button = 'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50'
const secondary = 'rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50'

export function WorldDestinationCard({ destination, history, virviDeploys, offerGrant, onChanged }: {
  destination: DclDestination
  /** This destination's deployments, newest first. */
  history: DclDeployment[]
  /** Whether Virvi's deploy wallet is set up on the server. */
  virviDeploys: boolean
  /** Just adopted: offer the permission straight away. */
  offerGrant?: boolean
  /** Something changed (a deploy, the mode): the page reloads the history. */
  onChanged: (dest: DclDestination) => void
}) {
  const api = useApi()
  const [dest, setDest] = useState(destination)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [busy, setBusy] = useState<null | 'grant' | 'revoke' | 'rebase' | 'mode'>(null)
  const [error, setError] = useState<string | null>(null)
  /** grant_partial: Virvi may hold World-wide rights, so removing them is offered until it works. */
  const [partial, setPartial] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const signing = useWorldSigning(dest)
  const { view } = signing
  const shownPhase = useShownPhase(view.phase)

  const load = () =>
    api.getDclDestination(dest.id)
      .then((d) => {
        setDest(d.destination)
        setDetail({ pending: d.pending, refused: d.refused, lastDeployment: d.lastDeployment, warning: d.warning ?? null })
      })
      .catch((err) => setError(signErrorMessage(err, dest)))

  useEffect(() => { load() }, [dest.id])

  const changed = (next: DclDestination) => {
    setDest(next)
    onChanged(next)
    load()
  }

  const act = async (kind: NonNullable<typeof busy>, fn: () => Promise<DclDestination>, done: string) => {
    setBusy(kind)
    setError(null)
    setNotice(null)
    signing.reset()
    try {
      changed(await fn())
      setNotice(done)
      if (kind === 'revoke') setPartial(false)
    } catch (err) {
      if (errorCode(err) === 'grant_partial') setPartial(true)
      setError(signErrorMessage(err, dest))
    }
    setBusy(null)
  }

  const grant = () => act('grant', async () => grantVirvi(dest.id, await signing.signer(), api),
    `Virvi can deploy to ${dest.worldName} for you now. Models you add go live on their own a minute or two later.`)
  const revoke = () => act('revoke', async () => revokeVirvi(dest.id, await signing.signer(), api),
    `Virvi's permission is removed from ${dest.worldName}. From now on you sign each deploy.`)
  // Nothing was granted yet, so there is no permission to remove: just stop asking for one.
  const signEach = () => act('mode', async () => (await api.patchDclDestination(dest.id, { mode: 'sign' })).destination,
    'You sign each deploy from now on.')
  const rebase = () => act('rebase', async () => (await api.rebaseDclDestination(dest.id)).destination,
    "Virvi now builds on what's live in your World.")

  const redeploy = async () => {
    setError(null)
    setNotice(null)
    await signing.deploy()
    onChanged(dest)
    load()
  }

  const status = statusView(dest)
  const granted = dest.mode === 'virvi' && !!dest.grantedAt
  const running = view.status === 'running' || busy !== null
  const pending = detail?.pending.length ?? null
  const last = detail?.lastDeployment ?? history[0] ?? null
  const lines = progressLines(shownPhase, view.models, view.status === 'failed')

  return (
    <div className="space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-5 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <a href={jumpInUrl(dest.worldName)} target="_blank" rel="noreferrer" className="truncate text-base font-medium text-white hover:text-blue-300">{dest.worldName}</a>
          <p className="text-gray-400">{modeLabel(dest)}{dest.adopted ? ' · Your own Creator Hub scene' : ''}</p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      {status.line && <p className={status.tone === 'danger' ? 'text-red-300' : 'text-yellow-200'}>{status.line}</p>}
      {detail?.warning && <p className="text-yellow-200">{detail.warning}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs text-gray-500">Models</p>
          <p className="text-gray-200">{pending === null ? '…' : pendingLine(pending)}</p>
          {pending !== null && pending > 0 && (
            <p className="mt-0.5 text-xs text-gray-500">{detail!.pending.map((m) => m.name).join(', ')}</p>
          )}
        </div>
        <div>
          <p className="text-xs text-gray-500">Last deploy</p>
          <p className="text-gray-200">
            {last ? `${deploymentStatusLabel(last.status)} · ${formatDateTime(last.deployedAt ?? last.createdAt)}` : 'Not deployed by Virvi yet'}
          </p>
        </div>
      </div>

      {detail && detail.refused.length > 0 && (
        <div className="text-yellow-200">
          <p>Left out of the last deploy:</p>
          <ul className="list-disc pl-5">
            {detail.refused.map((r) => <li key={r.name}>{r.name}: {r.reason}</li>)}
          </ul>
        </div>
      )}

      {offerGrant && dest.mode === 'sign' && virviDeploys && !notice && (
        <div className="rounded-md border border-blue-500/40 bg-blue-950/30 p-3 text-blue-100">
          <p className="font-medium">{dest.worldName} is connected.</p>
          <p className="mt-1 text-blue-200/80">
            Let Virvi deploy for you and models you add in-world go live on their own: you sign one free request, and your scene&apos;s code
            and files stay as they are. Or keep signing each deploy yourself.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {dest.mode === 'sign' ? (
          <Link href={`/publish/?d=${dest.id}`} className={button}>Redeploy now</Link>
        ) : granted ? (
          <button type="button" onClick={redeploy} disabled={running} className={button}>
            {view.status === 'running' ? 'Deploying…' : 'Redeploy now'}
          </button>
        ) : null}
        {virviDeploys && !granted && (
          <button type="button" onClick={grant} disabled={running} className={dest.mode === 'sign' ? secondary : button}>
            {busy === 'grant' ? 'Working…' : 'Let Virvi deploy for me'}
          </button>
        )}
        {dest.mode === 'virvi' && !granted && (
          <button type="button" onClick={signEach} disabled={running} className={secondary}>Sign each deploy instead</button>
        )}
        {(granted || partial) && (
          <ConfirmAction
            disabled={running}
            danger={false}
            confirmLabel="Sign to switch"
            prompt={`Remove Virvi's permission on ${dest.worldName}? You sign once now, then each deploy yourself.`}
            onConfirm={revoke}
            className={secondary}
          >
            {busy === 'revoke' ? 'Working…' : granted ? 'Switch to signing each deploy' : "Remove Virvi's permission"}
          </ConfirmAction>
        )}
        {dest.status === 'needs_review' && (
          <ConfirmAction
            disabled={running}
            danger={false}
            confirmLabel="Use it"
            prompt={`Keep what's live in ${dest.worldName} now, and add Virvi's models on top of it from here on?`}
            onConfirm={rebase}
            className={secondary}
          >
            Use the live version
          </ConfirmAction>
        )}
      </div>

      {view.underway && <ProgressLines lines={lines} />}
      {signing.asking && (
        <p className="rounded-md border border-blue-900/60 bg-blue-950/40 px-3 py-2 text-blue-200" role="status">
          Check your wallet: sign once with the wallet that owns {dest.worldName}.
        </p>
      )}
      {view.status === 'done' && <p className="text-green-300">Live in {dest.worldName}.</p>}
      {(error || view.error) && <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300" role="alert">{error ?? view.error}</p>}
      {notice && <p className="rounded-md border border-blue-900/60 bg-blue-950/40 px-3 py-2 text-blue-200" role="status">{notice}</p>}

      {history.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer select-none text-gray-400 hover:text-white">Deploy history ({history.length})</summary>
          <ul className="mt-2 divide-y divide-gray-800 rounded-md border border-gray-800">
            {history.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                <span className={d.status === 'failed' ? 'text-red-300' : d.status === 'deployed' ? 'text-gray-200' : 'text-yellow-200'}>
                  {deploymentStatusLabel(d.status)}
                  {deploymentSummary(d) && <span className="text-gray-500"> · {deploymentSummary(d)}</span>}
                </span>
                <span className="text-xs text-gray-500">{formatDateTime(d.deployedAt ?? d.createdAt)}</span>
                {d.errorMessage && <p className="w-full text-xs text-red-300">{d.errorMessage}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** A Creator Hub `@virvixr/dcl` scene set up in-world for this scene, with no destination yet. */
export function AdoptWorldCard({ world, sceneId, onAdopted }: { world: string; sceneId: string; onAdopted: (dest: DclDestination) => void }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const adopt = async () => {
    setBusy(true)
    setError(null)
    try {
      // No plot: the destination takes the live scene's parcels and files, and its code is never touched.
      const { destination } = await api.createDclDestination({ sceneId, world, mode: 'sign' })
      onAdopted(destination)
    } catch (err) {
      setError(signErrorMessage(err, { ownerWallet: '', worldName: world }))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-gray-700 bg-gray-900 p-5 text-sm">
      <p className="text-base font-medium text-white">{world}</p>
      <p className="text-gray-400">
        This scene runs in {world} through your own Creator Hub scene. Turn on Virvi deploys and models you add in-world can go live
        without you rebuilding or downloading anything: Virvi adds them to what&apos;s live and leaves your code as it is.
      </p>
      {error && <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300" role="alert">{error}</p>}
      <button type="button" onClick={adopt} disabled={busy} className={button}>
        {busy ? 'Connecting…' : `Turn on Virvi deploys for ${world}`}
      </button>
    </div>
  )
}
