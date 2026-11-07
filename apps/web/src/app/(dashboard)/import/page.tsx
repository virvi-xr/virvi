'use client'
// Import: a Creator Hub or SDK7 scene folder (or its .zip) zipped in the browser, uploaded, built by Virvi with Virvi
// added, then deployed to the World its scene.json names. Open to every plan.
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import { SCENE_IMPORT_MAX_BYTES, type SceneImportView } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { signErrorMessage } from '@/lib/deploy'
import {
  buildLogShown, importThumbnailShown, virviNote, importErrorMessage, importFailure, importLines, importPhase, importViewError, PHASE_BADGES, placeLabel, recentImports, signerPhrase, SIGNERS_UNKNOWN_NOTE, watchImport,
} from '@/lib/import'
import { folderTooBig, scenePathMap, zipSceneFilesAsync } from '@/lib/import-zip'
import { jumpInUrl } from '@/lib/wizard/run'
import { DEPLOY_LINE, WALLET_PROMPT } from '@/lib/wizard/trial-deploy'
import { Badge, PageHeader, PrimaryButton, Skeleton } from '@/components/ui'
import { ProgressLines } from '@/components/wizard/ProgressLines'
import { useWorldSigning, type SigningDestination } from '@/components/dcl/useWorldSigning'
import { DownloadLiveButton } from '@/components/dcl/DownloadLiveButton'
import { DownloadBackupButton } from '@/components/dcl/DownloadBackupButton'
import { ParcelGrantCard } from '@/components/dcl/ParcelGrantCard'
import { SceneThumbnail } from '../scenes/[sceneId]/SceneThumbnail'

const secondary = 'rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50'
const errorBox = 'rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300'
const infoBox = 'rounded-md border border-blue-900/60 bg-blue-950/40 px-3 py-2 text-blue-200'
const MAX_MB = SCENE_IMPORT_MAX_BYTES / 1024 / 1024

export default function ImportPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <ImportContent />
    </Suspense>
  )
}

type Sending = { step: 'zipping'; files: number } | { step: 'uploading' }
/** What the deploy route answered with, kept only on this page: the wallet signs `payload`. */
type Prepared = { deploymentId: string; payload: string }

