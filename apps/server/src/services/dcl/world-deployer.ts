/**
 * Deploys a Virvi scene to its owner's Decentraland World, then links the World to the scene.
 *
 * Mode A (`startVirviDeploy`): Virvi's permitted deploy wallet signs; the work runs in the background.
 * Mode B (`prepareSignedDeploy` + `submitSignedDeploy`): the owner signs the entity id in their browser.
 * Between the two calls Virvi keeps only what rebuilds the upload byte-for-byte (model URLs and hashes,
 * small generated files inline, the runtime by version), never the model bytes.
 *
 * Every deploy starts from what is live: a fresh destination gets the generic runtime, anything else
 * builds on the live entity at its base. If the live entity is not the one Virvi last deployed, it stops.
 * Every path (the sweep, "Redeploy now", a mode B publish) first checks Decentraland's limits
 * (`assertDeployable`), and never signs or uploads a deployment that would change nothing.
 *
 * A destination with a `pendingImportId` deploys that import's built files instead (`assembleImported`): it replaces
 * whatever is live, so the changed-outside check is skipped, and its files are checked by `assertImportFits`. The
 * deployment is linked to the import when it is created, and the import settles with it: deployed, or, when the World
 * accepted nothing, back to `built` (or `failed` for a PERMANENT error), all through `markFailed` (Ruling R19).
 */
import { and, eq, inArray, isNull, lt, or, sql, TransactionRollbackError } from 'drizzle-orm'
import { DCL_MAX_FILE_BYTES, DCL_PARCEL_M, dclBudget, parseParcel, type ImportLocation } from '@virvixr/shared'
import { db } from '../../db/connection.js'
import { dclWorldDestinations, sceneDeployments, sceneImports, scenes } from '../../db/schema.js'
import { DirectoryUnavailableError } from '../../analytics/dcl-directory.js'
import { linkLocation } from '../../setup/setups.js'
import { getImportStore } from '../../storage/private-store.js'
import { ImportError, worldNameOf } from '../import/scene-zip.js'
import {
  assembleFresh, assembleImported, assembleRedeploy, builtByVirvi, defaultModelFetcher, modelsBesideBuilt, modelsInScene, pendingModels, wizardSceneJson,
  type Assembled, type ModelFetcher, type ModelNeed,
} from './assemble.js'
import { keepDeployedFiles } from './deployed-files.js'
import { buildEntity, chainSigner, dclHash, verifyChain, virviSigner, type AuthChain, type ContentRef, type SceneMetadata } from './entity.js'
import { parcelControl } from './parcel-control.js'
import { DCL_RUNTIME_VERSION, runtimeFiles } from './runtime.js'
import { CatalystError, contentServerFor } from './catalyst-client.js'
import { getWorldsClient, WorldsError, type LiveEntity } from './worlds-client.js'
import { worldOf } from './world-of.js'

/** The server's limit, inside Decentraland's ~5-minute entity timestamp window. */
export const DEPLOY_WINDOW_MS = 240_000
/** Packing that took longer than this gets a fresh timestamp before signing. */
const RETIMESTAMP_AFTER_MS = 10_000
/** Generated files at most this big are kept inline in a mode B bundle. */
const INLINE_MAX_BYTES = 64 * 1024
const CHANGED_OUTSIDE = 'Your World changed outside Virvi'
const UNREACHABLE = "Couldn't read your World from Decentraland"
/** Starts the destination's statusDetail while models Virvi couldn't add hold it at needs_review. */
export const REFUSED_PREFIX = "Virvi couldn't add "
const NOTHING_NEW = 'Your World already has everything in this scene, so there was nothing to deploy.'
const GENERIC_FAILURE = 'Something went wrong on our side while deploying. Try again in a few minutes.'
const IMPORT_REPLACED = 'A newer upload replaced this one, so this deploy was cancelled.'
const IMPORT_FILES_GONE = "The built scene's files are gone. Upload it again."
/** What an import's deploy says when the signature can no longer be used (the Import page's button is Deploy). */
const IMPORT_EXPIRED = 'The signature took too long. Press Deploy to sign again.'
const IMPORT_STALE = 'Your World changed while this deploy waited for its signature. Press Deploy to sign again.'
const IMPORT_STALE_PARCELS = 'Your parcels changed while this deploy waited for its signature. Press Deploy to sign again.'
const IMPORT_INTERRUPTED = 'Virvi was interrupted while deploying. Press Deploy to try again.'

/**
 * Errors a retry of the same stored build can't fix (Rulings R19, R20): the import fails and needs a new upload. Any
 * other failure before the World accepted the deploy puts the import back to `built`, so the creator presses Deploy.
 */
export const PERMANENT_IMPORT_ERRORS: ReadonlySet<string> = new Set([
  'import_files_missing', 'world_changed', 'place_changed', 'bad_scene_json', 'scene_too_big', 'file_too_big', 'world_storage_full',
])

/** The import's columns after a deploy of it ended without going live with error `code` (see PERMANENT_IMPORT_ERRORS). */
export function importAfterFailure(code: string, message: string, now = new Date()) {
  return PERMANENT_IMPORT_ERRORS.has(code)
    ? { status: 'failed' as const, errorCode: code, errorMessage: message, finishedAt: now, updatedAt: now }
    : { status: 'built' as const, errorCode: code, errorMessage: message, updatedAt: now }
}
/** The sentence when a built scene.json names a World other than the one it is deploying to. */
export const worldChanged = (named: string | null, world: string) =>
  `The built scene.json names the World ${named ?? '(none)'}, not ${world}. Virvi only deploys a scene to the World it was uploaded for.`
/** The World an entity's metadata deploys to (ASCII-lower-cased, see worldNameOf), or null when it names none. */
const metadataWorld = (m: { worldConfiguration?: { name?: unknown } } | undefined) => worldNameOf(m?.worldConfiguration?.name)
/** The sentence when a built scene.json no longer deploys to the Genesis City parcels it was uploaded for. */
export const PLACE_CHANGED =
  'The built scene.json no longer deploys to the parcels it was uploaded for. Virvi only deploys a scene to the parcels it was uploaded for.'

