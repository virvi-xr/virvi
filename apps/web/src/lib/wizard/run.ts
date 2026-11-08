// The wizard's "Create and deploy" run: scene, World destination, permission or signature, the extra
// destinations, then polling until Decentraland has accepted the deployment. Everything it has created
// is kept in `RunMemory`, so "Try again" picks up where it stopped and never makes a second scene.
import type { ImportLocation, Plot, RoomSetOptions } from '@virvixr/shared'
import type { Eip1193Provider } from '../auth'
import type { AuthChain, SignSession } from '../dcl-sign'
import { hyperfyErrorMessage } from '../hyperfy'
import { connectedSceneFromError, worldInUseView } from '../world-disconnect'
import type {
  ConnectedScene, DclDeployment, DclDestination, DclDestinationMode, DclGrantRequests, DclRevokeRequests, DclSignedSubmission, WizardSceneBody,
} from '../api'

type ApiError = Error & { status?: number; code?: number; body?: { error?: string; message?: string } }

/** The server's error code (`{ error: code }`), when there is one. */
export function errorCode(err: unknown): string | null {
  const code = (err as ApiError | null)?.body?.error
  return typeof code === 'string' ? code : null
}

const UNREACHABLE = "Decentraland didn't answer just now. Try again in a minute."

const CODE_MESSAGES: Record<string, string> = {
  world_unreachable: UNREACHABLE,
  directory_unavailable: "Decentraland's name service didn't answer just now. Try again in a minute.",
  not_world_owner: "That World isn't owned by a wallet linked to your account. Sign with the wallet that owns the name.",
  world_in_use: 'That World is already connected to another Virvi scene.',
  invalid_world: 'That isn\'t a World name. World names end in .dcl.eth or .eth.',
  expired: 'The signatures took too long to reach Decentraland. Try again and sign straight away.',
  invalid_signature: "The signature didn't check out. Try again.",
  invalid_chains: "The signature didn't check out. Try again.",
  invalid_chain: "The signature didn't check out. Try again.",
  grant_not_visible: "Decentraland took the permission but doesn't show it yet. Try again in a minute.",
  virvi_deploys_unavailable: "Virvi deploys aren't available right now. Choose \"I'll sign each deploy\" instead.",
  not_granted: "Virvi doesn't have deploy permission on this World yet. Try again to sign it.",
  needs_review: "Your World changed outside Virvi. Open the scene's Deploy page to look at it before deploying.",
  no_live_scene: 'Your World has no scene to add models to.',
  not_connected: "That World's scene isn't set up for this Virvi scene any more. Set it up again in-world, then reload this page.",
  not_awaiting_signature: 'This deploy is no longer waiting for a signature. Try again.',
  stale: 'Your World changed since this deploy was prepared. Try again.',
  over_budget: "The scene is past Decentraland's limits for this plot. Remove some models, then deploy again.",
  nothing_to_deploy: 'Your World already has everything in this scene, so there was nothing to deploy.',
  deploy_failed: 'Something went wrong on our side while deploying. Try again in a few minutes.',
  plot_mismatch: "The plot no longer matches your room scan. Go back to Size, then try again.",
  too_big: 'That room scan is too big for a Decentraland plot.',
  invalid_options: "Those room options weren't accepted. Pick them again, then try again.",
  unmeasured_asset: "One of the items can't be measured yet, so it can't be placed. Remove it and try again.",
  invalid_plot: 'That plot size is not allowed. Pick a size up to 10 × 10 parcels.',
  invalid_spawn: 'The arrival point has to be inside the plot.',
  scene_limit_reached: 'Your plan has no room for another scene. Upgrade in Settings to make more.',
  not_found: "That couldn't be found. Reload the page and try again.",
  forbidden: 'You need full access to this scene to do that. Ask its owner.',
}

