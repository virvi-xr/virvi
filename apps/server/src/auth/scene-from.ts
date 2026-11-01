import type { FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, sceneElementInstances, sceneElements, scenePresets } from '../db/schema.js'

/**
 * Resolves the scene a request targets, so `authenticate` can hold a scene pass to its own scene.
 * Returning null (unknown id, malformed id, missing body field) refuses the pass.
 */
export type SceneFrom = (request: FastifyRequest) => Promise<string | null> | string | null
declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * `hyperfy: true` also lets a Hyperfy HUD pass (via 'hyperfy') in. Default refused: such a pass is tied to a
     * revocable pairing, so only the HUD's own routes opt in, never ones that grant access or mint credentials.
     * `ar: true` does the same for an AR headset pass (via 'ar'), tied to a revocable headset: only the routes the
     * headset uses to read and build opt in. `ar: 'personal'` opts in a personal headset's pass only (a shared one
     * gets 403 `personal_only`): the builder's routes, the same rule as room scans.
     */
    scenePass?: { sceneFrom: SceneFrom; hyperfy?: true; ar?: true | 'personal' }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const uuidOrNull = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null)
const param = (r: FastifyRequest, n: string) => uuidOrNull((r.params as Record<string, unknown> | undefined)?.[n])

export const isScenePass = (u: { kind?: string } | undefined) => u?.kind === 'scene'
export const fromParam = (name: string): SceneFrom => (r) => param(r, name)
export const fromBody = (name: string): SceneFrom => (r) => {
  const body = r.body
  return body && typeof body === 'object' ? uuidOrNull((body as Record<string, unknown>)[name]) : null
}
export const boundScene: SceneFrom = (r) => r.user?.sceneId ?? null
export const fromPreset: SceneFrom = async (r) => {
  const id = param(r, 'presetId')
  if (!id) return null
  const p = await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, id), columns: { sceneId: true } })
  return p?.sceneId ?? null
}
export const fromElement: SceneFrom = async (r) => {
  const id = param(r, 'elementId')
  if (!id) return null
  const e = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id), columns: { id: true }, with: { preset: { columns: { sceneId: true } } } })
  return e?.preset?.sceneId ?? null
}
export const fromInstance: SceneFrom = async (r) => {
  const id = param(r, 'instanceId')
  if (!id) return null
  const i = await db.query.sceneElementInstances.findFirst({
    where: eq(sceneElementInstances.id, id),
    columns: { id: true },
    with: { element: { columns: { id: true }, with: { preset: { columns: { sceneId: true } } } } },
  })
  return i?.element?.preset?.sceneId ?? null
}
export const fromAnalyticsLocation: SceneFrom = async (r) => {
  const id = param(r, 'id')
  if (!id) return null
  const l = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, id), columns: { virviSceneId: true } })
  return l?.virviSceneId ?? null
}