/**
 * Decentraland's scene size limit, per parcel: @dcl/content-validator src/validations/ADR51.ts gives scenes
 * `maxSizeInMB: 15`, and src/validations/size.ts refuses an entity whose total content size divided by its pointer
 * count is over `maxSizeInMB * 1024 * 1024` (no other total cap). Checked on 2026-11-04 against the main branch.
 */
export const PARCEL_MAX_BYTES_PER_PARCEL = 15 * 1024 * 1024

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(';') === [...b].sort().join(';')

/**
 * A built scene.json (never trusted as stored: the build ran the creator's code) must deploy where the import was
 * uploaded for: the same World (422 world_changed), or the same parcels and base with no worldConfiguration
 * (422 place_changed).
 */
export function assertBuiltPlace(loc: ImportLocation, metadata: { worldConfiguration?: { name?: unknown }; scene?: { parcels?: unknown; base?: unknown } } | undefined): void {
  if (loc.kind === 'world') {
    const named = metadataWorld(metadata)
    if (named !== loc.world) throw new DeployerError(422, 'world_changed', worldChanged(named, loc.world))
    return
  }
  const parcels = metadata?.scene?.parcels
  const ok = metadata?.worldConfiguration === undefined &&
    Array.isArray(parcels) && parcels.every((p) => typeof p === 'string') && sameSet(parcels as string[], loc.parcels) &&
    (metadata?.scene?.base ?? parcels[0]) === loc.base
  if (!ok) throw new DeployerError(422, 'place_changed', PLACE_CHANGED)
}

export type Destination = typeof dclWorldDestinations.$inferSelect
export type Deployment = typeof sceneDeployments.$inferSelect

/** Where a destination deploys: its World, or its Genesis City parcels. */
export function destinationLocation(dest: Pick<Destination, 'kind' | 'worldName' | 'base' | 'parcels'>): ImportLocation {
  return dest.kind === 'parcels' ? { kind: 'parcels', base: dest.base, parcels: dest.parcels } : { kind: 'world', world: worldOf(dest) }
}

/** A deployment row's type and target: a World's by name; parcels with no `world` (deployed-files reads the catalyst). */
function ledgerOf(dest: Destination) {
  return dest.kind === 'parcels'
    ? { deploymentType: 'parcel', target: { parcels: dest.parcels } }
    : { deploymentType: 'world', target: { world: worldOf(dest), parcels: dest.parcels } }
}

export class DeployerError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code)
  }
}

export interface DeployOptions {
  /** Model downloader; tests inject one. */
  fetch?: ModelFetcher
}

/** How to recreate one new file of a prepared deployment. */
export type NewFileSource =
  | { file: string; hash: string; url: string }
  | { file: string; hash: string; base64: string }
  | { file: string; hash: string; runtimeVersion: number }
  /** A built file of an imported scene, in the import store. */
  | { file: string; hash: string; storageKey: string }

export interface SignedBundle {
  entityId: string
  timestamp: number
  pointers: string[]
  deployedFiles: string[]
  added: string[]
  refused: Assembled['refused']
  newFiles: NewFileSource[]
  existing: ContentRef[]
  /** Every file of the entity, path to hash: what the deployment's download is made of. */
  content: ContentRef[]
  /** scene.json metadata as exact JSON text: jsonb reorders keys, which would change the entity id. */
  metadataJson: string
  /** The live entity this deployment builds on (or replaces); null when the World was empty. */
  baseEntityId: string | null
  /** The scene import this deployment deploys, if any. */
  importId?: string | null
}

async function loadDestination(id: string): Promise<Destination> {
  const dest = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, id) })
  if (!dest) throw new DeployerError(404, 'not_found')
  return dest
}

async function setDestStatus(id: string, status: Destination['status'], statusDetail: string | null) {
  await db.update(dclWorldDestinations).set({ status, statusDetail, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, id))
}

/**
 * The live entity at the destination's base (null when there is none). Stops with 409 needs_review when
 * Virvi has deployed here before and the live entity is no longer that one (adopted scenes too), and
 * with 503 world_unreachable when the World can't be read. Shared by deploys and the sweep.
 */
export async function liveBaseFor(dest: Destination): Promise<LiveEntity | null> {
  const live = await liveAt(dest)
  if (dest.lastEntityId && live?.id !== dest.lastEntityId) {
    await setDestStatus(dest.id, 'needs_review', CHANGED_OUTSIDE)
    throw new DeployerError(409, 'needs_review', CHANGED_OUTSIDE)
  }
  if (dest.status === 'unreachable') await setDestStatus(dest.id, 'ok', null)
  return live
}

/** The live entity at the destination's base, without the changed-outside check (an import replaces it). */
async function liveAt(dest: Destination): Promise<LiveEntity | null> {
  let entities: LiveEntity[]
  try {
    entities = await contentServerFor(dest).liveEntities(dest)
  } catch {
    await setDestStatus(dest.id, 'unreachable', UNREACHABLE)
    throw new DeployerError(503, 'world_unreachable', UNREACHABLE)
  }
  return entities.find((e) => e.pointers.includes(dest.base)) ?? null
}

/** The owner-facing sentence for models left out of a deployment. */
export function refusedLine(refused: Assembled['refused']): string {
  const list = refused.map((r) => `${r.name} (${r.reason})`).join(', ')
  return `${REFUSED_PREFIX}${list}. Remove or replace ${refused.length === 1 ? 'it' : 'them'} in the scene, or press Redeploy now to try again.`
}

