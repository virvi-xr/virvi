/**
 * Scene import routes: a creator uploads a scene built elsewhere (Creator Hub or SDK7) for a World they own.
 *
 * POST /api/imports              — the scene zip as the raw body: checks, Virvi installed, stored, build started
 * GET  /api/imports              — the caller's own last 10 imports, any scene (the Import page's "recent imports")
 * GET  /api/imports?sceneId=     — the scene's last 10 imports (all of them with full access, else the caller's own)
 * GET  /api/imports/:id          — one import (its importer, or full access on its scene)
 * GET  /api/imports/:id/log      — its whole build log, as text
 * POST /api/imports/:id/deploy   — start its deploy (Virvi-signed on a granted World, else returns what to sign)
 *
 * Open to every plan (no feature gate). The build box's own routes are in import-build.ts.
 *
 * A trial (guest) uploads, lists and reads its imports (LIV-91): its upload is a sandbox import of a new scene, for any
 * World or parcels without an ownership check, at most TRIAL_IMPORTS of them and TRIAL_IMPORT_MAX_BYTES each. A sandbox
 * import never touches its place (imports.ts); deploying it takes an account, which claims it for the place first.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { zipSync } from 'fflate'
import { PARCEL_RE, SCENE_IMPORT_MAX_BYTES, type ImportLocation, type SceneImportMove } from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { analyticsScenes, dclWorldDestinations, sceneImports, scenes, users } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'
import { recordTrialBlocked } from '../auth/trial-events.js'
import { isUuid } from '../auth/scene-from.js'
import { getActiveSetup } from '../setup/setups.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'
import { parcelControl } from '../services/dcl/parcel-control.js'
import { getImportStore } from '../storage/private-store.js'
import { ImportError, readSceneZip, type SceneFolder } from '../services/import/scene-zip.js'
import { installVirvi } from '../services/import/install-virvi.js'
import { importSceneThumbnail } from '../services/import/scene-thumbnail.js'
import {
  importSlotGate, importSlotHooks, IMPORTS_BUSY, releaseImportSlot, trialUploadWork, uploadDeadlineMs, uploadWork, UPLOAD_TOO_SLOW,
} from '../services/import/import-work.js'
import { FILES_EXPIRED } from '../services/import/retention.js'
import { buildsAvailable, startBuild } from '../services/import/build-runner.js'
import {
  claimSandboxImport, createImport, failImport, latestImportFor, loadImportView, locationOf, originalKey, OWNER_ERROR_MESSAGES, reserveTrialImport, type SceneImportRow,
} from '../services/import/imports.js'
import { NOT_DEPLOYABLE, notParcelController, placeOwner, startImportDeploy } from '../services/import/import-deploy.js'
import { DeployerError } from '../services/dcl/world-deployer.js'
import { ownerFor, RouteError } from './dcl-destinations.js'
import { publicDeployment } from './deploy.js'

const BUILD_START_FAILED = "The build couldn't start. Try the upload again in a few minutes."
/** Messages for the destination routes' codes that carry none. */
const ROUTE_MESSAGES = OWNER_ERROR_MESSAGES
const LIST_LIMIT = 10
const MAX_SCENE_NAME = 120

const full = async (request: FastifyRequest, sceneId: string) => isFullAccess(await getSceneAccess(actorFromClaims(request.user), sceneId))

/** Maps ImportError, the deployer's and the destination routes' errors to `{ error, message }`. */
async function handle(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ImportError || err instanceof DeployerError) return reply.status(err.status).send({ error: err.code, message: err.message })
    if (err instanceof RouteError) return reply.status(err.status).send({ error: err.code, message: ROUTE_MESSAGES[err.code], ...err.extra })
    throw err
  }
}

/** A trial's refusal: 403 account_required with what it tried (and the funnel's first refusal recorded). */
class TrialRefusal extends Error {
  constructor(readonly action: string) { super(action) }
}

function refuseTrial(request: FastifyRequest, reply: FastifyReply, action: string) {
  recordTrialBlocked(request.user.id, action)
  return reply.status(403).send({ error: 'account_required', action })
}

/** The trial upload slot each guest upload holds (trialUploadWork), given back with the shared one. */
const trialSlots = new WeakMap<FastifyRequest, () => void>()
const releaseTrialSlot = (request: FastifyRequest) => trialSlots.get(request)?.()

