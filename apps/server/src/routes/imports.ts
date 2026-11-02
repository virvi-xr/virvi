/**
 * Scene import routes: a creator uploads a scene built elsewhere (Creator Hub or SDK7) for a World they own.
 *
 * POST /api/imports              — the scene zip as the raw body: checks, Virvi installed, stored, build started
 * GET  /api/imports?sceneId=     — the scene's last 10 imports (all of them with full access, else the caller's own)
 * GET  /api/imports/:id          — one import (its importer, or full access on its scene)
 * GET  /api/imports/:id/log      — its whole build log, as text
 * POST /api/imports/:id/deploy   — start its deploy (Virvi-signed on a granted World, else returns what to sign)
 *
 * Open to every plan (no feature gate). The build box's own routes are in import-build.ts.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { zipSync } from 'fflate'
import { SCENE_IMPORT_MAX_BYTES } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { analyticsScenes, dclWorldDestinations, sceneImports } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'
import { isUuid } from '../auth/scene-from.js'
import { getActiveSetup } from '../setup/setups.js'
import { getImportStore } from '../storage/private-store.js'
import { ImportError, readSceneZip, type SceneFolder } from '../services/import/scene-zip.js'
import { installVirvi } from '../services/import/install-virvi.js'
import { buildsAvailable, startBuild } from '../services/import/build-runner.js'
import {
  createImport, failImport, latestImportFor, loadImportView, OWNER_ERROR_MESSAGES, type SceneImportRow,
} from '../services/import/imports.js'
import { NOT_DEPLOYABLE, startImportDeploy } from '../services/import/import-deploy.js'
import { DeployerError } from '../services/dcl/world-deployer.js'
import { ownerFor, RouteError } from './dcl-destinations.js'
import { publicDeployment } from './deploy.js'

const PARCELS_NOT_YET = 'Genesis City imports are coming soon. For now, import a scene whose scene.json names a World.'
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

/** Refuses before the body is read: no builds here means nothing is stored. */
async function buildsGate(_request: FastifyRequest, reply: FastifyReply) {
  if (!buildsAvailable()) return reply.status(503).send({ error: 'builds_unavailable', message: 'Scene builds are not available right now.' })
}

function sceneName(folder: SceneFolder, world: string): string {
  const title = (folder.sceneJson.display as { title?: unknown } | undefined)?.title
  const name = typeof title === 'string' ? Array.from(title.trim()).slice(0, MAX_SCENE_NAME).join('') : ''
  return name || world
}

/**
 * Which Virvi scene the World's import goes to: the scene its destination belongs to (409 world_in_use without full
 * access), else the scene its active setup belongs to (409 world_set_up_elsewhere), else the scene of its last import
 * when the importer still has full access on it, else a new scene.
 */
async function sceneFor(request: FastifyRequest, world: string, folder: SceneFolder): Promise<{ id: string } | { newName: string }> {
  const dest = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.worldName, world), columns: { sceneId: true } })
  if (dest) {
    if (!(await full(request, dest.sceneId))) throw new ImportError(409, 'world_in_use', "This World is connected to a Virvi scene you can't manage.")
    return { id: dest.sceneId }
  }
  const loc = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, `world:${world}`), columns: { id: true } })
  const setup = loc ? await getActiveSetup(loc.id) : null
  if (setup) {
    if (!(await full(request, setup.virviSceneId))) throw new ImportError(409, 'world_set_up_elsewhere', "This World is set up under a Virvi scene you can't manage.")
    return { id: setup.virviSceneId }
  }
  const last = await latestImportFor(world)
  if (last && (await full(request, last.sceneId))) return { id: last.sceneId }
  return { newName: sceneName(folder, world) }
}

/** The import when the caller made it or has full access on its scene; 404 otherwise (never says whether it exists). */
async function importFor(request: FastifyRequest, id: string): Promise<SceneImportRow> {
  const row = isUuid(id) ? await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, id) }) : undefined
  if (!row || (row.userId !== request.user.id && !(await full(request, row.sceneId)))) throw new RouteError(404, 'not_found')
  return row
}

const reload = async (id: string) => (await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, id) }))!

