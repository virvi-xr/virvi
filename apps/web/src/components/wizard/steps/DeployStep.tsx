'use client'
import { useEffect, useRef, useState, type Dispatch } from 'react'
import Link from 'next/link'
import { plotParcels } from '@virvixr/shared'
import { fetchDclNames, useApi, type DclDeployment, type DclWorld, type WizardOptions } from '@/lib/api'
import { getBrowserWallet, useAuth } from '@/lib/auth'
import { API_URL } from '@/lib/config'
import { connectExtras, jumpInUrl, progressLines, runWizard, wizardErrorMessage, type Phase, type RunMemory, type RunPlan, type RunUpdate } from '@/lib/wizard/run'
import { effectivePlot, type WizardAction, type WizardState } from '@/lib/wizard/state'
import { connectForDeploy, connectOutcome, DEPLOY_LINE, deployGate, noWorldMessage, WALLET_PROMPT, type WalletNames } from '@/lib/wizard/trial-deploy'
import { shortAddress } from '@/lib/wizard/helpers'
import { Badge, PrimaryButton } from '@/components/ui'
import { CONTRACT_WALLET_MESSAGE, type NamesState } from './WhereStep'
import { ProgressLines, useShownPhase } from '../ProgressLines'
import { ROOM_LAYOUT_NOTICE } from '@/lib/room-set'

/** The server keeps a storefront sign to this many characters. */
const SIGN_TEXT_MAX = 80

const MODE_COPY = {
  virvi: {
    title: 'Let Virvi deploy for me (recommended)',
    line: "You sign one free request that lets Virvi deploy to this scene's parcels in your World. Virvi deploys now, and again on its own when you add a model in-world. You can remove the permission anytime.",
  },
  sign: {
    title: "I'll sign each deploy",
    line: "Like the Creator Hub: your wallet signs every deploy. Virvi never holds anything that can deploy for you later; new models wait as ready to publish until you sign.",
  },
} as const

/** The Hyperfy app's setup, in Virvi's name (the deploy page's older copy says Virvi). The file is still virvi.hyp. */
function hyperfySetupSteps(feedUrl: string): string[] {
  return [
    'Download the Virvi app and drag virvi.hyp into your Hyperfy world.',
    "Open the app's settings and paste your world key into its world key field.",
    `Leave the feed URL as ${feedUrl} unless Virvi support tells you otherwise.`,
    'Your scene appears within a few seconds and follows your edits.',
  ]
}

interface View {
  status: 'idle' | 'running' | 'failed' | 'done'
  phase: Phase
  models: number | null
  wallet: RunUpdate['wallet']
  deployment: DclDeployment | null
  error: string | null
  /** grant_partial: Virvi may hold World-wide rights. Stays on screen until a later run succeeds. */
  partial: string | null
  hyperfyError: string | null
  arError: string | null
}

const idle: View = { status: 'idle', phase: 'packing', models: null, wallet: null, deployment: null, error: null, partial: null, hyperfyError: null, arError: null }

