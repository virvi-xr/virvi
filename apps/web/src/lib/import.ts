// The Import page: a Creator Hub or SDK7 scene uploaded, built by Virvi, then deployed to its World.
import type { SceneImportView } from '@virvixr/shared'
import type { LineState } from './wizard/run'
import { errorCode, POLL_MS, wizardErrorMessage } from './wizard/run'
import { relativeTime } from './studio'

export type ImportPhase = 'uploading' | 'building' | 'ready' | 'deploying' | 'sign' | 'live' | 'failed'

/**
 * Where an import is. `ready`: built (or its signing window passed) and waiting for the creator to deploy, since only
 * a World where Virvi holds the permission deploys on its own (Rulings R1, R3). `sign`: waiting for the wallet.
 */
export function importPhase(v: Pick<SceneImportView, 'status' | 'canDeploy'>): ImportPhase {
  switch (v.status) {
    case 'uploaded': return 'uploading'
    case 'building': return 'building'
    case 'built': return 'ready'
    case 'awaiting_signature': return v.canDeploy ? 'ready' : 'sign'
    case 'deploying': return 'deploying'
    case 'deployed': return 'live'
    default: return 'failed'
  }
}

export type PhaseTone = 'info' | 'warning' | 'success' | 'danger'

/** The badge for each phase. */
export const PHASE_BADGES: Record<ImportPhase, [PhaseTone, string]> = {
  uploading: ['info', 'Uploading'],
  building: ['info', 'Building'],
  ready: ['warning', 'Ready to deploy'],
  sign: ['warning', 'Waiting for your signature'],
  deploying: ['info', 'Deploying'],
  live: ['success', 'Live'],
  failed: ['danger', 'Failed'],
}

const RECENT_LIMIT = 10

/** The signed-in creator's recent imports for the Import page: newest first, at most 10, each opening its own view. */
export function recentImports(views: SceneImportView[], now: Date) {
  return [...views]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT_LIMIT)
    .map((v) => {
      const [tone, label] = PHASE_BADGES[importPhase(v)]
      return { id: v.id, world: v.worldName, label, tone, when: relativeTime(v.createdAt, now), href: `/import/?id=${v.id}` }
    })
}

export const IMPORT_FALLBACK_MESSAGE = 'Something went wrong with this import. Try again in a moment.'

const CODE_MESSAGES: Record<string, string> = {
  // Reading the upload
  not_a_zip: "That file isn't a zip Virvi can open. Pick the scene's folder instead, or zip it again.",
  unsafe_path: 'The zip has a file path Virvi refuses, like one that points outside the scene. Zip the scene folder again.',
  too_many_files: "The scene has too many files. Remove the ones it doesn't use, then upload again.",
  too_big: "The scene is too big to import. Remove large files it doesn't use, then upload again.",
  no_scene_json: "There's no scene.json in what you picked. Pick the scene's own folder, the one with scene.json in it.",
  bad_scene_json: "The scene's scene.json can't be read. Check it in the Creator Hub, then upload again.",
  not_sdk7: 'Only SDK7 scenes can be imported. Update the scene to SDK7 in the Creator Hub first.',
  bad_world_name: "The World name in scene.json isn't one Virvi can deploy to. It must be a name ending in .eth.",
  bad_package_json: "The scene's package.json can't be read. Check it in the Creator Hub, then upload again.",
  bad_source_encoding: "The scene's src/index.ts isn't plain text Virvi can read. Save it as UTF-8, then upload again.",
  no_main: "Virvi couldn't find the main() function in src/index.ts. Make sure the scene exports one, then upload again.",
  parcels_not_yet: 'Genesis City imports are coming soon. For now, import a scene whose scene.json names a World.',
  // The World and the import
  not_world_owner: "The World in scene.json isn't owned by a wallet linked to your account. Link the wallet that owns it in Settings.",
  world_unreachable: "Decentraland didn't answer just now. Try again in a minute.",
  world_in_use: "This World is connected to a Virvi scene you can't manage. Ask that scene's owner to give you full access.",
  world_set_up_elsewhere: "This World is set up under a Virvi scene you can't manage. Ask that scene's owner to give you full access.",
  import_in_progress: 'This World already has an import under way. Wait for it to finish, then upload again.',
  superseded: 'A newer upload for this World replaced this one.',
  import_superseded: 'A newer upload for this World replaced this one.',
  store_failed: "The upload couldn't be saved. Try again in a few minutes.",
  not_deployable: "This import can't be deployed now. Reload the page to see where it is.",
  not_found: "This import couldn't be found. It may belong to someone else, or the link is wrong.",
  no_log: 'There is no build log for this import.',
  invalid_scene: "That scene couldn't be found. Reload the page and try again.",
  // The build
  build_failed: "The scene didn't build. The build log below shows what went wrong.",
  build_timeout: 'The build took too long and was stopped. Try again, or make the scene smaller.',
  build_start_failed: "The build couldn't start. Try the upload again in a few minutes.",
  builds_unavailable: 'Scene builds are not available right now. Try again later.',
  not_uploaded: 'This import is not waiting for a build. Upload the scene again.',
  imports_busy: 'Virvi is busy with other imports. Try again in a minute.',
  // The deploy
  scene_too_big: "The scene has more files than its parcels allow in Decentraland. Remove some files, then upload again.",
  file_too_big: "One of the scene's files is over Decentraland's limit for a single file. Make it smaller, then upload again.",
  world_storage_full: "Your World doesn't have enough storage left for this scene. Free some up, or make the scene smaller.",
  world_changed: 'The build changed which World the scene is for. Check worldConfiguration in scene.json, then upload again.',
  import_files_missing: "This import's built files are no longer stored. Upload the scene again.",
  virvi_deploys_unavailable: "Virvi can't deploy for you right now. Try again in a few minutes.",
  expired: 'The signature came too late. Deploy again and sign straight away.',
  needs_review: 'Your World changed outside Virvi. Open Deploy to look at it before deploying.',
  over_budget: "The scene is past Decentraland's limits for its parcels. Remove something, then upload again.",
  nothing_to_deploy: 'Your World already has exactly this scene, so there was nothing to deploy.',
  no_live_scene: 'Your World has no scene to add models to.',
  deploy_failed: 'Something went wrong on our side while deploying. Try again in a few minutes.',
  model_unavailable: "One of the scene's models couldn't be fetched again. Try again in a few minutes.",
  entity_mismatch: "The deploy didn't match what was signed. Try again.",
  not_granted: "Virvi doesn't have permission to deploy to this World. Deploy and sign it yourself instead.",
  deploy_in_progress: 'A deploy is already running for this World. Wait for it to finish.',
  not_awaiting_signature: 'This deploy is no longer waiting for a signature. Reload the page to see where it is.',
  stale: 'Your World changed since this deploy was prepared. Deploy again.',
  deploy_rejected: "Decentraland didn't take the deploy. Try again.",
  interrupted: 'Virvi was interrupted while deploying. Press Deploy to try again.',
  deploy_interrupted: 'Virvi was interrupted before the deploy started. Press Deploy to try again.',
  cancelled: 'The deploy was cancelled. Press Deploy to try again.',
  // What went live
  files_gone: "Some of this deploy's files are no longer stored anywhere, so it can't be downloaded.",
  files_unsafe: "Some of this deploy's file names can't be put in a zip safely, so it can't be downloaded.",
  not_deployed: "This deploy never went live, so there's nothing to download.",
  // Retention (Ruling R27)
  files_expired: "This import's files were deleted after 30 days.",
}