export default async function importRoutes(app: FastifyInstance) {
  // The upload: the zip's bytes, whatever type the browser says (readSceneZip decides)
  await app.register(async (upload) => {
    upload.removeAllContentTypeParsers()
    upload.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: SCENE_IMPORT_MAX_BYTES }, (_req, body, done) => done(null, body))
    upload.setErrorHandler(async (err: FastifyError, _request, reply) => {
      if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return reply.status(413).send({ error: 'too_big', message: `The zip is larger than ${SCENE_IMPORT_MAX_BYTES / 1024 / 1024} MB.` })
      }
      throw err
    })

    // Auth and the builds check run before the body is read
    upload.post('/api/imports', { onRequest: [authenticate, buildsGate], bodyLimit: SCENE_IMPORT_MAX_BYTES }, async (request, reply) => handle(reply, async () => {
      const folder = readSceneZip(Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0))
      if (folder.location.kind !== 'world') throw new ImportError(422, 'parcels_not_yet', PARCELS_NOT_YET)
      const world = folder.location.world
      await ownerFor(request.user.id, world)
      const scene = await sceneFor(request, world, folder)
      const { files, alreadyInstalled } = await installVirvi(folder)
      if (alreadyInstalled) request.log.info(`[scene-import] ${world} already starts Virvi: only its @virvixr/dcl range was checked`)
      // Ruling R5: the installed files are re-zipped in memory; the upload never becomes files on disk
      const source = Buffer.from(zipSync(Object.fromEntries(files)))

      const row = await createImport({ userId: request.user.id, world, kind: folder.kind, scene })
      try {
        await getImportStore().put(row.sourceKey, source, 'application/zip')
      } catch (err) {
        request.log.error({ err }, `[scene-import] storing the source of import ${row.id} failed`)
        await failImport(row.id, 'store_failed', "The upload couldn't be stored. Try again in a few minutes.")
        return reply.status(500).send({ error: 'store_failed', message: "The upload couldn't be stored. Try again in a few minutes.", importId: row.id })
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
    }))
  })

  await app.register(async (reads) => {
    reads.addHook('preHandler', authenticate)

    // Ruling R1: the creator starts the deploy of a built import (or one whose signature window passed)
    reads.post<{ Params: { id: string } }>('/api/imports/:id/deploy', async (request, reply) => handle(reply, async () => {
      const row = await importFor(request, request.params.id)
      if (!(await loadImportView(row)).canDeploy) throw new ImportError(409, 'not_deployable', NOT_DEPLOYABLE)
      const started = (await startImportDeploy(row, request.user.id))!
      if (started.mode === 'virvi') return reply.status(202).send({ deployment: publicDeployment(started.deployment) })
      return reply.send({ deployment: publicDeployment(started.deployment), payload: started.payload, expiresAt: started.expiresAt })
    }))

    reads.get<{ Querystring: { sceneId?: string } }>('/api/imports', async (request, reply) => handle(reply, async () => {
      const { sceneId } = request.query
      if (!isUuid(sceneId)) throw new RouteError(400, 'invalid_scene')
      const where = (await full(request, sceneId))
        ? eq(sceneImports.sceneId, sceneId)
        : and(eq(sceneImports.sceneId, sceneId), eq(sceneImports.userId, request.user.id))
      const rows = await db.select().from(sceneImports).where(where).orderBy(desc(sceneImports.createdAt)).limit(LIST_LIMIT)
      return reply.send({ imports: await Promise.all(rows.map(loadImportView)) })
    }))

    reads.get<{ Params: { id: string } }>('/api/imports/:id', async (request, reply) => handle(reply, async () => {
      return reply.send({ import: await loadImportView(await importFor(request, request.params.id)) })
    }))

    reads.get<{ Params: { id: string } }>('/api/imports/:id/log', async (request, reply) => handle(reply, async () => {
      const row = await importFor(request, request.params.id)
      const obj = row.logKey ? await getImportStore().getStream(row.logKey) : null
      if (!obj) throw new RouteError(404, 'no_log')
      if (obj.length !== undefined) reply.header('Content-Length', obj.length)
      return reply.type('text/plain; charset=utf-8').send(obj.body)
    }))
  })
}
