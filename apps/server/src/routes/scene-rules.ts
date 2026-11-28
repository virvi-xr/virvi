import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenePresets, sceneRules } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { recordSceneActivity, requestActor } from '../scenes/activity.js'
import { checkRule, countRules, rulesOf, RULES_PER_PRESET } from '../rules/rules.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const view = (r: typeof sceneRules.$inferSelect) => ({ id: r.id, presetId: r.presetId, name: r.name, enabled: r.enabled, trigger: r.trigger, actions: r.actions, createdAt: r.createdAt, updatedAt: r.updatedAt })

/** Scene rules (LIV-196): a preset's "when this widget does this, do that" list. Editors only. */
export default async function sceneRuleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  async function presetFor(presetId: string, request: any) {
    if (!UUID.test(presetId)) return { status: 404, error: 'Preset not found' }
    const preset = await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, presetId), with: { scene: { columns: { deletedAt: true } } } })
    if (!preset || preset.scene?.deletedAt) return { status: 404, error: 'Preset not found' }
    const access = await getSceneAccess(actorFromClaims(request.user), preset.sceneId)
    if (!hasScope(access, 'scene.edit')) return { status: 403, error: 'Forbidden' }
    return { preset }
  }
  async function ruleFor(ruleId: string, request: any) {
    if (!UUID.test(ruleId)) return { status: 404, error: 'Rule not found' }
    const rule = await db.query.sceneRules.findFirst({ where: eq(sceneRules.id, ruleId) })
    if (!rule) return { status: 404, error: 'Rule not found' }
    const p = await presetFor(rule.presetId, request)
    if ('status' in p) return { status: p.status === 404 ? 404 : p.status, error: p.status === 404 ? 'Rule not found' : p.error }
    return { rule, preset: p.preset }
  }

  app.get<{ Params: { presetId: string } }>('/api/presets/:presetId/rules', async (request, reply) => {
    const p = await presetFor(request.params.presetId, request)
    if ('status' in p) return reply.status(p.status!).send({ error: p.error })
    return { rules: (await rulesOf([p.preset.id])).map(view), limit: RULES_PER_PRESET }
  })

  app.post<{ Params: { presetId: string }; Body: Record<string, unknown> }>('/api/presets/:presetId/rules', async (request, reply) => {
    const p = await presetFor(request.params.presetId, request)
    if ('status' in p) return reply.status(p.status!).send({ error: p.error })
    if ((await countRules(p.preset.id)) >= RULES_PER_PRESET) return reply.status(409).send({ error: 'too_many_rules', message: `A preset can have up to ${RULES_PER_PRESET} rules` })
    const clean = await checkRule(p.preset.id, p.preset.sceneId, request.body ?? {})
    if ('error' in clean) return reply.status(400).send(clean)
    const [rule] = await db.insert(sceneRules).values({ presetId: p.preset.id, name: clean.name ?? '', enabled: clean.enabled ?? true, trigger: clean.trigger!, actions: clean.actions! }).returning()
    await recordSceneActivity(p.preset.sceneId, requestActor(request.user), 'rule.created', { type: 'rule', id: rule.id, name: rule.name || null })
    return reply.status(201).send({ rule: view(rule) })
  })

  app.patch<{ Params: { ruleId: string }; Body: Record<string, unknown> }>('/api/rules/:ruleId', async (request, reply) => {
    const r = await ruleFor(request.params.ruleId, request)
    if ('status' in r) return reply.status(r.status!).send({ error: r.error })
    const clean = await checkRule(r.preset.id, r.preset.sceneId, request.body ?? {}, true)
    if ('error' in clean) return reply.status(400).send(clean)
    const [rule] = await db.update(sceneRules).set({ ...clean, updatedAt: new Date() }).where(eq(sceneRules.id, r.rule.id)).returning()
    await recordSceneActivity(r.preset.sceneId, requestActor(request.user), 'rule.updated', { type: 'rule', id: rule.id, name: rule.name || null })
    return { rule: view(rule) }
  })

  app.delete<{ Params: { ruleId: string } }>('/api/rules/:ruleId', async (request, reply) => {
    const r = await ruleFor(request.params.ruleId, request)
    if ('status' in r) return reply.status(r.status!).send({ error: r.error })
    await db.delete(sceneRules).where(eq(sceneRules.id, r.rule.id))
    await recordSceneActivity(r.preset.sceneId, requestActor(request.user), 'rule.deleted', { type: 'rule', id: r.rule.id, name: r.rule.name || null })
    return reply.status(204).send()
  })
}