/** A plain sentence for any failure in the wizard; never a raw error code. */
export function wizardErrorMessage(err: unknown): string {
  // By name, not instanceof: dcl-sign (and @dcl/crypto) loads only when the wallet is first asked to sign.
  if ((err as Error | null)?.name === 'WrongWalletError') return (err as Error).message
  const e = err as ApiError | null
  if (e?.code === 4001) return 'You cancelled the request in your wallet. Nothing was changed.'
  const code = errorCode(err)
  if (code === 'world_unreachable') return UNREACHABLE
  if (e?.body?.message) return e.body.message
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  // Some routes put a sentence in `error`; codes are snake_case words.
  if (code && !/^[a-z0-9_]+$/.test(code) && !/^HTTP \d+$/.test(code)) return code
  if (e?.status && e.status >= 500) return 'Something went wrong on our side. Try again in a moment.'
  if (!e?.status && e?.message && !/^[a-z0-9_]+$/.test(e.message)) return e.message
  return 'Something went wrong. Try again in a moment.'
}

/**
 * Shown in place of the server's grant_partial text, which speaks for the dashboard's deploy page.
 * It means Virvi may hold World-wide deploy rights the owner didn't choose.
 */
export const GRANT_PARTIAL_MESSAGE =
  "Virvi may now be able to deploy anywhere in your World, not only on this scene's parcels, and taking that back failed. " +
  "To remove it, open Deploy in Virvi Studio and remove Virvi's permission for this World, or remove Virvi under your World's permissions in the Creator Hub."

/** The web explorer boots into `realm` (a World name works; checked against decentraland.org/play's launcher). */
export function jumpInUrl(place: string | ImportLocation): string {
  if (typeof place !== 'string' && place.kind === 'parcels') return `https://decentraland.org/play/?position=${place.base}`
  return `https://decentraland.org/play/?realm=${encodeURIComponent(typeof place === 'string' ? place : place.world)}`
}

export type Phase = 'packing' | 'uploading' | 'checking' | 'live'
const PHASES: Phase[] = ['packing', 'uploading', 'checking', 'live']

/** The deploy's phase from its row. Upload and Decentraland's check are one request, so `checking` is set by the page. */
export function deploymentPhase(d: Pick<DclDeployment, 'status'>): Phase {
  if (d.status === 'deployed') return 'live'
  if (d.status === 'deploying') return 'uploading'
  return 'packing'
}

/** How many models the deployment uploads, once the server knows. */
export function deploymentModels(d: DclDeployment | null | undefined): number | null {
  const bundle = d?.assetBundle as { added?: unknown; progress?: { modelsTotal?: unknown } } | null | undefined
  const total = bundle?.progress?.modelsTotal ?? (Array.isArray(bundle?.added) ? bundle.added.length : null)
  return typeof total === 'number' ? total : null
}

export function uploadingLabel(models: number | null): string {
  if (models === null) return 'Uploading your models'
  return `Uploading ${models} ${models === 1 ? 'model' : 'models'}`
}

export type LineState = 'done' | 'active' | 'todo' | 'failed'