const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`

/**
 * A plain sentence when the scene has more placed models than Decentraland's per-parcel limit, else null. No network.
 * Entities count every placed instance, as the wizard does. Triangles are only a warning (`sceneTriangleWarning`).
 */
export function sceneLimitProblem(dest: Destination, all: ModelNeed[]): string | null {
  const budget = dclBudget(dest.parcels.length)
  const parcels = plural(dest.parcels.length, 'parcel')
  const placed = all.reduce((n, m) => n + m.instances, 0)
  if (placed > budget.entities) {
    return `Your scene has ${plural(placed, 'placed model')}, over the ${budget.entities.toLocaleString('en-US')} your ${parcels} allow. Remove some to publish.`
  }
  return null
}

/**
 * A plain sentence when the scene is over the triangles Decentraland recommends for its parcels, else null. Decentraland
 * warns about it but still takes the deployment, so it never stops one. Counts every placed instance, as the wizard does.
 */
export function sceneTriangleWarning(dest: Destination, all: ModelNeed[]): string | null {
  const budget = dclBudget(dest.parcels.length)
  const triangles = all.reduce((n, m) => n + (m.triangles ?? 0) * m.instances, 0)
  if (triangles <= budget.triangles) return null
  const unknown = all.filter((m) => m.triangles == null).length
  const note = unknown > 0 ? ` ${unknown} model${unknown === 1 ? ' has' : 's have'} no triangle count yet and counted as 0.` : ''
  return `Your scene has ${plural(triangles, 'triangle')}, more than the ${budget.triangles.toLocaleString('en-US')} Decentraland recommends for your ` +
    `${plural(dest.parcels.length, 'parcel')}. It still deploys, but it may run slowly for visitors.${note}`
}

/** A plain sentence when the new models don't fit the owner's World storage, else null. Genesis City parcels have none. */
export async function storageProblem(dest: Destination, pending: ModelNeed[]): Promise<string | null> {
  if (dest.kind !== 'world') return null
  const bytes = pending.reduce((n, m) => n + (m.bytes ?? 0), 0)
  if (bytes === 0) return null
  let stats: { maxAllowedBytes: number; usedBytes: number } | null
  try {
    stats = await getWorldsClient().getWalletStats(dest.ownerWallet)
  } catch {
    return null // can't tell: let the deploy try, Decentraland will say if it's full
  }
  if (!stats || bytes <= stats.maxAllowedBytes - stats.usedBytes) return null
  const mb = (n: number) => (n / 1_000_000).toFixed(1)
  return `The new models need ${mb(bytes)} MB of World storage but only ${mb(Math.max(0, stats.maxAllowedBytes - stats.usedBytes))} MB is left.`
}

/**
 * The check every deploy path runs first: the scene fits the plot and the World's storage. Otherwise the
 * destination becomes over_budget and this throws 422 over_budget; a destination that fits again is cleared.
 */
export async function assertDeployable(dest: Destination): Promise<void> {
  const problem = sceneLimitProblem(dest, await modelsInScene(dest.sceneId)) ?? (await storageProblem(dest, await pendingModels(dest)))
  if (problem) {
    if (dest.status !== 'over_budget' || dest.statusDetail !== problem) await setDestStatus(dest.id, 'over_budget', problem)
    throw new DeployerError(422, 'over_budget', problem)
  }
  if (dest.status === 'over_budget') await setDestStatus(dest.id, 'ok', null)
}

/** Where the destination's pending import keeps its built files. */
async function pendingImportPrefix(dest: Destination): Promise<string> {
  const imp = dest.pendingImportId
    ? await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, dest.pendingImportId), columns: { builtKeyPrefix: true } })
    : undefined
  if (!imp?.builtKeyPrefix) throw new DeployerError(409, 'import_files_missing', IMPORT_FILES_GONE)
  return imp.builtKeyPrefix
}

const mb = (n: number) => (n / 1_000_000).toFixed(1)
const MIB = 1024 * 1024

/**
 * The check an import's deploy runs first, from the stored sizes alone: no more files than the parcels allow, none over
 * Decentraland's file limit, and room in the owner's World storage (for Genesis City parcels: within Decentraland's
 * scene size limit, PARCEL_MAX_BYTES_PER_PARCEL per parcel). The scene's Virvi models that deploy with it count too
 * (their known sizes). Throws ImportError 413 otherwise.
 */
export async function assertImportFits(dest: Destination): Promise<void> {
  const prefix = await pendingImportPrefix(dest)
  const files = await getImportStore().list(prefix)
  const models = modelsBesideBuilt(await modelsInScene(dest.sceneId), files.map((f) => f.key.slice(prefix.length)))
  const budget = dclBudget(dest.parcels.length)
  const count = files.length + models.length
  if (count > budget.files) {
    throw new ImportError(413, 'scene_too_big', `Your scene has ${plural(count, 'file')}, over the ${budget.files.toLocaleString('en-US')} your ${plural(dest.parcels.length, 'parcel')} allow. Remove some files to deploy it.`)
  }
  // A model over the limit is refused when it is fetched, as in a redeploy
  const big = files.find((f) => f.size > DCL_MAX_FILE_BYTES)
  if (big) {
    throw new ImportError(413, 'file_too_big', `${big.key.slice(prefix.length)} is ${(big.size / MIB).toFixed(1)} MB, over Decentraland's ${DCL_MAX_FILE_BYTES / MIB} MB limit for one file.`)
  }
  const bytes = files.reduce((n, f) => n + f.size, 0) + models.reduce((n, m) => n + (m.bytes ?? 0), 0)
  if (dest.kind === 'parcels') {
    const max = PARCEL_MAX_BYTES_PER_PARCEL * dest.parcels.length
    if (bytes > max) {
      throw new ImportError(413, 'scene_too_big', `Your scene is ${(bytes / MIB).toFixed(1)} MB, over the ${(max / MIB).toFixed(0)} MB Decentraland allows for your ${plural(dest.parcels.length, 'parcel')}. Make it smaller to deploy it.`)
    }
    return
  }
  let stats: { maxAllowedBytes: number; usedBytes: number } | null
  try {
    stats = await getWorldsClient().getWalletStats(dest.ownerWallet)
  } catch {
    return // can't tell: let the deploy try, Decentraland will say if it's full
  }
  if (!stats || bytes <= stats.maxAllowedBytes - stats.usedBytes) return
  const freed = await replacedBytes(dest)
  if (freed === null) return // can't tell what the replaced scene frees: Decentraland will say if it's full
  const left = stats.maxAllowedBytes - stats.usedBytes + freed
  if (bytes > left) {
    throw new ImportError(413, 'world_storage_full', `Your scene needs ${mb(bytes)} MB of World storage but only ${mb(Math.max(0, left))} MB is left.`)
  }
}

