import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import { unzipSync } from 'fflate'
import { db } from '../db/connection.js'
import { sceneImports } from '../db/schema.js'
import { getImportStore } from '../storage/private-store.js'
import { ImportError, safeSegments, worldNameOf } from '../services/import/scene-zip.js'
import { buildLogKey, buildTokenMatches, builtKeyPrefix, failBuild, getOnBuildDone } from '../services/import/build-runner.js'

/**
 * Virvi's side of the wire contract in apps/scene-builder/README.md. The build box authenticates with its one-build
 * token, which reaches only its own import and only while that import is building; the result or the failure report
 * clears it, so a box can answer once. No scene pass, user token or rate limit applies.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MB = 1024 * 1024
const RESULT_LIMIT = 200 * MB
const MAX_BUILT_FILES = 5000
const MAX_BUILT_BYTES = 500 * MB
/** The box sends at most 64 KB of log tail; anything up to this is kept as sent. */
const FAILED_LOG_LIMIT = 256 * 1024
/** Ruling R9: X-Build-Log is base64 of at most the last 8 KB of the log. */
const HEADER_LOG_BYTES = 8 * 1024
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

type SceneImport = typeof sceneImports.$inferSelect
declare module 'fastify' {
  interface FastifyRequest {
    sceneImport?: SceneImport
  }
}

async function buildAuth(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id?: string }
  const auth = request.headers.authorization
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
  const [row] = token && id && UUID.test(id) ? await db.select().from(sceneImports).where(eq(sceneImports.id, id)) : []
  if (!row || !buildTokenMatches(token, row.buildTokenHash)) return reply.status(401).send({ error: 'invalid_build_token' })
  request.sceneImport = row
}

/** The decoded X-Build-Log, or null when it is missing or not base64 (a good build is never failed over its log). */
function headerLog(raw: string | string[] | undefined): Buffer | null {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (!v || v.length % 4 !== 0 || !BASE64.test(v)) return null
  const log = Buffer.from(v, 'base64')
  return log.length > HEADER_LOG_BYTES ? log.subarray(log.length - HEADER_LOG_BYTES) : log
}

/** The built files by scene-relative path, or throws ImportError with a reason short enough for the log. */
function readBuiltZip(zip: Buffer): Map<string, Uint8Array> {
  const pathByName = new Map<string, string>()
  const seen = new Set<string>()
  let total = 0
  let raw: Record<string, Uint8Array>
  try {
    raw = unzipSync(zip, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false
        // The box zips paths it built itself, so anything odd is refused rather than normalised
        if (f.name.includes('\\')) throw new ImportError(422, 'unsafe_path', `Unsafe path in the result: ${f.name.slice(0, 200)}`)
        const segs = safeSegments(f.name)
        if (segs.length === 0) return false
        const path = segs.join('/')
        if (seen.has(path)) throw new ImportError(422, 'unsafe_path', `Duplicate path in the result: ${path.slice(0, 200)}`)
        seen.add(path)
        if (seen.size > MAX_BUILT_FILES) throw new ImportError(413, 'too_many_files', `The result has more than ${MAX_BUILT_FILES} files.`)
        total += f.originalSize
        if (total > MAX_BUILT_BYTES) throw new ImportError(413, 'too_big', 'The unzipped result is larger than 500 MB.')
        pathByName.set(f.name, path)
        return true
      },
    })
  } catch (e) {
    if (e instanceof ImportError) throw new ImportError(e.status, e.code, e.message.slice(0, 300))
    throw new ImportError(400, 'not_a_zip', 'The result is not a readable zip.')
  }
  const files = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(raw)) files.set(pathByName.get(name)!, data)
  if (!files.has('scene.json')) throw new ImportError(422, 'no_scene_json', 'The result has no scene.json.')
  return files
}

/** The World, parcels and base a scene.json names, or null when it can't be read. */
function placeOf(bytes: Uint8Array | undefined): { world: string | null; parcels: string; base: unknown } | null {
  if (!bytes) return null
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes)) as { worldConfiguration?: { name?: unknown }; scene?: { parcels?: unknown; base?: unknown } }
    return { world: worldNameOf(j?.worldConfiguration?.name), parcels: JSON.stringify(j?.scene?.parcels ?? null), base: j?.scene?.base ?? null }
  } catch {
    return null
  }
}

/**
 * Why the built scene.json may not be deployed, or null: the build runs the creator's code, which must not move the
 * scene to another World or other parcels than the uploaded scene.json's.
 */
async function movedReason(imp: SceneImport, files: Map<string, Uint8Array>): Promise<string | null> {
  const built = placeOf(files.get('scene.json'))
  if (built?.world !== imp.worldName) return `the build changed the World in scene.json from ${imp.worldName} to ${built?.world ?? 'none'}.`
  const source = await getImportStore().get(imp.sourceKey)
  let uploaded: ReturnType<typeof placeOf> = null
  try {
    uploaded = source ? placeOf(unzipSync(source.body, { filter: (f) => f.name === 'scene.json' })['scene.json']) : null
  } catch { /* unreadable: refused below */ }
  if (!uploaded) return 'the uploaded scene.json could not be read to check the build against it.'
  if (built.parcels !== uploaded.parcels || built.base !== uploaded.base) return 'the build changed scene.parcels or scene.base in scene.json.'
  return null
}

