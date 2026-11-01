import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, studioJobs } from '../db/schema.js'
import { config } from '../config.js'
import { hashWorkerToken } from '../studio/machines.js'
import { checkFilePath, getStudioStore, jobFileKey, uploadKey, workspaceKey } from '../studio/store.js'
import { applyResult, parseResult } from '../studio/results.js'
import { publishStudio } from '../studio/events.js'

/**
 * Virvi's side of apps/studio-worker/CONTRACT.md. Each design's machine authenticates with its own worker token; a token
 * reaches only its design and that design's jobs. Workers upload dozens of files a job, so the global rate limit is off.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MB = 1024 * 1024
const FILE_LIMIT = 50 * MB
const WORKSPACE_LIMIT = 1024 * MB
const MAX_EVENT_TEXT = 4000

type Design = typeof studioDesigns.$inferSelect
type Job = typeof studioJobs.$inferSelect
declare module 'fastify' {
  interface FastifyRequest {
    studioDesign?: Design
    studioJob?: Job
  }
}

async function workerAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!config.studioEnabled) return reply.status(404).send({ error: 'not_found' })
  const auth = request.headers.authorization
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
  const [design] = token
    ? await db.select().from(studioDesigns).where(eq(studioDesigns.workerTokenHash, hashWorkerToken(token)))
    : []
  if (!design) return reply.status(401).send({ error: 'invalid_worker_token' })
  const params = request.params as { designId?: string; jobId?: string }
  if (params.designId !== undefined && params.designId !== design.id) return reply.status(403).send({ error: 'forbidden' })
  if (params.jobId !== undefined) {
    const [job] = UUID.test(params.jobId) ? await db.select().from(studioJobs).where(eq(studioJobs.id, params.jobId)) : []
    if (!job) return reply.status(404).send({ error: 'job_not_found' })
    if (job.designId !== design.id) return reply.status(403).send({ error: 'forbidden' })
    request.studioJob = job
  }
  request.studioDesign = design
}

export default async function studioWorkerRoutes(app: FastifyInstance) {
  await app.register(async (scope) => {
    // Auth runs before any body is read, so a request without a token never makes the server buffer anything
    scope.addHook('onRequest', workerAuth)
    const opts = { config: { rateLimit: false }, schema: { hide: true } } as const

    // The workspace streams through to the store: a gzip body of known length, never held whole in memory
    await scope.register(async (ws) => {
      ws.removeAllContentTypeParsers()
      ws.addContentTypeParser('application/gzip', (_req, payload, done) => done(null, payload))

      ws.get('/api/studio/worker/designs/:designId/workspace', opts, async (request, reply) => {
        const obj = await getStudioStore().getStream(workspaceKey(request.studioDesign!.id))
        if (!obj) return reply.status(404).send({ error: 'no_workspace' })
        if (obj.length !== undefined) reply.header('Content-Length', obj.length)
        return reply.type('application/gzip').send(obj.body)
      })

      ws.put('/api/studio/worker/designs/:designId/workspace', opts, async (request, reply) => {
        const length = Number(request.headers['content-length'])
        if (!Number.isInteger(length) || length <= 0) return reply.status(400).send({ error: 'empty_workspace' })
        if (length > WORKSPACE_LIMIT) return reply.status(413).send({ error: 'workspace_too_large' })
        await getStudioStore().putStream(workspaceKey(request.studioDesign!.id), request.body as Readable, length, 'application/gzip')
        return reply.status(204).send()
      })
    })

    // Job files keep their exact bytes whatever their type (piece.json is JSON, checker reports are text)
    await scope.register(async (files) => {
      files.removeAllContentTypeParsers()
      files.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: FILE_LIMIT }, (_req, body, done) => done(null, body))
      files.put('/api/studio/worker/jobs/:jobId/files/*', { ...opts, bodyLimit: FILE_LIMIT }, async (request, reply) => {
        const path = (request.params as { '*': string })['*']
        const checked = checkFilePath(path)
        if (!checked.ok) return reply.status(400).send({ error: 'bad_path', reason: checked.reason })
        const job = request.studioJob!
        if (job.status !== 'taken') return reply.status(409).send({ error: 'job_not_taken' })
        // A finalize job uploads only its package, and only a finalize job uploads one
        if ((checked.kind === 'final') !== (job.type === 'finalize')) {
          return reply.status(400).send({ error: 'bad_path', reason: job.type === 'finalize' ? 'a finalize job uploads only final/<category>/package.zip' : 'only a finalize job uploads a package' })
        }
        const body = request.body
        if (!Buffer.isBuffer(body)) return reply.status(400).send({ error: 'not_bytes' })
        const type = (request.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().slice(0, 100)
        await getStudioStore().put(jobFileKey(job.designId, job.id, path), body, type)
        return reply.status(204).send()
      })
    })

    // The rest take JSON only
    // A finalize job reads the paid revision's own stored files, and only the ones its payload lists; a prompt job
    // reads the owner's uploads its payload lists
    scope.get('/api/studio/worker/jobs/:jobId/inputs/*', opts, async (request, reply) => {
      const job = request.studioJob!
      const path = (request.params as { '*': string })['*']
      const missing = () => reply.status(404).send({ error: 'input_not_found' })
      if (job.type === 'prompt') {
        const listed = ((job.payload as { uploads?: { path?: unknown }[] }).uploads ?? []).some((u) => u.path === path)
        const m = /^uploads\/([0-9a-f-]{36})\/[^/]+$/.exec(path)
        if (job.status !== 'taken' || !listed || !m) return missing()
        const obj = await getStudioStore().get(uploadKey(job.designId, m[1]))
        if (!obj) return missing()
        return reply.type(obj.contentType).send(obj.body)
      }
      if (job.type !== 'finalize' || job.status !== 'taken' || !checkFilePath(path).ok) return missing()
      const pieces = ((job.payload as { finalize?: { pieces?: { files?: unknown; sourceJobId?: unknown }[] } }).finalize?.pieces) ?? []
      const piece = pieces.find((p) => Array.isArray(p.files) && p.files.includes(path))
      if (!piece || typeof piece.sourceJobId !== 'string' || !UUID.test(piece.sourceJobId)) return missing()
      const obj = await getStudioStore().getStream(jobFileKey(job.designId, piece.sourceJobId, path))
      if (!obj) return missing()
      if (obj.length !== undefined) reply.header('Content-Length', obj.length)
      return reply.type(obj.contentType).send(obj.body)
    })

    scope.get('/api/studio/worker/designs/:designId/jobs/next', opts, async (request, reply) => {
      const designId = request.studioDesign!.id
      const rows = await db.execute<{ id: string; payload: Record<string, unknown> }>(sql`
        UPDATE studio_jobs SET status = 'taken', taken_at = now()
        WHERE id = (
          SELECT id FROM studio_jobs WHERE design_id = ${designId} AND status = 'queued'
          ORDER BY background, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
        ) AND status = 'queued'
        RETURNING id, payload`)
      const job = (rows as unknown as { id: string; payload: Record<string, unknown> }[])[0]
      if (!job) return reply.status(204).send()
      await publishStudio(designId, { type: 'job', jobId: job.id, status: 'taken' })
      return reply.send({ jobId: job.id, ...job.payload })
    })

    scope.post('/api/studio/worker/jobs/:jobId/events', opts, async (request, reply) => {
      const e = request.body as { type?: unknown; text?: unknown; phase?: unknown } | null
      const job = request.studioJob!
      if (e?.type === 'progress' && typeof e.text === 'string') {
        await publishStudio(job.designId, { type: 'progress', jobId: job.id, text: e.text.slice(0, MAX_EVENT_TEXT) })
      } else if (e?.type === 'phase' && typeof e.phase === 'string' && /^[a-z_]{1,32}$/.test(e.phase)) {
        await publishStudio(job.designId, { type: 'phase', jobId: job.id, phase: e.phase })
      } else {
        return reply.status(400).send({ error: 'bad_event' })
      }
      return reply.status(204).send()
    })

    scope.post('/api/studio/worker/jobs/:jobId/result', opts, async (request, reply) => {
      const parsed = parseResult(request.body)
      if (!parsed.ok) return reply.status(400).send({ error: 'bad_result', reason: parsed.reason })
      await applyResult(request.studioJob!.id, parsed.result, new Date())
      return reply.status(204).send()
    })
  })
}