/** HEAD requests in flight at once while sizing the live scene. */
const SIZE_CONCURRENCY = 16

/**
 * The storage the live scene at the destination's base takes, which the import replaces: the sum of its content files'
 * sizes (each hash once), 0 when nothing is live, null when the World or a size can't be read. Crediting all of it and
 * counting every new file is the same sum as counting only new hashes and crediting only the live hashes not reused.
 */
async function replacedBytes(dest: Destination): Promise<number | null> {
  const client = contentServerFor(dest)
  try {
    const live = (await client.liveEntities(dest)).find((e) => e.pointers.includes(dest.base))
    if (!live) return 0
    const hashes = [...new Set(live.content.map((c) => c.hash))]
    let total = 0
    for (let i = 0; i < hashes.length; i += SIZE_CONCURRENCY) {
      const sizes = await Promise.all(hashes.slice(i, i + SIZE_CONCURRENCY).map((h) => client.contentSize(h)))
      if (sizes.some((n) => n === null)) return null
      total += sizes.reduce((n: number, s) => n + s!, 0)
    }
    return total
  } catch {
    return null
  }
}

/** The deploy check for the destination: its pending import's files, else the Virvi scene's limits. */
const assertFits = (dest: Destination) => (dest.pendingImportId ? assertImportFits(dest) : assertDeployable(dest))

/** The built files under `prefix`, by scene-relative path. */
async function readBuilt(prefix: string): Promise<Map<string, Uint8Array>> {
  const store = getImportStore()
  const out = new Map<string, Uint8Array>()
  for (const { key } of await store.list(prefix)) {
    const obj = await store.get(key)
    if (!obj) throw new DeployerError(409, 'import_files_missing', IMPORT_FILES_GONE)
    out.set(key.slice(prefix.length), new Uint8Array(obj.body.buffer, obj.body.byteOffset, obj.body.byteLength))
  }
  if (!out.has('scene.json')) throw new DeployerError(409, 'import_files_missing', IMPORT_FILES_GONE)
  return out
}

/**
 * A deployment that would add nothing is never signed or uploaded. Models that were refused hold the
 * destination at needs_review with the reason (so nothing retries them on its own); otherwise the World
 * is simply up to date. Either way the destination's file list is brought in line with what's live.
 */
async function nothingToDeploy(dest: Destination, a: Assembled): Promise<DeployerError> {
  const detail = a.refused.length ? refusedLine(a.refused) : null
  await db
    .update(dclWorldDestinations)
    .set({ status: detail ? 'needs_review' : 'ok', statusDetail: detail, deployedFiles: a.deployedFiles.map((f) => f.toLowerCase()), updatedAt: new Date() })
    .where(eq(dclWorldDestinations.id, dest.id))
  return new DeployerError(409, 'nothing_to_deploy', detail ?? NOTHING_NEW)
}

/** The bundle of a deployment that had nothing new to send; the sweep never counts it as a failure. */
function noopBundle(packed: { assembled: Assembled; baseEntityId: string | null }) {
  return { added: [], refused: packed.assembled.refused, baseEntityId: packed.baseEntityId, noop: true }
}

/** Default spawn: the plot's centre along x, on the ground, 1 m in from the base edge. */
function defaultSpawn(parcels: string[]) {
  const xs = parcels.map((p) => parseParcel(p)?.x ?? 0)
  const width = Math.max(...xs) - Math.min(...xs) + 1
  return { x: (width * DCL_PARCEL_M) / 2, y: 0, z: 1 }
}

async function assembleFor(dest: Destination, timestamp: number, fetch?: ModelFetcher): Promise<{ assembled: Assembled; baseEntityId: string | null; storedPrefix?: string }> {
  if (dest.pendingImportId) {
    // An import replaces whatever is live (deployed outside Virvi too); the live entity is still what it builds on
    const prefix = await pendingImportPrefix(dest)
    const live = await liveAt(dest)
    const files = await readBuilt(prefix)
    const built = JSON.parse(new TextDecoder().decode(files.get('scene.json')!)) as SceneMetadata
    // Never trusted as stored: the build ran the creator's code, and the entity deploys where it was uploaded for
    assertBuiltPlace(destinationLocation(dest), built)
    // The creator's code runs the npm package, never Virvi's runtime: without Virvi's marker the scene stays adopted
    const { virvi: _virvi, ...metadata } = built
    // Models placed in-world deploy with it, or a re-upload would take them out of the World
    const models = await modelsInScene(dest.sceneId)
    const pointers = dest.kind === 'parcels' ? dest.parcels : undefined
    return { assembled: await assembleImported({ files, metadata, timestamp, models, fetch, pointers }), baseEntityId: live?.id ?? null, storedPrefix: prefix }
  }
  const live = await liveBaseFor(dest)
  const models = await modelsInScene(dest.sceneId)
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, dest.sceneId), columns: { name: true } })
  if (dest.lastEntityId == null && !dest.adopted) {
    const metadata = wizardSceneJson({
      title: scene?.name ?? worldOf(dest), world: worldOf(dest), base: dest.base, parcels: dest.parcels,
      spawn: dest.spawn ?? defaultSpawn(dest.parcels),
    })
    return { assembled: await assembleFresh({ metadata, models, timestamp, fetch }), baseEntityId: live?.id ?? null }
  }
  if (!live) throw new DeployerError(409, 'no_live_scene', 'Your World has no scene to add models to')
  let adopted = dest.adopted
  if (adopted && builtByVirvi(live.metadata)) {
    // Marked adopted by mistake (connected before connecting checked who built it): Virvi's runtime is live there,
    // so the scene is Virvi's to rename and upgrade.
    adopted = false
    await db.update(dclWorldDestinations).set({ adopted: false, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, dest.id))
  }
  return { assembled: await assembleRedeploy({ live, adopted, models, timestamp, fetch, title: scene?.name }), baseEntityId: live.id }
}

