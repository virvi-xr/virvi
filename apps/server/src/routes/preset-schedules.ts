import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenePresets, scenePresetScheduleRuns, scenePresetSchedules, scenes } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess } from '../auth/permissions.js'
import { canManagePresets } from '../scenes/presets.js'
import { describeSchedule, findClash, listSchedules, nextRunsOf, parseScheduleInput, ScheduleError, specOf, withEventTimes, type ScheduleInput } from '../scenes/preset-schedules.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Scheduled presets (LIV-86): web only, for the same people who manage presets (hosts, co-hosts, editors). Booking
 * crew and viewers get 403. A schedule may only use presets of its own scene.
 */
export default async function presetScheduleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  const allowed = async (request: FastifyRequest, sceneId: string) => canManagePresets(await getSceneAccess(actorFromClaims(request.user), sceneId))

  /** Both presets must be this scene's; then no clash with its other enabled schedules. */
  async function check(sceneId: string, input: ScheduleInput, ignoreId?: string) {
    const ids = [input.presetId, input.returnToPresetId].filter((x): x is string => !!x)
    const found = await db.select({ id: scenePresets.id }).from(scenePresets).where(and(inArray(scenePresets.id, ids), eq(scenePresets.sceneId, sceneId)))
    if (found.length !== new Set(ids).size) throw new ScheduleError(400, 'bad_schedule', 'Use presets of this scene.')
    const clash = await findClash(sceneId, input, new Date(), ignoreId)
    if (clash) {
      const name = (await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, clash.presetId), columns: { name: true } }))?.name ?? 'a preset'
      throw Object.assign(new ScheduleError(409, 'schedule_overlap', `This overlaps the schedule "${describeSchedule(specOf(clash), name)}".`), { clashId: clash.id })
    }
  }

  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ScheduleError) return reply.status(e.status).send({ error: e.code, message: e.message, ...((e as any).clashId ? { scheduleId: (e as any).clashId } : {}) })
    throw e
  }

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/preset-schedules', async (request, reply) => {
    const { sceneId } = request.params
    if (!UUID_RE.test(sceneId) || !(await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { id: true } }))) return reply.status(404).send({ error: 'Scene not found' })
    if (!(await allowed(request, sceneId))) return reply.status(403).send({ error: 'Forbidden' })
    return reply.send(await listSchedules(sceneId))
  })

  app.post<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/preset-schedules', async (request, reply) => {
    const { sceneId } = request.params
    if (!UUID_RE.test(sceneId) || !(await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { id: true } }))) return reply.status(404).send({ error: 'Scene not found' })
    if (!(await allowed(request, sceneId))) return reply.status(403).send({ error: 'Forbidden' })
    try {
      const body = (request.body ?? {}) as Record<string, unknown>
      // A schedule for an event takes its times from the event, so its own time fields may be left out
      const placeholder = typeof body.eventId === 'string' ? { recurrence: 'once', startDate: '2000-01-01', startTime: '00:00', timezone: 'UTC', ...body } : body
      const input = await withEventTimes(sceneId, parseScheduleInput(placeholder))
      await check(sceneId, input)
      const [row] = await db.insert(scenePresetSchedules).values({ sceneId, ...input, createdBy: request.user.id }).returning()
      return reply.status(201).send({ schedule: { ...row, nextRuns: nextRunsOf(row, new Date()) } })
    } catch (e) {
      return fail(reply, e)
    }
  })

  async function ownSchedule(request: FastifyRequest<{ Params: { scheduleId: string } }>, reply: FastifyReply) {
    const { scheduleId } = request.params
    const row = UUID_RE.test(scheduleId) ? await db.query.scenePresetSchedules.findFirst({ where: eq(scenePresetSchedules.id, scheduleId) }) : undefined
    if (!row) { reply.status(404).send({ error: 'Schedule not found' }); return null }
    if (!(await allowed(request, row.sceneId))) { reply.status(403).send({ error: 'Forbidden' }); return null }
    return row
  }

  /** Ends the schedule's run in progress (it was paused, changed or deleted); the live preset stays as it is. */
  const endOpenRuns = (scheduleId: string, outcome: string) =>
    db.update(scenePresetScheduleRuns).set({ status: 'ended', endedAt: new Date(), outcome })
      .where(and(eq(scenePresetScheduleRuns.scheduleId, scheduleId), inArray(scenePresetScheduleRuns.status, ['active', 'held'])))

  app.patch<{ Params: { scheduleId: string } }>('/api/preset-schedules/:scheduleId', async (request, reply) => {
    const row = await ownSchedule(request, reply)
    if (!row) return reply
    try {
      const input = await withEventTimes(row.sceneId, parseScheduleInput((request.body ?? {}) as Record<string, unknown>, row as unknown as ScheduleInput))
      await check(row.sceneId, input, row.id)
      const [updated] = await db.update(scenePresetSchedules).set({ ...input, updatedAt: new Date() }).where(eq(scenePresetSchedules.id, row.id)).returning()
      if (!input.enabled && row.enabled) await endOpenRuns(row.id, 'paused')
      return reply.send({ schedule: { ...updated, nextRuns: nextRunsOf(updated, new Date()) } })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.delete<{ Params: { scheduleId: string } }>('/api/preset-schedules/:scheduleId', async (request, reply) => {
    const row = await ownSchedule(request, reply)
    if (!row) return reply
    await db.delete(scenePresetSchedules).where(eq(scenePresetSchedules.id, row.id))
    return reply.status(204).send()
  })
}