function ImportContent() {
  const { token, user, loginWithWallet } = useAuth()
  const api = useApi()
  const router = useRouter()
  const id = useSearchParams().get('id') ?? ''
  const [view, setView] = useState<SceneImportView | null>(null)
  const [sending, setSending] = useState<Sending | null>(null)
  const [uploadError, setUploadError] = useState<{ message: string; importId: string | null } | null>(null)
  const [watchError, setWatchError] = useState<string | null>(null)
  const [watchKey, setWatchKey] = useState(0)
  const [busy, setBusy] = useState<null | 'connect' | 'deploy' | 'sign'>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [dest, setDest] = useState<(SigningDestination & { kind?: 'world' | 'parcels'; ownerWallet: string }) | null>(null)
  const signing = useWorldSigning(dest)

  // Follow the import in the URL until it is live or failed (a reload picks it up again)
  useEffect(() => {
    if (!token || !id) return
    let cancelled = false
    setWatchError(null)
    watchImport(id, { api, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), cancelled: () => cancelled }, (v) => {
      if (!cancelled) setView(v)
    }).catch((err) => { if (!cancelled) setWatchError(importFailure(err).message) })
    return () => { cancelled = true }
  }, [token, id, watchKey])

  // An action's error belongs to the step it was made in
  useEffect(() => { setActionError(null) }, [view?.status])

  useEffect(() => {
    if (!id) setView(null)
    setPrepared(null)
    setActionError(null)
  }, [id])

  const upload = async (zip: Blob) => {
    if (zip.size > SCENE_IMPORT_MAX_BYTES) {
      setSending(null)
      setUploadError({ message: `The zip is larger than ${MAX_MB} MB. Remove large files the scene doesn't use, then try again.`, importId: null })
      return
    }
    setSending({ step: 'uploading' })
    try {
      const { import: made } = await api.uploadSceneImport(zip)
      setView(made)
      router.replace(`/import/?id=${made.id}`)
    } catch (err) {
      setUploadError(importFailure(err))
    }
    setSending(null)
  }

  /** A new pick starts over: the page leaves the import it showed. */
  const startOver = () => {
    setUploadError(null)
    setView(null)
    if (id) router.replace('/import/')
  }

  const pickFolder = async (files: File[]) => {
    if (!files.length) return
    startOver()
    const pathOf = (f: File) => f.webkitRelativePath || f.name
    const kept = scenePathMap(files.map(pathOf))
    if (![...kept.values()].includes('scene.json')) {
      setUploadError({ message: "There's no scene.json in that folder. Pick the scene's own folder, the one with scene.json in it.", importId: null })
      return
    }
    // node_modules/ and the like are never read, let alone uploaded
    const reading = files.filter((f) => kept.has(pathOf(f)))
    const tooBig = folderTooBig(reading)
    if (tooBig) {
      setUploadError({ message: tooBig, importId: null })
      return
    }
    setSending({ step: 'zipping', files: reading.length })
    try {
      const zip = await zipSceneFilesAsync(await Promise.all(reading.map(async (f) => ({ path: pathOf(f), bytes: new Uint8Array(await f.arrayBuffer()) }))))
      await upload(new Blob([zip as BlobPart], { type: 'application/zip' }))
    } catch {
      setSending(null)
      setUploadError({ message: "The folder couldn't be read. Try again, or zip it yourself and choose the .zip.", importId: null })
    }
  }

  const pickZip = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    startOver()
    await upload(file)
  }

  /** Rulings R1, R3: a World without Virvi's permission waits for this; 200 means the wallet signs, 202 that Virvi deploys. */
  const deploy = async () => {
    if (!view) return
    setActionError(null)
    signing.reset()
    // A trial's sandbox import: the wallet signs in first (creating the account, or moving the trial into the wallet's own),
    // and the deploy claims the import for that account. This render's `api` still holds the trial's token: the server's
    // `401 trial_ended` sends it again as the account (Ruling R5).
    if (trialDeploy) {
      setBusy('connect')
      try {
        await loginWithWallet('deploy')
      } catch (err) {
        setActionError(importFailure(err).message)
        setBusy(null)
        return
      }
    }
    setBusy('deploy')
    try {
      const r = await api.deploySceneImport(view.id)
      if (r.payload) {
        setPrepared({ deploymentId: r.deployment.id, payload: r.payload })
        const destinationId = (r.deployment.destinationId as string | null | undefined) ?? view.destinationId
        if (destinationId) {
          const d = await api.getDclDestination(destinationId)
          setDest({ ...d.destination, kind: d.kind, signers: d.signers })
        }
      }
      setView(await api.getSceneImport(view.id).then((x) => x.import).catch(() => view))
      setWatchKey((k) => k + 1)
    } catch (err) {
      // Without the World there is nothing to sign with: start again rather than show a payload that can't be used
      setPrepared(null)
      setActionError(importFailure(err).message)
    }
    setBusy(null)
  }

  const sign = async () => {
    if (!prepared || !dest) return
    setBusy('sign')
    setActionError(null)
    try {
      const s = await signing.signer()
      await api.submitDeploySignature(prepared.deploymentId, s.sign(prepared.payload))
      setPrepared(null)
      setWatchKey((k) => k + 1)
    } catch (err) {
      setActionError((err as Error | null)?.name === 'WrongWalletError' ? signErrorMessage(err, dest) : importFailure(err).message)
    }
    setBusy(null)
  }

  const phase = view ? importPhase(view) : sending ? 'uploading' : null
  const trialDeploy = !!view?.sandbox && !!user?.trial
  const canSign = !!view && phase === 'sign' && !!prepared && prepared.deploymentId === view.deploymentId && !!dest
  const showPicker = !sending && (!id || phase === 'live' || phase === 'failed' || (!view && !!watchError))

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        crumbs={['Workspace', { label: 'Scenes', href: '/scenes' }, 'Import']}
        title="Import a scene"
        subtitle="Bring a scene you made in the Creator Hub or with the SDK7. Virvi builds it with Virvi added, then deploys it to the World or the Genesis City parcels named in its scene.json."
      />

      {id && !view && !watchError && <Skeleton rows={1} />}
      {watchError && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p className={errorBox} role="alert">{watchError}</p>
          <button type="button" onClick={() => setWatchKey((k) => k + 1)} className={secondary}>Check again</button>
        </div>
      )}

      {(view || sending) && (
        <div className="space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-5 text-sm">
          {view ? (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <a href={jumpInUrl(view.location)} target="_blank" rel="noreferrer" className="truncate text-base font-medium text-white hover:text-blue-300">{placeLabel(view.location)}</a>
                <p className="text-gray-400">{view.kind === 'creator-hub' ? 'Creator Hub scene' : 'SDK7 scene'}</p>
              </div>
              <PhaseBadge phase={phase!} />
            </div>
          ) : (
            <p className="text-base font-medium text-white">
              {sending?.step === 'zipping' ? `Zipping ${sending.files} ${sending.files === 1 ? 'file' : 'files'}…` : 'Uploading your scene…'}
            </p>
          )}

          <ProgressLines lines={importLines(phase!, view?.location ?? null, view ?? undefined)} />
          {view && virviNote(view) && <p className={infoBox}>{virviNote(view)}</p>}
          {view && importThumbnailShown(view) && (
            <ImportThumbnail view={view} onChanged={() => api.getSceneImport(view.id).then((x) => setView(x.import)).catch(() => {})} />
          )}

          {phase === 'uploading' && view && <p className="text-gray-400">Your scene is uploaded. Its build starts in a moment.</p>}
          {phase === 'building' && <p className="text-gray-400">Virvi is building your scene. This usually takes a minute or two.</p>}

          {phase === 'ready' && view && (
            <>
              {view.errorMessage && view.errorMessage !== actionError && <p className={errorBox} role="alert">{view.errorMessage}</p>}
              {trialDeploy ? (
                <p className="text-gray-400">Your scene is built. {DEPLOY_LINE}</p>
              ) : (
                <p className="text-gray-400">
                  Your scene is built. Deploy it to {placeLabel(view.location)}: unless Virvi deploys there for you, you sign once with{' '}
                  {signerPhrase(view.location)}. It goes live a minute or so later.
                </p>
              )}
              <PrimaryButton type="button" onClick={deploy} disabled={busy !== null}>
                {busy === 'connect' ? 'Check your wallet…' : busy === 'deploy' ? 'Preparing the deploy…' : trialDeploy ? 'Connect your wallet and deploy' : 'Deploy'}
              </PrimaryButton>
              {busy === 'connect' && <p className={infoBox} role="status">{WALLET_PROMPT}</p>}
            </>
          )}

          {phase === 'sign' && view && (canSign ? (
            <>
              <p className="text-gray-400">The deploy is ready. Sign it with {signerPhrase(view.location)} within the next few minutes.</p>
              {dest?.signers === null && <p className={infoBox}>{SIGNERS_UNKNOWN_NOTE}</p>}
              <PrimaryButton type="button" onClick={sign} disabled={busy !== null}>
                {busy === 'sign' ? 'Signing…' : 'Sign the deploy'}
              </PrimaryButton>
            </>
          ) : (
            <p className="text-gray-400">
              This deploy is waiting for a signature from an earlier visit. You can start it again here once that request runs out, within a few minutes.
            </p>
          ))}
          {signing.asking && view && (
            <p className={infoBox} role="status">Check your wallet: sign once with {signerPhrase(view.location)}.</p>
          )}

          {phase === 'deploying' && <p className="text-gray-400">Deploying to Decentraland. It is usually live within a minute.</p>}

          {phase === 'live' && view && (
            <>
              <p className="text-base font-medium text-green-200">Live in {placeLabel(view.location)}.</p>
              <div className="flex flex-wrap items-center gap-3">
                <a href={jumpInUrl(view.location)} target="_blank" rel="noreferrer"
                  className="clip-corner inline-flex items-center gap-1.5 bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover">
                  Jump in
                </a>
                {view.deploymentId && <DownloadLiveButton deploymentId={view.deploymentId} className={secondary} />}
                <DownloadBackupButton sceneId={view.sceneId} className={secondary} />
                <Link href={`/deploy?scene=${view.sceneId}`} className="text-blue-400 hover:text-blue-300">Open Deploy</Link>
              </div>
            </>
          )}

          {phase === 'failed' && view && (
            <>
              <p className={errorBox} role="alert">{importViewError(view)}</p>
              {buildLogShown(view) === 'log' && <BuildLog importId={view.id} tail={view.logTail} />}
              {buildLogShown(view) === 'expired' && <p className="text-gray-500">{importErrorMessage('files_expired')}</p>}
            </>
          )}

          {view && view.location.kind === 'parcels' && view.destinationId && (phase === 'ready' || phase === 'live' || phase === 'failed') && (
            <ParcelGrantCard destinationId={view.destinationId} onChanged={() => setWatchKey((k) => k + 1)} />
          )}

          {actionError && <p className={errorBox} role="alert">{actionError}</p>}
        </div>
      )}

      {uploadError && (
        <div className="space-y-3 text-sm">
          <p className={errorBox} role="alert">{uploadError.message}</p>
          {uploadError.importId && <BuildLog importId={uploadError.importId} tail={null} onDemand />}
        </div>
      )}

      {showPicker && <Picker onFolder={pickFolder} onZip={pickZip} again={!!view} />}

      {!id && !sending && <RecentImports />}
    </div>
  )
}