/** Every file in the entity, path and hash, read from the entity file itself. */
function entityContent(a: { entityId: string; files: Map<string, Uint8Array> }): ContentRef[] {
  return (JSON.parse(new TextDecoder().decode(a.files.get(a.entityId)!)) as { content: ContentRef[] }).content
}

/** Path to hash for every file in the entity. */
function contentOf(a: { entityId: string; files: Map<string, Uint8Array> }): Map<string, string> {
  return new Map(entityContent(a).map((c) => [c.file, c.hash]))
}

/** The new (not referenced-by-hash) files of an assembled deployment, path to bytes. */
function newFileBytes(a: Assembled): Map<string, Uint8Array> {
  const existing = new Set(a.existing.map((e) => e.file))
  const out = new Map<string, Uint8Array>()
  for (const [file, hash] of contentOf(a)) if (!existing.has(file)) out.set(file, a.files.get(hash)!)
  return out
}

/** Rebuilds the entity with a fresh timestamp when packing took long, so the signing window stays full. */
async function retimestamp(a: Assembled, timestamp: number): Promise<{ a: Assembled; timestamp: number }> {
  const now = Date.now()
  if (now - timestamp <= RETIMESTAMP_AFTER_MS) return { a, timestamp }
  const { entityId, files } = await buildEntity({ pointers: a.pointers, metadata: a.metadata, existing: a.existing, newFiles: newFileBytes(a), timestamp: now })
  return { a: { ...a, entityId, files }, timestamp: now }
}

async function describeNewFiles(a: Assembled, storedPrefix?: string): Promise<NewFileSource[]> {
  const models = new Map(a.newFileSources.map((s) => [s.file, s]))
  // An import: the built files from the store, the scene's models by URL
  if (storedPrefix) {
    return [...contentOf(a)].map(([file, hash]) => {
      const model = models.get(file)
      return model ? { file, hash, url: model.url } : { file, hash, storageKey: storedPrefix + file }
    })
  }
  const existing = new Set(a.existing.map((e) => e.file))
  const runtime = await runtimeFiles(DCL_RUNTIME_VERSION)
  const out: NewFileSource[] = []
  for (const [file, hash] of contentOf(a)) {
    if (existing.has(file)) continue
    const model = models.get(file)
    if (model) { out.push({ file, hash, url: model.url }); continue }
    const rt = runtime.get(file)
    if (rt && (await dclHash(rt)) === hash) { out.push({ file, hash, runtimeVersion: DCL_RUNTIME_VERSION }); continue }
    const bytes = a.files.get(hash)!
    if (bytes.byteLength > INLINE_MAX_BYTES) {
      console.error('[world-deployer] generated file too big to keep for signing:', file, bytes.byteLength)
      throw new DeployerError(500, 'deploy_failed', GENERIC_FAILURE)
    }
    out.push({ file, hash, base64: Buffer.from(bytes).toString('base64') })
  }
  return out
}

async function rebuildNewFiles(sources: NewFileSource[], fetch: ModelFetcher): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  for (const s of sources) {
    if ('url' in s) {
      let bytes: Uint8Array
      try {
        bytes = await fetch(s.url)
      } catch {
        throw new DeployerError(502, 'model_unavailable', `Couldn't download ${s.file} again`)
      }
      if (bytes.byteLength > DCL_MAX_FILE_BYTES) throw new DeployerError(502, 'model_unavailable', `${s.file} is over the 50 MB file limit`)
      out.set(s.file, bytes)
    } else if ('base64' in s) {
      out.set(s.file, new Uint8Array(Buffer.from(s.base64, 'base64')))
    } else if ('storageKey' in s) {
      const obj = await getImportStore().get(s.storageKey)
      if (!obj) throw new DeployerError(409, 'import_files_missing', IMPORT_FILES_GONE)
      out.set(s.file, new Uint8Array(obj.body.buffer, obj.body.byteOffset, obj.body.byteLength))
    } else {
      const rt = (await runtimeFiles(s.runtimeVersion)).get(s.file)
      if (!rt) throw new DeployerError(500, 'entity_mismatch')
      out.set(s.file, rt)
    }
  }
  return out
}

/** A plain-language reason for the deploy page. */
function plainError(err: unknown): string {
  if (err instanceof DeployerError) return err.message
  if (err instanceof WorldsError || err instanceof CatalystError) {
    if (err.status === 0) return err instanceof CatalystError ? "Couldn't reach Decentraland's servers. Try again in a minute." : "Couldn't reach Decentraland's Worlds server. Try again in a minute."
    let reason = err.body
    try {
      const j = JSON.parse(err.body) as { message?: string; error?: string; errors?: string[] }
      reason = j.errors?.join('; ') || j.message || j.error || err.body
    } catch { /* not JSON: keep the body */ }
    return `Decentraland rejected the deploy: ${reason.slice(0, 500) || `HTTP ${err.status}`}`
  }
  // Anything else is internal: the detail goes to the log (the callers log it), never to the owner.
  return GENERIC_FAILURE
}

/** The code an import records for a deploy error. */
function errorCodeOf(err: unknown): string {
  if (err instanceof DeployerError || err instanceof ImportError) return err.code
  if (err instanceof WorldsError || err instanceof CatalystError) return err.status === 0 ? 'world_unreachable' : 'deploy_rejected'
  return 'deploy_failed'
}

/**
 * Every deployment that ends without going live ends here: it fails (only while it is `onlyIf`, when given) and the
 * import it deploys, if any, settles by importAfterFailure. `importMessage` replaces the deployment's sentence on the
 * import when that one only makes sense on the Deploy page; `assetBundle` is stored with the failure.
 */
export async function markFailed(
  deploymentId: string, err: unknown, onlyIf?: Deployment['status'], extra: { importMessage?: string; assetBundle?: unknown } = {},
) {
  const message = plainError(err)
  const failed = await db
    .update(sceneDeployments)
    .set({ status: 'failed', errorMessage: message, ...(extra.assetBundle !== undefined ? { assetBundle: extra.assetBundle } : {}) })
    .where(and(eq(sceneDeployments.id, deploymentId), ...(onlyIf ? [eq(sceneDeployments.status, onlyIf)] : [])))
    .returning({ id: sceneDeployments.id })
  if (failed.length) await importDeployFailed([deploymentId], { code: errorCodeOf(err), message: extra.importMessage ?? message })
}