export function DeployStep({ state, dispatch, options, memory, onRunning, names }: {
  state: WizardState
  dispatch: Dispatch<WizardAction>
  options: WizardOptions | null
  memory: RunMemory
  /** The page keeps the earlier steps closed while a run is going and once the scene exists. */
  onRunning: (running: boolean) => void
  /** The account's Worlds (the page's lookup), for an account that carried a trial's "Decentraland World" here. */
  names: NamesState
}) {
  const api = useApi()
  const { user, loginWithWallet } = useAuth()
  const trial = !!user?.trial
  const [view, setView] = useState<View>(idle)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  const { dcl, hyperfy, ar } = state.destinations
  const virviOk = !!options?.dcl.virviDeploys

  // Set on every mount: React's dev Strict Mode unmounts and remounts once.
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    if (options && !virviOk && state.mode !== 'sign') dispatch({ type: 'setMode', mode: 'sign' })
  }, [options, virviOk])

  // A trial that chose Decentraland signs in with its wallet here; an account carrying that choice picks the World
  const gate = deployGate({ trial, dclLater: state.dclLater, dcl })
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  /** The Worlds of the account the wallet sign-in made (the page's lookup catches up after it re-renders). */
  const [connected, setConnected] = useState<WalletNames | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const [contractBlocked, setContractBlocked] = useState(false)
  // A World picked here that has a scene is replaced only once that's confirmed, as on Where
  const [pickedHere, setPickedHere] = useState(false)
  const [replaceOk, setReplaceOk] = useState(false)

  const atLimit = !memory.sceneId && !!options && options.scenes.limit !== null && options.scenes.used >= options.scenes.limit
  const running = view.status === 'running'
  const done = view.status === 'done'
  const plot = effectivePlot(state)
  const oldParcels = dcl?.footprint?.parcels.length ?? 0
  const coversMore = !!dcl?.hasScene && oldParcels > plotParcels(plot).length

  const makePlan = (): RunPlan => ({
      name: state.name.trim(),
      plot,
      spawn: state.spawn,
      items: state.items.map((i) => ({ assetId: i.asset.id, x: i.x, z: i.z, rotationY: i.rotationY })),
      dcl: dcl ? { world: dcl.world, wallet: dcl.wallet, mode: state.mode } : null,
      hyperfy: hyperfy ? { kind: hyperfy.kind, name: hyperfy.name.trim() } : null,
      ar: ar ? { name: ar.name.trim() } : null,
      // A storefront's sign shows the scene's name.
      roomSet: state.roomSet && {
        scanId: state.roomSet.scanId,
        options: state.roomSet.options.style === 'storefront'
          ? { ...state.roomSet.options, signText: state.name.trim().slice(0, SIGN_TEXT_MAX) }
          : state.roomSet.options,
      },
  })
  const update = (u: RunUpdate) => {
    if (!alive.current) return
    setView((v) => ({ ...v, ...u, deployment: u.deployment ?? v.deployment }))
  }

  const start = async () => {
    const plan = makePlan()
    onRunning(true)
    setView((v) => ({ ...v, status: 'running', error: null, phase: 'packing' }))
    try {
      await runWizard(plan, memory, {
        // A trial's save opens the sign-up sheet, which names the scene
        api: { ...api, bootstrapWizardScene: (data) => api.bootstrapWizardScene(data, { sceneName: plan.name }) },
        wallet: getBrowserWallet,
        startSession: async (wallet, opts) => (await import('@/lib/dcl-sign')).startSignSession(wallet, opts),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        cancelled: () => !alive.current,
      }, update)
      if (alive.current) setView((v) => ({ ...v, status: 'done', phase: 'live', partial: null }))
    } catch (err) {
      const e = err as { message?: string; partial?: boolean }
      if (!alive.current) return
      setView((v) => ({
        ...v,
        status: 'failed',
        wallet: null,
        error: e.partial ? null : e.message ?? 'Something went wrong. Try again in a moment.',
        partial: e.partial ? e.message ?? null : v.partial,
      }))
    } finally {
      onRunning(false)
    }
  }

  /** Uses a World from the account's list; a contract wallet can't sign World deploys (the same check as Where's). */
  const pick = async (world: DclWorld, wallet: string): Promise<boolean> => {
    setReplaceOk(false)
    setContractBlocked(false)
    setChecking(world.world)
    const provider = getBrowserWallet()
    let contract = false
    if (provider && wallet) {
      try {
        contract = await (await import('@/lib/dcl-sign')).isContractWallet(provider, wallet)
      } catch {
        // The check is a courtesy; Decentraland's own answer comes at deploy.
      }
    }
    if (!alive.current) return false
    setChecking(null)
    if (contract) {
      setContractBlocked(true)
      return false
    }
    setPickedHere(true)
    dispatch({ type: 'setDcl', dcl: { world: world.world, wallet, hasScene: world.hasScene, footprint: world.footprint, storage: world.storage ?? undefined } })
    return true
  }

  /** Deploy, trial: the wallet signs in (creating the account, or moving the trial into its own), then the World is chosen. */
  const connect = async () => {
    setConnecting(true)
    setConnectError(null)
    try {
      const { wallets } = await connectForDeploy({ loginWithWallet, names: fetchDclNames })
      if (!alive.current) return
      setConnected(wallets)
      // The lone empty World is filled in and the step stops there: the deploy mode and Create and deploy are the user's
      const out = connectOutcome(wallets)
      if (out.kind === 'picked') await pick(out.world, out.wallet)
    } catch (err) {
      if (alive.current) setConnectError(wizardErrorMessage(err))
    } finally {
      if (alive.current) setConnecting(false)
    }
  }

  const pickList = connected ?? (names.status === 'ready' ? names.wallets : null)
  const listed = (pickList ?? []).flatMap((w) => w.names.map((n) => ({ ...n, wallet: w.address })))
  const noWorld = connected ? noWorldMessage(connected) : null
  const confirmPending = pickedHere && !!dcl?.hasScene && !replaceOk

  const [retrying, setRetrying] = useState(false)
  const retryExtras = async () => {
    setRetrying(true)
    await connectExtras(makePlan(), memory, api, update)
    if (alive.current) setRetrying(false)
  }
  const extrasFailed = done && ((!!hyperfy && !memory.hyperfy) || (!!ar && !memory.ar))

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked: the key is still visible to select
    }
  }

  const shownPhase = useShownPhase(view.phase)
  const lines = progressLines(shownPhase, view.models, view.status === 'failed')
  const live = done && (!dcl || view.deployment?.status === 'deployed')
  const started = view.status !== 'idle'
  // Until the scene exists its name can change; the deploy mode can change again after a failure.
  const nameEditable = !running && !memory.sceneId
  const modeEditable = view.status === 'idle' || view.status === 'failed'

  return (
    <div className="space-y-4 text-sm">
      {nameEditable && (
          <label className="block space-y-1">
            <span className="text-gray-300">Scene name</span>
            <input value={state.name} onChange={(e) => dispatch({ type: 'setName', name: e.target.value })} maxLength={120}
              placeholder="Name your scene" required
              className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400" />
          </label>
      )}

      {modeEditable && dcl && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-gray-300">How should Virvi deploy to {dcl.world}?</legend>
              {(virviOk ? (['virvi', 'sign'] as const) : (['sign'] as const)).map((mode) => (
                <label key={mode} className={`flex cursor-pointer gap-3 rounded-md border px-3 py-2.5 ${state.mode === mode ? 'border-blue-400 bg-blue-400/10' : 'border-gray-800 bg-gray-950 hover:border-gray-700'}`}>
                  <input type="radio" name="deploy-mode" className="mt-1" checked={state.mode === mode} onChange={() => dispatch({ type: 'setMode', mode })} />
                  <span>
                    <span className="block font-medium text-white">{MODE_COPY[mode].title}</span>
                    <span className="block text-gray-400">{MODE_COPY[mode].line}</span>
                  </span>
                </label>
              ))}
              {options && !virviOk && (
                <p className="text-gray-500">Virvi can&apos;t deploy on your behalf right now, so you&apos;ll sign each deploy yourself.</p>
              )}
              {state.mode === 'virvi' && coversMore && (
                <p className="text-yellow-200">Your World&apos;s current scene covers {oldParcels} parcels, so Virvi needs permission on those to replace it.</p>
              )}
            </fieldset>
      )}

      {atLimit && (
            <p className="rounded-md border border-yellow-700/60 bg-yellow-950/30 px-3 py-2 text-yellow-100">
              Your plan allows {options!.scenes.limit} scenes and you have {options!.scenes.used}.{' '}
              <Link href="/settings" className="text-blue-300 hover:text-blue-200">Upgrade</Link> or remove a scene to make this one.
            </p>
      )}

      {view.partial && (
        <div className="rounded-md border-2 border-red-500 bg-red-950/50 px-4 py-3 text-red-100" role="alert">
          <p className="font-semibold">Check your World&apos;s permissions</p>
          <p className="mt-1">{view.partial}</p>
          <Link href="/deploy" className="mt-2 inline-block text-red-200 underline hover:text-white">Open Deploy</Link>
        </div>
      )}

      {started && dcl && <ProgressLines lines={lines} />}
      {started && !dcl && running && <p className="text-gray-300">Creating your scene…</p>}

      {view.wallet && (
        <p className="rounded-md border border-blue-900/60 bg-blue-950/40 px-3 py-2 text-blue-200" role="status">
          {view.wallet === 'grant'
            ? 'Check your wallet: sign once to let Virvi deploy to this World.'
            : 'Check your wallet: sign once to authorise this deploy.'}
        </p>
      )}

      {!done && state.roomSet && (dcl || hyperfy) && (
        <p className="rounded-md border border-yellow-700/60 bg-yellow-950/30 px-3 py-2 text-yellow-100">{ROOM_LAYOUT_NOTICE}</p>
      )}

      {view.error && <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300" role="alert">{view.error}</p>}

      {gate === 'wallet' && !done && (
        <div className="space-y-2">
          <p className="text-gray-300">{DEPLOY_LINE}</p>
          <PrimaryButton type="button" onClick={connect} disabled={connecting || running || !state.name.trim()}>
            {connecting ? 'Check your wallet…' : 'Connect your wallet'}
          </PrimaryButton>
        </div>
      )}
      {connecting && <p className="rounded-md border border-blue-900/60 bg-blue-950/40 px-3 py-2 text-blue-200" role="status">{WALLET_PROMPT}</p>}
      {connectError && <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300" role="alert">{connectError}</p>}

      {gate === 'world' && !done && (
        <section className="space-y-2">
          <p className="text-gray-300">Pick the Decentraland World for this scene.</p>
          {noWorld ? (
            <p className="rounded-md border border-yellow-700/60 bg-yellow-950/30 px-3 py-2 text-yellow-100" role="status">{noWorld}</p>
          ) : pickList === null ? (
            names.status === 'error'
              ? <p className="text-red-300" role="alert">{names.message}</p>
              : <p className="text-gray-500">Looking up your names…</p>
          ) : listed.length === 0 ? (
            <p className="text-gray-400">Your linked wallets don&apos;t own a Decentraland NAME. Connect the wallet that owns your World on Where, or skip Decentraland.</p>
          ) : (
            <ul className="space-y-2" aria-label="Your Worlds">
              {listed.map((n) => (
                <li key={n.world}>
                  <button type="button" disabled={checking !== null || connecting} onClick={() => { pick(n, n.wallet) }}
                    className="flex w-full items-center justify-between gap-3 rounded-md border border-gray-800 bg-gray-950 px-3 py-2.5 text-left hover:border-gray-700 disabled:opacity-60">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-white">{n.world}</span>
                      <span className="block font-mono text-xs text-gray-500">{shortAddress(n.wallet)}</span>
                    </span>
                    {checking === n.world ? <span className="text-xs text-gray-500">Checking…</span> : n.hasScene && <Badge tone="warning">has a scene</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {contractBlocked && <p className="rounded-md border border-yellow-700/60 bg-yellow-950/30 px-3 py-2 text-yellow-200" role="alert">{CONTRACT_WALLET_MESSAGE}</p>}
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => dispatch({ type: 'goTo', step: 'where' })} className="text-blue-400 hover:text-blue-300">Back to Where</button>
            <button type="button" onClick={() => dispatch({ type: 'setDclLater', on: false })} className="text-gray-400 hover:text-white">Skip Decentraland</button>
          </div>
        </section>
      )}

      {pickedHere && dcl && !started && (
        <div className="space-y-2 rounded-md border border-gray-800 bg-gray-950 px-3 py-2.5">
          <p className="text-white">
            {dcl.world} <span className="font-mono text-xs text-gray-500">{shortAddress(dcl.wallet)}</span>
            <button type="button" onClick={() => { setPickedHere(false); dispatch({ type: 'setDclLater', on: true }) }}
              className="ml-3 text-xs text-gray-400 hover:text-white">Change</button>
          </p>
          {dcl.hasScene && (
            <div className="space-y-2 text-yellow-100">
              <p>This World already has a scene on {dcl.footprint?.parcels.length ?? 1} {(dcl.footprint?.parcels.length ?? 1) === 1 ? 'parcel' : 'parcels'}. Deploying will replace it.</p>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={replaceOk} onChange={(e) => setReplaceOk(e.target.checked)} />
                Replace the scene that&apos;s there now
              </label>
            </div>
          )}
        </div>
      )}

      {!done && gate === 'deploy' && (
        <PrimaryButton type="button" onClick={start} disabled={running || atLimit || !state.name.trim() || confirmPending}>
          {running ? 'Working…' : view.status === 'failed' ? 'Try again' : 'Create and deploy'}
        </PrimaryButton>
      )}

      {live && memory.sceneId && (
        <div className="space-y-3 rounded-md border border-green-700/50 bg-green-950/20 p-3">
          <p className="font-medium text-green-200">{dcl ? `${state.name.trim()} is live in ${dcl.world}.` : `${state.name.trim()} is ready.`}</p>
          {dcl && (
            <p className="text-gray-400">
              {state.mode === 'virvi'
                ? 'Move things in-world with the Virvi editor. When you add a model there, Virvi redeploys on its own.'
                : 'Move things in-world with the Virvi editor. New models wait as ready to publish until you sign.'}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {dcl && (
              <a href={jumpInUrl(dcl.world)} target="_blank" rel="noreferrer"
                className="clip-corner inline-flex items-center gap-1.5 bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover">
                Jump in
              </a>
            )}
            <Link href={`/scenes?id=${memory.sceneId}`} className="text-blue-400 hover:text-blue-300">Open the scene&apos;s dashboard</Link>
          </div>
        </div>
      )}

      {(done || view.status === 'failed') && hyperfy && (
        memory.hyperfy?.kind === 'self' ? (
          <div className="space-y-2 rounded-md border border-blue-500/40 bg-gray-950 p-3">
            <p className="font-medium text-blue-300">World key for {memory.hyperfy.worldName}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-gray-800 px-2 py-1.5 text-white">{memory.hyperfy.key}</code>
              <button type="button" onClick={() => copy((memory.hyperfy as { key: string }).key)} className="rounded bg-gray-800 px-3 py-1.5 text-blue-400 hover:bg-gray-700">{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <p className="text-yellow-400">You won&apos;t see this key again.</p>
            <a href={`${API_URL}/api/hyperfy/app.hyp`} className="inline-block rounded bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700">Download the Virvi app (.hyp)</a>
            <ol className="list-decimal space-y-1 pl-5 text-gray-300">
              {hyperfySetupSteps(API_URL).map((s) => <li key={s}>{s}</li>)}
            </ol>
          </div>
        ) : memory.hyperfy?.kind === 'hosted' ? (
          <div className="space-y-1 rounded-md border border-blue-500/40 bg-gray-950 p-3">
            <p className="font-medium text-blue-300">{memory.hyperfy.worldName} is being set up</p>
            <p className="text-gray-300">Type <code className="rounded bg-gray-800 px-1.5 py-0.5 text-white">/admin {memory.hyperfy.adminCode}</code> in the world&apos;s chat to build. Setup takes 2 to 3 minutes.</p>
            {memory.hyperfy.address && <p className="text-gray-400">Address: {memory.hyperfy.address}</p>}
          </div>
        ) : view.hyperfyError ? (
          <p className="text-red-300">Hyperfy: {view.hyperfyError}</p>
        ) : null
      )}
      {(done || view.status === 'failed') && ar && (
        memory.ar ? (
          <p className="text-gray-300">Virvi AR space &ldquo;{memory.ar.name}&rdquo; is ready. Print and align its rings in the scene&apos;s AR tab.</p>
        ) : view.arError ? (
          <p className="text-red-300">Virvi AR: {view.arError}</p>
        ) : null
      )}
      {extrasFailed && (
        <button type="button" onClick={retryExtras} disabled={retrying} className="rounded-md bg-gray-800 px-3 py-2 hover:bg-gray-700 disabled:opacity-50">
          {retrying ? 'Trying again…' : 'Try again'}
        </button>
      )}
    </div>
  )
}