/** LIV-89: the thumbnail the import picked up from scene.json (or why not), with Replace opening LIV-88's upload. */
function ImportThumbnail({ view, onChanged }: { view: SceneImportView; onChanged: () => void }) {
  const api = useApi()
  const [replacing, setReplacing] = useState(false)
  const shown = importThumbnailShown(view)
  if (!shown) return null
  if (replacing) {
    return (
      <div className="space-y-2">
        <SceneThumbnail sceneId={view.sceneId} url={shown.url} source={view.thumbnail.source} openPicker api={api}
          onChange={() => { setReplacing(false); onChanged() }} />
        <button type="button" onClick={() => setReplacing(false)} className="text-sm text-gray-400 hover:text-gray-200">Close</button>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-start gap-3">
      {shown.url && <img src={shown.url} alt="Scene thumbnail" className="h-20 max-w-[160px] shrink-0 rounded border border-gray-700 object-contain" />}
      <div className="min-w-0 space-y-1.5">
        <p className="text-gray-200">{shown.label}</p>
        {shown.note && <p className="text-gray-400">{shown.note}</p>}
        <button type="button" onClick={() => setReplacing(true)} className={secondary}>{shown.action}</button>
      </div>
    </div>
  )
}

function PhaseBadge({ phase }: { phase: NonNullable<ReturnType<typeof importPhase>> }) {
  const [tone, label] = PHASE_BADGES[phase]
  return <Badge tone={tone}>{label}</Badge>
}

/** The creator's last 10 imports, so one left building or waiting for its deploy can be picked up again. */
function RecentImports() {
  const api = useApi()
  const { token } = useAuth()
  const [views, setViews] = useState<SceneImportView[] | null>(null)
  useEffect(() => {
    if (!token) return
    let cancelled = false
    api.listMySceneImports()
      .then((r) => { if (!cancelled) setViews(r.imports) })
      .catch(() => { if (!cancelled) setViews([]) })
    return () => { cancelled = true }
  }, [token])
  if (!views?.length) return null
  return (
    <div className="space-y-2 text-sm">
      <p className="text-base font-medium text-white">Your recent imports</p>
      <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800 bg-gray-900">
        {recentImports(views, new Date()).map((i) => (
          <li key={i.id}>
            <Link href={i.href} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 hover:bg-gray-800/60">
              <span className="min-w-0 truncate text-gray-200">{i.place}</span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-gray-500">{i.when}</span>
                <Badge tone={i.tone}>{i.label}</Badge>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The scene folder (the folder picker) or its .zip. */
function Picker({ onFolder, onZip, again }: { onFolder: (f: File[]) => void; onZip: (f: File[]) => void; again: boolean }) {
  const folder = useRef<HTMLInputElement>(null)
  // React has no prop for the folder picker's attribute
  useEffect(() => { folder.current?.setAttribute('webkitdirectory', '') }, [])
  // Copied before the input is cleared, so the same folder can be picked again
  const picked = (e: React.ChangeEvent<HTMLInputElement>, fn: (f: File[]) => void) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    fn(files)
  }
  return (
    <div className="space-y-4 rounded-lg border border-dashed border-gray-700 bg-gray-900 p-5 text-sm">
      <div>
        <p className="text-base font-medium text-white">{again ? 'Upload again' : 'Choose your scene'}</p>
        <p className="mt-1 text-gray-400">
          Pick the scene&apos;s folder, the one with scene.json in it, or a .zip of it (up to {MAX_MB} MB). Virvi zips the folder here
          and leaves node_modules, bin and .git on your computer.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className={again ? `${secondary} cursor-pointer` : 'clip-corner inline-flex cursor-pointer items-center gap-1.5 bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover'}>
          Choose the scene folder
          <input ref={folder} type="file" multiple className="sr-only" onChange={(e) => picked(e, onFolder)} />
        </label>
        <label className={`${secondary} cursor-pointer`}>
          Choose a .zip
          <input type="file" accept=".zip,application/zip" className="sr-only" onChange={(e) => picked(e, onZip)} />
        </label>
      </div>
    </div>
  )
}

/** The whole build log in a scrollable box; `onDemand` waits for a click (an upload that failed after making its import). */
function BuildLog({ importId, tail, onDemand = false }: { importId: string; tail: string | null; onDemand?: boolean }) {
  const api = useApi()
  const [wanted, setWanted] = useState(!onDemand)
  const [log, setLog] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'shown' | 'none'>('loading')

  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    setState('loading')
    api.getSceneImportLog(importId)
      .then((text) => { if (!cancelled) { setLog(text); setState('shown') } })
      // No stored log (or it can't be read): the view's tail, when it has one
      .catch(() => { if (!cancelled) { setLog(tail); setState(tail ? 'shown' : 'none') } })
    return () => { cancelled = true }
  }, [importId, wanted])

  if (!wanted) return <button type="button" onClick={() => setWanted(true)} className={secondary}>Show the build log</button>
  if (state === 'loading') return <p className="text-gray-500">Loading the build log…</p>
  if (state === 'none' || !log) return onDemand ? <p className="text-gray-500">There is no build log for this upload.</p> : null
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-gray-500">Build log</p>
      <pre className="max-h-96 overflow-auto whitespace-pre rounded-md border border-gray-800 bg-gray-950 p-3 font-mono text-xs leading-relaxed text-gray-300">{log}</pre>
    </div>
  )
}