/** The destination stops waiting on the imports these deployments deploy. */
async function clearPendingImport(tx: Pick<typeof db, 'update' | 'select'>, deploymentIds: string[]) {
  const linked = tx.select({ id: sceneImports.id }).from(sceneImports).where(inArray(sceneImports.deploymentId, deploymentIds))
  await tx.update(dclWorldDestinations).set({ pendingImportId: null, updatedAt: new Date() }).where(inArray(dclWorldDestinations.pendingImportId, linked))
}

/**
 * These deployments ended without going live. An import that was deploying settles by importAfterFailure (back to
 * `built` with the sentence, or `failed`); one still waiting for a signature stays so (its window is over, so the
 * creator can start it again). Either way the World no longer waits on it.
 */
async function importDeployFailed(deploymentIds: string[], error: { code: string; message: string } | null) {
  if (!deploymentIds.length) return
  await db.transaction(async (tx) => {
    await clearPendingImport(tx, deploymentIds)
    if (error === null) return
    await tx.update(sceneImports)
      .set(importAfterFailure(error.code, error.message))
      .where(and(inArray(sceneImports.deploymentId, deploymentIds), eq(sceneImports.status, 'deploying')))
  })
}

const keeping = new Map<string, Promise<void>>()

/** Resolves when the files of `deploymentId`'s deploy have been kept, or failed to be (now, if nothing is keeping them). */
export function whenFilesKept(deploymentId: string): Promise<void> {
  return keeping.get(deploymentId) ?? Promise.resolve()
}

/**
 * After the content server accepted `entityId`: record it on the destination and deployment, link the location (the
 * World, or the parcels) to the Virvi scene, then keep the files it uploaded (`kept`, when the caller has them) in the
 * background. Nothing waits on the bucket: a file that couldn't be kept is fetched from the content server on download.
 */
export async function afterDeploy(
  dest: Destination, entityId: string, deployedFiles: string[], deploymentId: string,
  kept?: { content: ContentRef[]; files: Map<string, Uint8Array> },
): Promise<void> {
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(dclWorldDestinations)
      .set({ lastEntityId: entityId, deployedFiles: deployedFiles.map((f) => f.toLowerCase()), status: 'ok', statusDetail: null, pendingSince: null, updatedAt: now })
      .where(eq(dclWorldDestinations.id, dest.id))
    await tx
      .update(sceneDeployments)
      .set({
        status: 'deployed', deployedAt: now, catalystEntityId: entityId, errorMessage: null,
        // Mode A's bundle already has it; this covers a mode B row prepared before bundles carried it
        ...(kept ? { assetBundle: sql`coalesce(${sceneDeployments.assetBundle}, '{}'::jsonb) || ${JSON.stringify({ content: kept.content })}::jsonb` } : {}),
      })
      .where(eq(sceneDeployments.id, deploymentId))
    // The import this deployed is live: the World no longer waits on it
    await clearPendingImport(tx, [deploymentId])
    await tx.update(sceneImports)
      .set({ status: 'deployed', errorCode: null, errorMessage: null, finishedAt: now, updatedAt: now })
      .where(and(eq(sceneImports.deploymentId, deploymentId), eq(sceneImports.status, 'deploying')))
  })
  try {
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, dest.sceneId), columns: { name: true } })
    await linkLocation({
      location: destinationLocation(dest), virviSceneId: dest.sceneId, hostUserId: dest.ownerUserId, entityId,
      title: scene?.name ?? dest.worldName ?? dest.base, base: dest.base, parcels: dest.parcels,
    }, now)
  } finally {
    if (kept) {
      const run = keepDeployedFiles(kept.content, kept.files)
        .catch((err) => {
          console.error('[world-deployer] could not keep deployed files:', deploymentId, err instanceof Error ? err.message : err)
        })
        .finally(() => keeping.delete(deploymentId))
      keeping.set(deploymentId, run)
    }
  }
}

const running = new Map<string, Promise<void>>()

/** Resolves when a background deploy started here has finished (now, if none is running). */
export function whenSettled(deploymentId: string): Promise<void> {
  return running.get(deploymentId) ?? Promise.resolve()
}

/**
 * Links a new deployment to the import it deploys, moving the import to `status`; throws 409 import_superseded (which
 * rolls the deployment back) when the import was replaced meanwhile.
 */
async function linkImport(tx: Pick<typeof db, 'update'>, importId: string, deploymentId: string, status: 'deploying' | 'awaiting_signature') {
  const linked = await tx.update(sceneImports)
    .set({ status, deploymentId, errorCode: null, errorMessage: null, updatedAt: new Date() })
    .where(and(
      eq(sceneImports.id, importId),
      // or claimed by the automatic deploy (Ruling R24): deploying, nothing linked yet
      or(inArray(sceneImports.status, ['built', 'awaiting_signature']), and(eq(sceneImports.status, 'deploying'), isNull(sceneImports.deploymentId))),
    ))
    .returning({ id: sceneImports.id })
  if (!linked.length) throw new DeployerError(409, 'import_superseded', IMPORT_REPLACED)
}