/** Ruling R12: a result Virvi won't take fails the import here, with the box's log and the reason, and spends the token. */
async function refuse(request: FastifyRequest, reply: FastifyReply, status: number, reason: string) {
  const imp = request.sceneImport!
  const log = Buffer.concat([headerLog(request.headers['x-build-log']) ?? Buffer.alloc(0), Buffer.from(`\n[virvi] The build result was refused: ${reason}\n`)])
  await failBuild(imp.id, log, imp.buildTokenHash!)
  return reply.status(status).send({ error: 'result_refused', reason })
}

const tooLarge = (err: FastifyError) => err.code === 'FST_ERR_CTP_BODY_TOO_LARGE'

export default async function importBuildRoutes(app: FastifyInstance) {
  await app.register(async (scope) => {
    // Auth runs before any body is read, so a request without the token never makes the server buffer anything
    scope.addHook('onRequest', buildAuth)
    const opts = { config: { rateLimit: false }, schema: { hide: true } } as const

    scope.get('/api/imports/build/:id/source', opts, async (request, reply) => {
      const imp = request.sceneImport!
      if (imp.status !== 'building') return reply.status(409).send({ error: 'not_building' })
      const obj = await getImportStore().getStream(imp.sourceKey)
      if (!obj) return reply.status(404).send({ error: 'no_source' })
      if (obj.length !== undefined) reply.header('Content-Length', obj.length)
      return reply.type('application/zip').send(obj.body)
    })

    // The result: the deployable files as one zip
    await scope.register(async (res) => {
      res.removeAllContentTypeParsers()
      res.addContentTypeParser('application/zip', { parseAs: 'buffer', bodyLimit: RESULT_LIMIT }, (_req, body, done) => done(null, body))
      // A body the parser refuses (too large, not a zip type) is a refused result too
      res.setErrorHandler(async (err: FastifyError, request, reply) => {
        const status = err.statusCode ?? 500
        if (status >= 500 || request.sceneImport?.status !== 'building') throw err
        return refuse(request, reply, status, tooLarge(err) ? 'it is larger than 200 MB.' : 'it is not an application/zip body.')
      })

      res.post('/api/imports/build/:id/result', { ...opts, bodyLimit: RESULT_LIMIT }, async (request, reply) => {
        const imp = request.sceneImport!
        if (imp.status !== 'building') return reply.status(409).send({ error: 'not_building' })
        let files: Map<string, Uint8Array>
        try {
          files = readBuiltZip(Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0))
        } catch (err) {
          if (err instanceof ImportError) return refuse(request, reply, err.status, err.message)
          throw err
        }
        const moved = await movedReason(imp, files)
        if (moved) return refuse(request, reply, 422, moved)

        // Spend the token first: one result is taken, and a failure report racing it is refused
        const claimed = await db.update(sceneImports).set({ buildTokenHash: null, updatedAt: new Date() })
          .where(and(eq(sceneImports.id, imp.id), eq(sceneImports.status, 'building'), eq(sceneImports.buildTokenHash, imp.buildTokenHash!)))
          .returning({ id: sceneImports.id })
        if (!claimed.length) return reply.status(401).send({ error: 'invalid_build_token' })

        const store = getImportStore()
        const prefix = builtKeyPrefix(imp.id)
        const log = headerLog(request.headers['x-build-log'])
        try {
          for (const [path, data] of files) await store.put(prefix + path, Buffer.from(data), 'application/octet-stream')
          if (log) await store.put(buildLogKey(imp.id), log, 'text/plain; charset=utf-8')
        } catch (err) {
          request.log.error({ err }, `[scene-build] storing the result of import ${imp.id} failed`)
          await store.deletePrefix(prefix).catch(() => {})
          await failBuild(imp.id, Buffer.concat([log ?? Buffer.alloc(0), Buffer.from('\n[virvi] The built files could not be stored. Try the upload again.\n')]))
          return reply.status(500).send({ error: 'store_failed' })
        }

        const now = new Date()
        const built = await db.update(sceneImports).set({
          status: 'built', builtAt: now, builtKeyPrefix: prefix, logKey: log ? buildLogKey(imp.id) : null, updatedAt: now,
        }).where(and(eq(sceneImports.id, imp.id), eq(sceneImports.status, 'building'), isNull(sceneImports.buildTokenHash)))
          .returning({ id: sceneImports.id })
        // The sweep timed it out while the files were stored: they're not this import's any more
        if (!built.length) {
          await store.deletePrefix(prefix).catch(() => {})
          return reply.status(409).send({ error: 'not_building' })
        }
        // The deploy that follows is not the box's business; it gets its answer now
        getOnBuildDone()(imp.id).catch((err) => request.log.error({ err }, `[scene-build] after the build of import ${imp.id}`))
        return reply.status(204).send()
      })
    })

    // The failure report: the log tail as text
    await scope.register(async (failed) => {
      failed.removeAllContentTypeParsers()
      failed.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: FAILED_LOG_LIMIT }, (_req, body, done) => done(null, body))
      failed.setErrorHandler(async (err: FastifyError, request, reply) => {
        const imp = request.sceneImport
        if (!tooLarge(err) || imp?.status !== 'building') throw err
        await failBuild(imp.id, Buffer.from('[virvi] The build failed, and its log was too large to keep.\n'), imp.buildTokenHash!)
        return reply.status(413).send({ error: 'log_too_large' })
      })

      failed.post('/api/imports/build/:id/failed', { ...opts, bodyLimit: FAILED_LOG_LIMIT }, async (request, reply) => {
        const imp = request.sceneImport!
        if (imp.status !== 'building') return reply.status(409).send({ error: 'not_building' })
        const log = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
        if (!(await failBuild(imp.id, log, imp.buildTokenHash!))) return reply.status(401).send({ error: 'invalid_build_token' })
        return reply.status(204).send()
      })
    })
  })
}