/**
 * A trial's upload, before its body is read or a shared slot is taken: it must declare its Content-Length (411
 * length_required; a chunked body would be buffered before the cap applies), within TRIAL_IMPORT_MAX_BYTES
 * (import_larger), with an import left (more_imports), and only one guest upload runs at a time (503 imports_busy), so
 * guests never hold every upload slot.
 */
async function trialGate(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user?.trial) return
  const raw = request.headers['content-length']
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return reply.status(411).send({ error: 'length_required', message: 'Send the zip with its Content-Length.' })
  }
  if (Number(raw) > config.trialImportMaxBytes) return refuseTrial(request, reply, 'import_larger')
  const [u] = await db.select({ n: users.trialImports }).from(users).where(eq(users.id, request.user.id))
  if (!u || u.n >= config.trialImports) return refuseTrial(request, reply, 'more_imports')
  const release = trialUploadWork.tryTake()
  if (!release) return reply.status(503).send({ error: 'imports_busy', message: IMPORTS_BUSY })
  trialSlots.set(request, release)
}

/** Refuses before the body is read: no builds here means nothing is stored. */
async function buildsGate(_request: FastifyRequest, reply: FastifyReply) {
  if (!buildsAvailable()) return reply.status(503).send({ error: 'builds_unavailable', message: 'Scene builds are not available right now.' })
}

function sceneName(folder: SceneFolder, fallback: string): string {
  const title = (folder.sceneJson.display as { title?: unknown } | undefined)?.title
  const name = typeof title === 'string' ? Array.from(title.trim()).slice(0, MAX_SCENE_NAME).join('') : ''
  return name || fallback
}

/**
 * The one Virvi scene among `sceneIds` (repeats allowed), or null when there are none; throws `refusal` if any is out
 * of the importer's full access, and 409 parcels_in_use naming them when they are several different scenes.
 */
async function manageable(request: FastifyRequest, sceneIds: string[], refusal: ImportError): Promise<string | null> {
  const ids = [...new Set(sceneIds)]
  for (const id of ids) if (!(await full(request, id))) throw refusal
  if (ids.length > 1) {
    const rows = await db.select({ id: scenes.id, name: scenes.name }).from(scenes).where(inArray(scenes.id, ids))
    const names = ids.map((id) => rows.find((r) => r.id === id)?.name ?? id).map((n) => `"${n}"`).join(', ')
    throw new ImportError(409, 'parcels_in_use', `These parcels overlap more than one of your Virvi scenes (${names}). Change the parcels in scene.json so they overlap only one of them.`)
  }
  return ids[0] ?? null
}

/**
 * Which Virvi scene the import goes to. A World: the scene its destination belongs to (409 world_in_use without full
 * access), else the scene its active setup belongs to (409 world_set_up_elsewhere), else the scene of its last import
 * when the importer still has full access on it, else a new scene. Parcels: the same with a destination or an active
 * setup on any overlapping parcel (409 parcels_in_use, parcels_set_up_elsewhere), the destinations' scene first; parcels
 * that overlap several different Virvi scenes are refused (409 parcels_in_use, naming them) rather than one picked.
 */
async function sceneFor(request: FastifyRequest, location: ImportLocation, newName: () => string): Promise<{ id: string } | { newName: string }> {
  let used: string | null
  let setupScene: string | null
  if (location.kind === 'world') {
    const world = location.world
    const dest = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.worldName, world), columns: { sceneId: true } })
    used = await manageable(request, dest ? [dest.sceneId] : [], new ImportError(409, 'world_in_use', "This World is connected to a Virvi scene you can't manage."))
    const loc = used ? null : await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, `world:${world}`), columns: { id: true } })
    const setup = loc ? await getActiveSetup(loc.id) : null
    setupScene = await manageable(request, setup ? [setup.virviSceneId] : [], new ImportError(409, 'world_set_up_elsewhere', "This World is set up under a Virvi scene you can't manage."))
  } else {
    const overlap = sql`ARRAY[${sql.join(location.parcels.map((p) => sql`${p}`), sql`, `)}]::text[]`
    const dests = await db.select({ sceneId: dclWorldDestinations.sceneId }).from(dclWorldDestinations)
      .where(and(eq(dclWorldDestinations.kind, 'parcels'), sql`${dclWorldDestinations.parcels} && ${overlap}`))
    used = await manageable(request, dests.map((d) => d.sceneId), new ImportError(409, 'parcels_in_use', "These parcels are connected to a Virvi scene you can't manage."))
    const locs = used ? [] : await db.select({ id: analyticsScenes.id }).from(analyticsScenes)
      .where(and(eq(analyticsScenes.kind, 'parcels'), sql`${analyticsScenes.parcels} && ${overlap}`))
    const setups = (await Promise.all(locs.map((l) => getActiveSetup(l.id)))).flatMap((s) => (s ? [s.virviSceneId] : []))
    setupScene = await manageable(request, setups, new ImportError(409, 'parcels_set_up_elsewhere', "These parcels are set up under a Virvi scene you can't manage."))
  }
  if (used) return { id: used }
  if (setupScene) return { id: setupScene }
  const last = await latestImportFor(location)
  if (last && (await full(request, last.sceneId))) return { id: last.sceneId }
  return { newName: newName() }
}

