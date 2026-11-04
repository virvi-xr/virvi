'use client'
// /publish/?d=<destinationId>: the owner signs once and the models waiting go live (the in-world HUD links here).
// A World or Genesis City parcels: for parcels any of the `signers` the server names may sign.
import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useApi, type DclDestination, type DclPendingModel } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { destinationLocation, pendingLine, publishCopy, signErrorMessage } from '@/lib/deploy'
import { jumpInUrl, progressLines } from '@/lib/wizard/run'
import { PageHeader, PrimaryButton, Skeleton } from '@/components/ui'
import { ProgressLines, useShownPhase } from '@/components/wizard/ProgressLines'
import { useWorldSigning } from '@/components/dcl/useWorldSigning'

export default function PublishPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <PublishContent />
    </Suspense>
  )
}

function PublishContent() {
  const { token } = useAuth()
  const api = useApi()
  const id = useSearchParams().get('d') ?? ''
  const [dest, setDest] = useState<(DclDestination & { signers?: string[] | null }) | null>(null)
  const [pending, setPending] = useState<DclPendingModel[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const signing = useWorldSigning(dest)
  const { view } = signing
  const shownPhase = useShownPhase(view.phase)

  const load = () =>
    api.getDclDestination(id)
      // kind and signers as the server says: a parcels destination is signed by any wallet that controls every parcel
      .then((d) => { setDest({ ...d.destination, kind: d.kind, signers: d.signers }); setPending(d.pending) })
      .catch((err) => setLoadError(signErrorMessage(err, { ownerWallet: '', worldName: 'this place' })))

  useEffect(() => {
    if (!token) return
    if (!id) return setLoadError("This link doesn't say where to publish. Open it again from the in-world editor.")
    load()
  }, [token, id])

  const publish = async () => {
    if (await signing.deploy()) load()
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <PageHeader crumbs={['Tools', 'Publish']} title="Publish" />
        <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300" role="alert">{loadError}</p>
        <Link href="/deploy" className="text-sm text-blue-400 hover:text-blue-300">Open Deploy</Link>
      </div>
    )
  }
  if (!dest) return <Skeleton />

  const running = view.status === 'running'
  const live = view.status === 'done'
  const viaVirvi = dest.mode === 'virvi'
  const lines = progressLines(shownPhase, view.models, view.status === 'failed')
  const copy = publishCopy(dest)

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader crumbs={['Tools', 'Publish']} title={copy.place} subtitle={copy.subtitle} />

      <div className="space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-5 text-sm">
        {live ? (
          <p className="text-base font-medium text-green-200">Everything is live in {copy.place}.</p>
        ) : (
          <div>
            <p className="text-base font-medium text-white">{pendingLine(pending.length)}</p>
            {pending.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-gray-400">
                {pending.map((m) => <li key={m.elementId}>{m.name}</li>)}
              </ul>
            )}
          </div>
        )}

        {!live && (viaVirvi ? (
          dest.grantedAt ? (
            <p className="text-gray-400">Virvi deploys {copy.place} for you, so these go live on their own in a minute or two. You can also publish them now.</p>
          ) : (
            <p className="text-yellow-200">
              {copy.notSigned}{' '}
              <Link href={`/deploy?scene=${dest.sceneId}`} className="text-blue-300 hover:text-blue-200">Open Deploy</Link> to sign it or to sign each deploy instead.
            </p>
          )
        ) : (
          <p className="text-gray-400">
            {copy.signWith} Virvi keeps everything already in {copy.yours} as it is
            {pending.length > 0 ? ' and adds these models.' : ', so publishing again changes nothing you placed.'}
          </p>
        ))}

        {view.underway && <ProgressLines lines={lines} />}

        {signing.asking && (
          <p className="rounded-md border border-blue-900/60 bg-blue-950/40 px-3 py-2 text-blue-200" role="status">
            Check your wallet: sign once to authorise this deploy.
          </p>
        )}
        {view.error && <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300" role="alert">{view.error}</p>}

        {live ? (
          <div className="flex flex-wrap items-center gap-3">
            <a href={jumpInUrl(destinationLocation(dest))} target="_blank" rel="noreferrer"
              className="clip-corner inline-flex items-center gap-1.5 bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover">
              Jump in
            </a>
            <Link href={`/deploy?scene=${dest.sceneId}`} className="text-blue-400 hover:text-blue-300">Open Deploy</Link>
          </div>
        ) : (!viaVirvi || dest.grantedAt) && (
          <PrimaryButton type="button" onClick={publish} disabled={running}>
            {running ? 'Publishing…' : view.status === 'failed' ? 'Try again' : viaVirvi ? 'Publish now' : 'Sign and publish'}
          </PrimaryButton>
        )}
      </div>
    </div>
  )
}