/** One plain sentence for an import's error code. */
export function importErrorMessage(code: string): string {
  return CODE_MESSAGES[code] ?? IMPORT_FALLBACK_MESSAGE
}

type ApiError = Error & { status?: number; body?: { error?: string; message?: string; importId?: string } }

/**
 * A failed request of the import flow, as a sentence: the server's own `message` when it sent one, else the code's
 * sentence, else as the wizard says it. A failed upload may name the import it made, for its build log (Ruling R18).
 */
export function importFailure(err: unknown): { message: string; importId: string | null } {
  const body = (err as ApiError | null)?.body
  const importId = typeof body?.importId === 'string' ? body.importId : null
  const code = errorCode(err)
  const message = typeof body?.message === 'string' && body.message
    ? body.message
    : code && CODE_MESSAGES[code] ? CODE_MESSAGES[code] : wizardErrorMessage(err)
  return { message, importId }
}

/** What a failed import says: its stored message, else its code's sentence. */
export const importViewError = (v: Pick<SceneImportView, 'errorCode' | 'errorMessage'>): string =>
  v.errorMessage || importErrorMessage(v.errorCode ?? '')

/**
 * What a failed import shows under its error: its build log, or (Ruling R27) that its files were deleted after 30 days;
 * nothing for one a newer upload replaced.
 */
export function buildLogShown(v: Pick<SceneImportView, 'errorCode' | 'filesExpired'>): 'log' | 'expired' | null {
  if (v.errorCode === 'superseded') return null
  return v.filesExpired ? 'expired' : 'log'
}

const BUILD_CODES = new Set([
  'build_failed', 'build_timeout', 'build_start_failed', 'builds_unavailable', 'not_uploaded', 'bad_package_json', 'bad_source_encoding',
  'no_main', 'store_failed',
])

/** The four steps; on a failure the step it stopped at turns `failed`. */
export function importLines(
  phase: ImportPhase,
  world: string,
  failed?: Pick<SceneImportView, 'errorCode' | 'deploymentId'>,
): Array<{ label: string; state: LineState }> {
  const labels = ['Upload', 'Build', `Deploy to ${world}`, 'Live']
  const at = phase === 'failed'
    ? (failed && !failed.deploymentId && (!failed.errorCode || BUILD_CODES.has(failed.errorCode)) ? 1 : 2)
    : { uploading: 0, building: 1, ready: 2, sign: 2, deploying: 2, live: 4 }[phase]
  // A replaced import stopped at the deploy without failing there
  const replaced = phase === 'failed' && failed?.errorCode === 'superseded'
  return labels.map((label, i) => ({
    label,
    state: i < at ? 'done' : i === at ? (replaced ? 'todo' : phase === 'failed' ? 'failed' : 'active') : 'todo',
  }))
}

export interface ImportWatchDeps {
  api: { getSceneImport: (id: string) => Promise<{ import: SceneImportView }> }
  sleep: (ms: number) => Promise<void>
  cancelled?: () => boolean
}

/**
 * Polls the import every 2 s, reporting each view, until it is deployed or failed (resolves with that view), or
 * `cancelled` (resolves null). It keeps polling while the import waits for the creator: a World where Virvi holds the
 * permission moves from built to deploying on its own.
 */
export async function watchImport(id: string, deps: ImportWatchDeps, on: (v: SceneImportView) => void): Promise<SceneImportView | null> {
  for (;;) {
    if (deps.cancelled?.()) return null
    const v = (await deps.api.getSceneImport(id)).import
    on(v)
    if (v.status === 'deployed' || v.status === 'failed') return v
    await deps.sleep(POLL_MS)
  }
}