/**
 * When an account's deploy of a sandbox import would move it onto another of the account's scenes (the place's
 * manageable scene, as sceneFor resolves it): that scene, and the sandbox scene it leaves. Null otherwise, and when
 * sceneFor refuses (the deploy says why).
 */
async function sceneMoveOf(row: SceneImportRow, targetId: string | null): Promise<SceneImportMove | null> {
  if (!targetId || targetId === row.sceneId) return null
  const rows = await db.select({ id: scenes.id, name: scenes.name }).from(scenes).where(inArray(scenes.id, [targetId, row.sceneId]))
  const target = rows.find((r) => r.id === targetId)
  if (!target) return null
  return { id: target.id, name: target.name, sandboxSceneName: rows.find((r) => r.id === row.sceneId)?.name ?? '' }
}

async function sandboxTarget(request: FastifyRequest, row: SceneImportRow): Promise<string | null> {
  try {
    const target = await sceneFor(request, locationOf(row), () => '')
    return 'id' in target ? target.id : null
  } catch (err) {
    if (err instanceof ImportError) return null
    throw err
  }
}

/** The import when the caller made it or has full access on its scene; 404 otherwise (never says whether it exists). */
async function importFor(request: FastifyRequest, id: string): Promise<SceneImportRow> {
  const row = isUuid(id) ? await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, id) }) : undefined
  if (!row || (row.userId !== request.user.id && !(await full(request, row.sceneId)))) throw new RouteError(404, 'not_found')
  return row
}

/** scene.json must list at least one valid parcel, its base among them (422 bad_scene_json). */
function checkParcels(location: Extract<ImportLocation, { kind: 'parcels' }>): void {
  if (!location.parcels.length || !location.parcels.every((p) => PARCEL_RE.test(p)) || !location.parcels.includes(location.base)) {
    throw new ImportError(422, 'bad_scene_json', 'scene.json needs at least one valid parcel, and its base must be one of them.')
  }
}

const reload = async (id: string) => (await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, id) }))!