/** Mode A: inserts the deployment and returns it; packing, signing and uploading run in the background. */
export async function startVirviDeploy(destinationId: string, by: string | null, opts: DeployOptions = {}): Promise<Deployment> {
  const dest = await loadDestination(destinationId)
  const signer = virviSigner()
  if (!signer) throw new DeployerError(503, 'virvi_deploys_unavailable', 'Virvi deploys are not available right now')
  if (dest.mode !== 'virvi' || !dest.grantedAt) throw new DeployerError(409, 'not_granted', 'Virvi has no deploy permission on this World')
  await assertFits(dest)

  // One at a time per destination (double clicks, a route racing the sweep): the lock serialises check + insert.
  const dep = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${dest.id}))`)
    const busy = await tx.query.sceneDeployments.findFirst({
      where: and(eq(sceneDeployments.destinationId, dest.id), inArray(sceneDeployments.status, ['building', 'deploying'])),
      columns: { id: true },
    })
    if (busy) throw new DeployerError(409, 'deploy_in_progress', 'A deploy is already running for this World')
    const [row] = await tx.insert(sceneDeployments).values({
      sceneId: dest.sceneId, platform: 'decentraland', ...ledgerOf(dest), destinationId: dest.id, status: 'building', deployedBy: by,
    }).returning()
    if (dest.pendingImportId) await linkImport(tx, dest.pendingImportId, row.id, 'deploying')
    return row
  })

  const run = runVirviDeploy(dep.id, dest, signer, opts).finally(() => running.delete(dep.id))
  running.set(dep.id, run)
  return dep
}

async function runVirviDeploy(
  deploymentId: string,
  dest: Destination,
  signer: NonNullable<ReturnType<typeof virviSigner>>,
  opts: DeployOptions,
): Promise<void> {
  let live = false
  try {
    const started = Date.now()
    const packed = await assembleFor(dest, started, opts.fetch)
    if (!packed.assembled.changed) {
      const err = await nothingToDeploy(dest, packed.assembled)
      await markFailed(deploymentId, err, undefined, { assetBundle: noopBundle(packed) })
      return
    }
    const { a } = await retimestamp(packed.assembled, started)
    const progress = { modelsTotal: a.added.length, modelsUploaded: 0 }
    const content = entityContent(a)
    const bundle = { entityId: a.entityId, pointers: a.pointers, deployedFiles: a.deployedFiles, added: a.added, refused: a.refused, baseEntityId: packed.baseEntityId, content }
    await db.update(sceneDeployments).set({ status: 'deploying', assetBundle: { ...bundle, progress } }).where(eq(sceneDeployments.id, deploymentId))
    const authChain = await signer.signChain(a.entityId)
    await contentServerFor(dest).deploy({ entityId: a.entityId, authChain, files: a.files })
    live = true
    await db
      .update(sceneDeployments)
      .set({ assetBundle: { ...bundle, progress: { ...progress, modelsUploaded: progress.modelsTotal } } })
      .where(eq(sceneDeployments.id, deploymentId))
    await afterDeploy(dest, a.entityId, a.deployedFiles, deploymentId, { content, files: a.files })
  } catch (err) {
    console.error('[world-deployer] deploy failed:', deploymentId, err instanceof Error ? err.message : err)
    // Once the World has accepted it the deployment is live; a later bookkeeping error must not say otherwise.
    if (!live) await markFailed(deploymentId, err).catch(() => {})
  }
}

/** Mode B, step 1: packs the deployment and returns the entity id for the owner to sign. */
export async function prepareSignedDeploy(
  destinationId: string,
  by: string,
  opts: DeployOptions = {},
): Promise<{ deployment: Deployment; payload: string; expiresAt: string }> {
  const dest = await loadDestination(destinationId)
  await assertFits(dest)
  const started = Date.now()
  const packed = await assembleFor(dest, started, opts.fetch)
  if (!packed.assembled.changed) {
    const err = await nothingToDeploy(dest, packed.assembled)
    // Record what was refused so the sweep keeps the destination held on it (mode A's row does the same).
    if (packed.assembled.refused.length) {
      await db.insert(sceneDeployments).values({
        sceneId: dest.sceneId, platform: 'decentraland', ...ledgerOf(dest), destinationId: dest.id, status: 'failed', deployedBy: by,
        errorMessage: err.message, assetBundle: noopBundle(packed),
      })
    }
    throw err
  }
  const { a, timestamp } = await retimestamp(packed.assembled, started)
  const bundle: SignedBundle = {
    entityId: a.entityId,
    timestamp,
    pointers: a.pointers,
    deployedFiles: a.deployedFiles,
    added: a.added,
    refused: a.refused,
    newFiles: await describeNewFiles(a, packed.storedPrefix),
    existing: a.existing,
    content: entityContent(a),
    metadataJson: JSON.stringify(a.metadata),
    baseEntityId: packed.baseEntityId,
    importId: dest.pendingImportId,
  }
  const deployment = await db.transaction(async (tx) => {
    const [row] = await tx.insert(sceneDeployments).values({
      sceneId: dest.sceneId, platform: 'decentraland', ...ledgerOf(dest), destinationId: dest.id, status: 'awaiting_signature', deployedBy: by, assetBundle: bundle,
    }).returning()
    if (dest.pendingImportId) await linkImport(tx, dest.pendingImportId, row.id, 'awaiting_signature')
    return row
  })
  return { deployment, payload: a.entityId, expiresAt: new Date(timestamp + DEPLOY_WINDOW_MS).toISOString() }
}

const NOT_PARCEL_CONTROLLER = "That signature isn't from a wallet that can deploy to every one of these parcels."

/**
 * The signature must be a valid one over `entityId`: for a World, by the World's owner (403 not_world_owner); for
 * Genesis City parcels, by its own signer, who must still be able to deploy to every parcel right now (403
 * not_parcel_controller; 503 catalyst_unreachable when Decentraland can't say).
 */
async function assertSigner(dest: Destination, chain: AuthChain, entityId: string): Promise<void> {
  if (dest.kind !== 'parcels') {
    if (!(await verifyChain(chain, entityId, dest.ownerWallet))) {
      throw new DeployerError(403, 'not_world_owner', "That signature isn't from the wallet that owns this World")
    }
    return
  }
  const signer = chainSigner(chain)
  if (!signer || !(await verifyChain(chain, entityId, signer))) throw new DeployerError(403, 'not_parcel_controller', NOT_PARCEL_CONTROLLER)
  let wallet: string | null
  try {
    ;({ wallet } = await parcelControl([signer], dest.parcels))
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) throw new DeployerError(503, 'catalyst_unreachable', "Decentraland didn't answer just now. Try again in a minute.")
    throw err
  }
  if (wallet !== signer) throw new DeployerError(403, 'not_parcel_controller', NOT_PARCEL_CONTROLLER)
}

/** Mode B, step 2: checks the signature (assertSigner), rebuilds the exact upload and sends it. */
export async function submitSignedDeploy(deploymentId: string, chain: AuthChain, opts: DeployOptions = {}): Promise<Deployment> {
  const dep = await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, deploymentId) })
  if (!dep || !dep.destinationId) throw new DeployerError(404, 'not_found')
  if (dep.status !== 'awaiting_signature') throw new DeployerError(409, 'not_awaiting_signature', 'This deploy is not waiting for a signature')
  const bundle = dep.assetBundle as SignedBundle
  if (Date.now() - bundle.timestamp > DEPLOY_WINDOW_MS) {
    const err = new DeployerError(409, 'expired', bundle.importId ? IMPORT_EXPIRED : 'The signature came too late. Start the deploy again.')
    await markFailed(dep.id, err)
    throw err
  }
  const dest = await loadDestination(dep.destinationId)
  if (bundle.importId) assertBuiltPlace(destinationLocation(dest), JSON.parse(bundle.metadataJson) as SceneMetadata)
  await assertSigner(dest, chain, bundle.entityId)
  // Claim it, so a second submit of the same signature can't upload twice. An import's deployment is claimed with its
  // import, which must still be waiting for this very deployment (a newer upload may have replaced it).
  const claimed = await db.transaction(async (tx) => {
    if (bundle.importId) {
      const imp = await tx.update(sceneImports)
        .set({ status: 'deploying', updatedAt: new Date() })
        .where(and(eq(sceneImports.id, bundle.importId), eq(sceneImports.status, 'awaiting_signature'), eq(sceneImports.deploymentId, dep.id)))
        .returning({ id: sceneImports.id })
      if (!imp.length) return 'import' as const
    }
    const [row] = await tx
      .update(sceneDeployments)
      .set({ status: 'deploying' })
      .where(and(eq(sceneDeployments.id, dep.id), eq(sceneDeployments.status, 'awaiting_signature')))
      .returning({ id: sceneDeployments.id })
    if (!row) tx.rollback()
    return 'claimed' as const
  }).catch((err) => {
    if (err instanceof TransactionRollbackError) return 'taken' as const
    throw err
  })
  if (claimed === 'import') {
    const err = new DeployerError(409, 'import_superseded', IMPORT_REPLACED)
    await markFailed(dep.id, err, 'awaiting_signature')
    throw err
  }
  if (claimed !== 'claimed') throw new DeployerError(409, 'not_awaiting_signature', 'This deploy is not waiting for a signature')

  let live = false
  try {
    const base = bundle.importId ? await liveAt(dest) : await liveBaseFor(dest)
    if ((base?.id ?? null) !== bundle.baseEntityId) {
      const stale = dest.kind === 'parcels' ? IMPORT_STALE_PARCELS : IMPORT_STALE
      throw new DeployerError(409, 'stale', bundle.importId ? stale : 'Your World changed since this deploy was prepared. Start it again.')
    }
    const newFiles = await rebuildNewFiles(bundle.newFiles, opts.fetch ?? defaultModelFetcher)
    const { entityId, files } = await buildEntity({
      pointers: bundle.pointers, metadata: JSON.parse(bundle.metadataJson) as SceneMetadata, existing: bundle.existing, newFiles, timestamp: bundle.timestamp,
    })
    if (entityId !== bundle.entityId) throw new DeployerError(500, 'entity_mismatch', 'The rebuilt deployment did not match what was signed')
    const content = bundle.content ?? entityContent({ entityId, files })
    await contentServerFor(dest).deploy({ entityId, authChain: chain, files })
    live = true
    await afterDeploy(dest, entityId, bundle.deployedFiles, dep.id, { content, files })
  } catch (err) {
    if (!live) {
      await markFailed(dep.id, err).catch(() => {})
      if (err instanceof WorldsError || err instanceof CatalystError) throw new DeployerError(502, 'deploy_rejected', plainError(err))
      throw err
    }
    console.error('[world-deployer] after deploy failed:', dep.id, err instanceof Error ? err.message : err)
  }
  return (await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, dep.id) }))!
}

/**
 * Cleans up deployments that never finished, run at the start of each sweep. A `building`/`deploying` row
 * older than the deploy window whose entity is live was accepted but lost its bookkeeping: finish it.
 * Otherwise it is marked failed (the sweep tries again). A World that can't be read leaves the row for the
 * next sweep. Mode B rows still `awaiting_signature` past the window expire.
 */
export async function reconcileStaleDeployments(now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - DEPLOY_WINDOW_MS)
  const expired = await db
    .update(sceneDeployments)
    .set({ status: 'failed', errorMessage: 'This publish request expired.' })
    .where(and(eq(sceneDeployments.status, 'awaiting_signature'), lt(sceneDeployments.createdAt, cutoff)))
    .returning({ id: sceneDeployments.id })
  // An import waiting on one of these stays awaiting_signature: the creator can start it again
  await importDeployFailed(expired.map((e) => e.id), null)

  const stale = await db
    .select()
    .from(sceneDeployments)
    .where(and(inArray(sceneDeployments.status, ['building', 'deploying']), lt(sceneDeployments.createdAt, cutoff)))
  for (const row of stale) {
    if (running.has(row.id) || !row.destinationId) continue
    try {
      const dest = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, row.destinationId) })
      if (!dest) continue
      let entities: LiveEntity[]
      try {
        entities = await contentServerFor(dest).liveEntities(dest)
      } catch {
        continue
      }
      const bundle = row.assetBundle as { entityId?: string; deployedFiles?: string[] } | null
      const live = entities.find((e) => e.pointers.includes(dest.base))
      if (bundle?.entityId && live?.id === bundle.entityId) {
        await afterDeploy(dest, bundle.entityId, bundle.deployedFiles ?? [], row.id)
      } else {
        const interrupted = new DeployerError(500, 'interrupted', 'This deploy was interrupted. Virvi will try again.')
        await markFailed(row.id, interrupted, row.status, { importMessage: IMPORT_INTERRUPTED })
      }
    } catch (err) {
      console.error('[world-deployer] reconcile failed:', row.id, err instanceof Error ? err.message : err)
    }
  }
}