/** The four progress lines; on a failure the active line turns `failed`. */
export function progressLines(phase: Phase, models: number | null, failed = false): Array<{ label: string; state: LineState }> {
  const at = PHASES.indexOf(phase)
  const labels = ['Packing your scene', uploadingLabel(models), 'Decentraland is checking it', 'Live']
  return labels.map((label, i) => ({
    label,
    state: phase === 'live' ? 'done' : i < at ? 'done' : i === at ? (failed ? 'failed' : 'active') : 'todo',
  }))
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface RunPlan {
  name: string
  plot: Plot
  spawn: { x: number; z: number }
  items: WizardSceneBody['items']
  dcl: null | { world: string; wallet: string; mode: DclDestinationMode }
  hyperfy: null | { kind: 'self' | 'hosted'; name: string }
  ar: null | { name: string }
  /** The room scan the scene starts from, and the set's options. */
  roomSet?: null | { scanId: string; options: RoomSetOptions }
}

export type HyperfyResult =
  | { kind: 'self'; worldName: string; key: string }
  | { kind: 'hosted'; worldName: string; adminCode: string; address: string | null }

/** What the run has made so far; lives in the page for the whole visit. */
export interface RunMemory {
  sceneId: string | null
  destination: DclDestination | null
  deploymentId: string | null
  hyperfy: HyperfyResult | null
  ar: { name: string } | null
  session: { session: SignSession; startedAt: number } | null
}

export const emptyMemory = (): RunMemory => ({ sceneId: null, destination: null, deploymentId: null, hyperfy: null, ar: null, session: null })

export interface RunApi {
  bootstrapWizardScene(data: WizardSceneBody): Promise<{ sceneId: string }>
  createDclDestination(data: { sceneId: string; world: string; mode: DclDestinationMode; plot?: Plot; spawn?: { x: number; z: number } }): Promise<{ destination: DclDestination }>
  patchDclDestination(id: string, data: { mode: DclDestinationMode }): Promise<{ destination: DclDestination }>
  getDclDestination(id: string): Promise<{ destination: DclDestination; lastDeployment: DclDeployment | null }>
  getDclGrant(id: string): Promise<DclGrantRequests>
  submitDclGrant(id: string, data: DclSignedSubmission): Promise<{ destination: DclDestination }>
  deployDclDestination(id: string): Promise<{ deployment: DclDeployment; payload?: string; expiresAt?: string }>
  submitDeploySignature(deploymentId: string, chain: AuthChain): Promise<{ deployment: DclDeployment }>
  getDeployment(id: string): Promise<{ deployment: any }>
  createHyperfyWorld(data: { sceneId: string; name: string }): Promise<{ world: { name: string }; key: string }>
  createHostedHyperfyWorld(data: { sceneId: string; name: string }): Promise<{ world: { name: string; address?: string | null }; adminCode: string }>
  createArSpace(sceneId: string, body: { name: string }): Promise<unknown>
}

export interface RunUpdate {
  phase?: Phase
  models?: number | null
  /** Set while the wallet is asked to sign; null once it has. */
  wallet?: null | 'grant' | 'deploy'
  deployment?: DclDeployment
  hyperfyError?: string | null
  arError?: string | null
}

export interface RunDeps {
  api: RunApi
  wallet: () => Eip1193Provider | null
  startSession: (wallet: Eip1193Provider, opts: { expectedAddress?: string }) => Promise<SignSession>
  sleep: (ms: number) => Promise<void>
  now?: () => number
  /** True once the page has gone away: stop polling. */
  cancelled?: () => boolean
}

/**
 * A failure the run stops on. `partial` marks grant_partial, which the page shows on its own; `worldInUse` is the scene
 * that holds the World (409 world_in_use), for the page's disconnect.
 */
export class RunError extends Error {
  constructor(message: string, public readonly partial = false, public readonly worldInUse: ConnectedScene | null = null) {
    super(message)
    this.name = 'RunError'
  }
}

export const POLL_MS = 2_000
/** startSignSession authorises its key for 10 minutes; reuse it a little less than that. */
const SESSION_REUSE_MS = 9 * 60_000
const MAX_EXPIRED_RETRIES = 2

/**
 * Runs (or resumes) the whole deploy. `mem` is updated in place as things are created.
 * Resolves when the scene is live (or ready, without a World); throws RunError otherwise.
 */
export async function runWizard(plan: RunPlan, mem: RunMemory, deps: RunDeps, on: (u: RunUpdate) => void): Promise<void> {
  const { api } = deps
  const now = deps.now ?? Date.now
  const fail = (err: unknown): never => {
    if (err instanceof RunError) throw err
    if (errorCode(err) === 'grant_partial') throw new RunError(GRANT_PARTIAL_MESSAGE, true)
    const held = connectedSceneFromError(err)
    const view = held && plan.dcl ? worldInUseView(plan.dcl.world, held) : null
    if (held && view) throw new RunError(view.text, false, held)
    throw new RunError(wizardErrorMessage(err))
  }

  const session = async (): Promise<SignSession> => {
    if (mem.session && now() - mem.session.startedAt < SESSION_REUSE_MS) return mem.session.session
    const wallet = deps.wallet()
    if (!wallet) throw new RunError('No browser wallet found. Install MetaMask or another Ethereum wallet, then try again.')
    const s = await deps.startSession(wallet, { expectedAddress: plan.dcl?.wallet || undefined })
    mem.session = { session: s, startedAt: now() }
    return s
  }

  try {
    on({ phase: 'packing', models: null })
    if (!mem.sceneId) {
      const { sceneId } = await api.bootstrapWizardScene({
        name: plan.name, plot: plan.plot, spawn: plan.spawn, items: plan.items, dcl: !!plan.dcl,
        ...(plan.roomSet ? { roomSet: plan.roomSet } : {}),
      })
      mem.sceneId = sceneId
    }
    const sceneId = mem.sceneId

    let deploymentId: string | null = null
    let settled: DclDeployment | null = null
    if (plan.dcl) {
      if (!mem.destination) {
        const { destination } = await api.createDclDestination({ sceneId, world: plan.dcl.world, mode: plan.dcl.mode, plot: plan.plot, spawn: plan.spawn })
        mem.destination = destination
      } else if (mem.destination.mode !== plan.dcl.mode) {
        mem.destination = (await api.patchDclDestination(mem.destination.id, { mode: plan.dcl.mode })).destination
      }
      const destId = mem.destination.id

      // The signing session comes first: the wallet prompt must not eat Decentraland's 50 s window.
      on({ wallet: plan.dcl.mode === 'virvi' ? 'grant' : 'deploy' })
      const signer = await session()
      on({ wallet: null })

      if (plan.dcl.mode === 'virvi') {
        if (!mem.destination.grantedAt) mem.destination = await grantVirvi(destId, signer, api)
        deploymentId = await deployVirvi(destId, api)
      } else {
        ;({ deploymentId, settled } = await publishSigned(destId, signer, api, on))
      }
      mem.deploymentId = deploymentId
    }

    await connectExtras(plan, mem, api, on)

    if (!deploymentId) {
      on({ phase: 'live' })
      return
    }
    await watchDeployment(deploymentId, settled, deps, on)
  } catch (err) {
    on({ wallet: null })
    fail(err)
  }
}

// ── Signing and deploying, shared by the wizard, the deploy page and the publish page ─────

type GrantApi = Pick<RunApi, 'getDclGrant' | 'submitDclGrant'>
type DeployApi = Pick<RunApi, 'deployDclDestination' | 'submitDeploySignature' | 'getDclDestination'>
export interface RevokeApi {
  getDclRevoke(id: string): Promise<DclRevokeRequests>
  submitDclRevoke(id: string, data: DclSignedSubmission): Promise<{ destination: DclDestination }>
}

/**
 * Fetches the requests, signs every payload in order and submits them with requests[0].timestamp.
 * Expired (past the server's 50 s) fetches fresh requests and signs again with the same session.
 */
async function signAndSubmit<R extends { requests: Array<{ payload: string; timestamp: number }> }>(
  fetch: () => Promise<R>,
  submit: (data: DclSignedSubmission) => Promise<{ destination: DclDestination }>,
  signer: SignSession,
): Promise<DclDestination> {
  for (let attempt = 0; ; attempt++) {
    const { requests } = await fetch()
    const chains = requests.map((r) => signer.sign(r.payload))
    try {
      return (await submit({ chains, timestamp: requests[0].timestamp })).destination
    } catch (err) {
      if (errorCode(err) === 'expired' && attempt < MAX_EXPIRED_RETRIES) continue
      throw err
    }
  }
}

/** "Let Virvi deploy for me": the owner's signed permission for Virvi's deploy wallet. Start `signer` before calling. */
export function grantVirvi(destinationId: string, signer: SignSession, api: GrantApi): Promise<DclDestination> {
  return signAndSubmit(() => api.getDclGrant(destinationId), (data) => api.submitDclGrant(destinationId, data), signer)
}

/** "Switch to signing each deploy": the owner's signed removal of Virvi's permission. */
export function revokeVirvi(destinationId: string, signer: SignSession, api: RevokeApi): Promise<DclDestination> {
  return signAndSubmit(() => api.getDclRevoke(destinationId), (data) => api.submitDclRevoke(destinationId, data), signer)
}

/** The deploy already running for the destination (after deploy_in_progress). */
async function runningDeploy(destinationId: string, api: Pick<RunApi, 'getDclDestination'>): Promise<DclDeployment> {
  const { lastDeployment } = await api.getDclDestination(destinationId)
  if (!lastDeployment) throw new RunError('A deploy is already running for this World. Try again in a minute.')
  return lastDeployment
}

/** Mode virvi: starts a deploy (Virvi signs) and returns its id; a deploy already running is followed instead. */
export async function deployVirvi(destinationId: string, api: Pick<RunApi, 'deployDclDestination' | 'getDclDestination'>): Promise<string> {
  try {
    return (await api.deployDclDestination(destinationId)).deployment.id
  } catch (err) {
    if (errorCode(err) !== 'deploy_in_progress') throw err
    return (await runningDeploy(destinationId, api)).id
  }
}

/**
 * Mode sign: prepare, sign the payload with `signer`, submit; prepares again when the signature arrived too late.
 * `settled` is the deployment the submit answered with (null when following a deploy already running).
 */
export async function publishSigned(
  destinationId: string,
  signer: SignSession,
  api: DeployApi,
  on: (u: RunUpdate) => void = () => {},
): Promise<{ deploymentId: string; settled: DclDeployment | null }> {
  for (let attempt = 0; ; attempt++) {
    on({ phase: 'packing' })
    let prep: Awaited<ReturnType<RunApi['deployDclDestination']>>
    try {
      prep = await api.deployDclDestination(destinationId)
    } catch (err) {
      if (errorCode(err) !== 'deploy_in_progress') throw err
      return { deploymentId: (await runningDeploy(destinationId, api)).id, settled: null }
    }
    if (!prep.payload) return { deploymentId: prep.deployment.id, settled: null }
    on({ phase: 'uploading', models: deploymentModels(prep.deployment) })
    try {
      const settled = (await api.submitDeploySignature(prep.deployment.id, signer.sign(prep.payload))).deployment
      return { deploymentId: prep.deployment.id, settled }
    } catch (err) {
      if (errorCode(err) === 'expired' && attempt < MAX_EXPIRED_RETRIES) continue
      throw err
    }
  }
}

/** Polls the deployment, reporting its phase, until it is live; throws RunError when Decentraland refused it. */
export async function watchDeployment(
  deploymentId: string,
  settled: DclDeployment | null,
  deps: { api: Pick<RunApi, 'getDeployment'>; sleep: (ms: number) => Promise<void>; cancelled?: () => boolean },
  on: (u: RunUpdate) => void,
): Promise<void> {
  for (let d = settled; ; ) {
    if (d) {
      on({ deployment: d, phase: deploymentPhase(d), models: deploymentModels(d) })
      if (d.status === 'deployed') return
      if (d.status === 'failed') {
        throw new RunError(d.errorMessage ? String(d.errorMessage) : "Decentraland didn't take the deploy. Try again.")
      }
    }
    if (deps.cancelled?.()) return
    if (d) await deps.sleep(POLL_MS)
    d = (await deps.api.getDeployment(deploymentId)).deployment as DclDeployment
  }
}

/** Hyperfy and Virvi AR, for the scene already made: their failures are reported beside them and don't stop the World deploy. */
export async function connectExtras(plan: Pick<RunPlan, 'hyperfy' | 'ar'>, mem: RunMemory, api: RunApi, on: (u: RunUpdate) => void) {
  const sceneId = mem.sceneId
  if (!sceneId) return
  if (plan.hyperfy && !mem.hyperfy) {
    try {
      if (plan.hyperfy.kind === 'hosted') {
        const { world, adminCode } = await api.createHostedHyperfyWorld({ sceneId, name: plan.hyperfy.name })
        mem.hyperfy = { kind: 'hosted', worldName: world.name, adminCode, address: world.address ?? null }
      } else {
        const { world, key } = await api.createHyperfyWorld({ sceneId, name: plan.hyperfy.name })
        mem.hyperfy = { kind: 'self', worldName: world.name, key }
      }
      on({ hyperfyError: null })
    } catch (err) {
      on({ hyperfyError: hyperfyErrorMessage(err) })
    }
  }
  if (plan.ar && !mem.ar) {
    try {
      await api.createArSpace(sceneId, { name: plan.ar.name })
      mem.ar = { name: plan.ar.name }
      on({ arError: null })
    } catch (err) {
      on({ arError: wizardErrorMessage(err) })
    }
  }
}