export default async function importRoutes(app: FastifyInstance) {
  // The upload: the zip's bytes, whatever type the browser says (readSceneZip decides)
  await app.register(async (upload) => {
    upload.removeAllContentTypeParsers()
    upload.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: SCENE_IMPORT_MAX_BYTES }, (_req, body, done) => done(null, body))
    // At most IMPORT_CONCURRENCY uploads at once (import-work.ts); the slot goes back when the handler ends
    upload.addHook('preHandler', importSlotHooks.preHandler)
    upload.addHook('onResponse', importSlotHooks.onResponse)
    upload.addHook('onRequestAbort', importSlotHooks.onRequestAbort)
    // A guest's trial slot comes back with the shared one: at the response, or when a body never finished
    upload.addHook('onResponse', async (request) => { releaseTrialSlot(request) })
    upload.addHook('onRequestAbort', async (request) => { if (!request.importSlot?.bodyRead) releaseTrialSlot(request) })
    upload.setErrorHandler(async (err: FastifyError, _request, reply) => {
      if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return reply.status(413).send({ error: 'too_big', message: `The zip is larger than ${SCENE_IMPORT_MAX_BYTES / 1024 / 1024} MB.` })
      }
      throw err
    })

    // Auth, the builds check and the slot run before the body is read; the body's deadline scales with its size (R29)
    const slot = importSlotGate(uploadWork, (request) => uploadDeadlineMs(request.headers['content-length']), {
      error: 'upload_too_slow', message: UPLOAD_TOO_SLOW,
    })
    upload.post('/api/imports', {
      onRequest: [authenticate, trialGate, buildsGate, slot], bodyLimit: SCENE_IMPORT_MAX_BYTES, config: { trial: true },
    }, async (request, reply) => handle(reply, async () => {
      try {
        return await uploadImport(request, reply)
      } catch (err) {
        if (err instanceof TrialRefusal) return refuseTrial(request, reply, err.action)
        throw err
      } finally {
        releaseImportSlot(request)
        releaseTrialSlot(request)
      }
    }))
  })

  /** The importer's verified wallets must deploy to every parcel: 403 not_parcel_controller, 503 when Decentraland can't answer. */
  async function requireParcelController(userId: string, location: Extract<ImportLocation, { kind: 'parcels' }>) {
    try {
      const control = await parcelControl(await verifiedWalletsOf(userId), location.parcels)
      if (!control.wallet) {
        throw new ImportError(403, 'not_parcel_controller', notParcelController(control.missing))
      }
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) {
        throw new ImportError(503, 'catalyst_unreachable', "Decentraland didn't answer just now. Try again in a minute.")
      }
      throw err
    }
  }

  /** The upload, once its body is in: checks, Virvi installed, stored, build started. */
  async function uploadImport(request: FastifyRequest, reply: FastifyReply) {
    const trial = !!request.user.trial
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
    // A chunked body has no Content-Length for trialSizeGate: its bytes are checked here
    if (trial && body.length > config.trialImportMaxBytes) throw new TrialRefusal('import_larger')
    const folder = readSceneZip(body)
    const location = folder.location
    // A trial's import is a sandbox: no ownership check and always a new scene, since it never touches the place
    if (location.kind === 'world') {
      if (!trial) await ownerFor(request.user.id, location.world)
    } else {
      checkParcels(location)
      if (!trial) await requireParcelController(request.user.id, location)
    }
    const newName = () => sceneName(folder, location.kind === 'world' ? location.world : `Genesis City ${location.base}`)
    const scene = trial ? { newName: newName() } : await sceneFor(request, location, newName)
    // Counted once the zip reads, failed builds included; atomic, so two at once with one left can't both pass
    if (trial && !(await reserveTrialImport(request.user.id))) throw new TrialRefusal('more_imports')
    // The upload as the import reads it (node_modules/, .git/, bin/, __MACOSX/ already dropped), kept for the backup
    const kept = zipSync(Object.fromEntries(folder.files), { level: 0 })
    const { files, alreadyInstalled } = await installVirvi(folder)
    // Ruling R5: the installed files are re-zipped in memory; the upload never becomes files on disk. Stored, not
    // deflated (the box unzips it anyway), and wrapped without a copy
    const zipped = zipSync(Object.fromEntries(files), { level: 0 })
    const source = Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength)

    // N5: recorded on the import, so the page can say Virvi wasn't added again
    const row = await createImport({ userId: request.user.id, location, kind: folder.kind, scene, virviAlreadyPresent: alreadyInstalled, sandbox: trial })
    try {
      // The creator's own files, kept for the Virvi-free backup; recorded only once they are stored
      const original = originalKey(row.id)
      await getImportStore().put(original, Buffer.from(kept.buffer, kept.byteOffset, kept.byteLength), 'application/zip')
      await db.update(sceneImports).set({ originalKey: original }).where(eq(sceneImports.id, row.id))
      await getImportStore().put(row.sourceKey, source, 'application/zip')
    } catch (err) {
      request.log.error({ err }, `[scene-import] storing the source of import ${row.id} failed`)
      await failImport(row.id, 'store_failed', "The upload couldn't be stored. Try again in a few minutes.")
      return reply.status(500).send({ error: 'store_failed', message: "The upload couldn't be stored. Try again in a few minutes.", importId: row.id })
    }
    // LIV-89: the scene's own thumbnail becomes the Virvi scene's (never fails the import). Genesis City parcel imports
    // are out of its scope
    if (location.kind === 'world') {
      const thumb = await importSceneThumbnail(row.sceneId, folder)
      try {
        if (thumb.outcome) await db.update(sceneImports).set({ thumbnailOutcome: thumb.outcome, thumbnailNote: thumb.note }).where(eq(sceneImports.id, row.id))
      } catch (err) {
        request.log.error({ err }, `[scene-import] recording the thumbnail of import ${row.id} failed`)
      }
    }
    try {
      await startBuild(row.id)
    } catch (err) {
      // The import must not sit in `uploaded` holding the World
      const known = err instanceof ImportError
      if (!known) request.log.error({ err }, `[scene-import] starting the build of import ${row.id} failed`)
      await failImport(row.id, known ? err.code : 'build_start_failed', known ? err.message : BUILD_START_FAILED)
    }
    // startBuild fails the import itself when its machine won't start, and returns
    const after = await reload(row.id)
    if (after.status === 'failed') {
      return reply.status(502).send({ error: 'build_start_failed', message: after.errorMessage ?? BUILD_START_FAILED, importId: row.id })
    }
    return reply.status(201).send({ import: await loadImportView(after) })
  }

  await app.register(async (reads) => {
    reads.addHook('preHandler', authenticate)

    // Ruling R1: the creator starts the deploy of a built import (or one whose signature window passed)
    reads.post<{ Params: { id: string } }>('/api/imports/:id/deploy', async (request, reply) => handle(reply, async () => {
      let row = await importFor(request, request.params.id)
      if (!(await loadImportView(row)).canDeploy) throw new ImportError(409, 'not_deployable', NOT_DEPLOYABLE)
      // A converted guest's sandbox import takes its place only once its account may deploy there (a refusal changes
      // nothing), on the scene an upload by this account would get: the place's manageable scene, else its own
      // The page told the user before this (the import view's usesScene); the answer names the scene too
      let usesScene: SceneImportMove | null = null
      if (row.sandbox) {
        await placeOwner(row, request.user.id)
        const target = await sceneFor(request, locationOf(row), () => '')
        usesScene = await sceneMoveOf(row, 'id' in target ? target.id : null)
        row = await claimSandboxImport(row, 'id' in target ? target.id : row.sceneId)
      }
      const started = (await startImportDeploy(row, request.user.id))!
      const moved = usesScene ? { usesScene } : {}
      if (started.mode === 'virvi') return reply.status(202).send({ deployment: publicDeployment(started.deployment), ...moved })
      return reply.send({ deployment: publicDeployment(started.deployment), payload: started.payload, expiresAt: started.expiresAt, ...moved })
    }))

    // A trial lists and reads its own imports (importFor and full() give it nothing else); deploying takes an account
    const trialRead = { config: { trial: true as const } }
    reads.get<{ Querystring: { sceneId?: string } }>('/api/imports', trialRead, async (request, reply) => handle(reply, async () => {
      const { sceneId } = request.query
      if (sceneId === undefined) {
        const rows = await db.select().from(sceneImports).where(eq(sceneImports.userId, request.user.id))
          .orderBy(desc(sceneImports.createdAt)).limit(LIST_LIMIT)
        return reply.send({ imports: await Promise.all(rows.map(loadImportView)) })
      }
      if (!isUuid(sceneId)) throw new RouteError(400, 'invalid_scene')
      const where = (await full(request, sceneId))
        ? eq(sceneImports.sceneId, sceneId)
        : and(eq(sceneImports.sceneId, sceneId), eq(sceneImports.userId, request.user.id))
      const rows = await db.select().from(sceneImports).where(where).orderBy(desc(sceneImports.createdAt)).limit(LIST_LIMIT)
      return reply.send({ imports: await Promise.all(rows.map(loadImportView)) })
    }))

    reads.get<{ Params: { id: string } }>('/api/imports/:id', trialRead, async (request, reply) => handle(reply, async () => {
      const row = await importFor(request, request.params.id)
      const view = await loadImportView(row)
      // An account about to deploy a sandbox import learns first that it moves onto the place's existing scene
      const usesScene = row.sandbox && !request.user.trial ? await sceneMoveOf(row, await sandboxTarget(request, row)) : null
      return reply.send({ import: usesScene ? { ...view, usesScene } : view })
    }))

    reads.get<{ Params: { id: string } }>('/api/imports/:id/log', trialRead, async (request, reply) => handle(reply, async () => {
      const row = await importFor(request, request.params.id)
      if (row.filesDeletedAt) return reply.status(410).send({ error: 'files_expired', message: FILES_EXPIRED })
      const obj = row.logKey ? await getImportStore().getStream(row.logKey) : null
      if (!obj) throw new RouteError(404, 'no_log')
      if (obj.length !== undefined) reply.header('Content-Length', obj.length)
      return reply.type('text/plain; charset=utf-8').send(obj.body)
    }))
  })
}
