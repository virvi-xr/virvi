/**
 * LIV-83: every route that names a scene (or a preset, element, instance, preset schedule, showing or raffle of one) answers
 * 404 `Scene not found` while that scene is deleted, the same as for a scene that doesn't exist. Routes opt out with
 * `config: { deletedScene: true }`: only the delete routes themselves (restore, purge, retry), which run their own check.
 *
 * Added to each route as a route-level preHandler (onRoute), so it runs after `authenticate`: an unauthenticated caller
 * gets 401 as before, never a hint that the id is a deleted scene. Routes that reach a scene some other way (a world
 * key, an AR space, a destination id) are covered by getSceneAccess refusing deleted scenes and by their own lookups.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions, preHandlerHookHandler } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenes } from '../db/schema.js'
import { fromElement, fromInstance, fromParam, fromPreset, fromPresetSchedule, fromRaffle, fromShowing, type SceneFrom } from './scene-from.js'

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `true`: the route works on deleted scenes (restore, purge, retry) and does its own check. */
    deletedScene?: true
  }
}

const RESOLVERS: Array<[param: string, from: SceneFrom]> = [
  ['sceneId', fromParam('sceneId')],
  ['presetId', fromPreset],
  ['elementId', fromElement],
  ['instanceId', fromInstance],
  ['scheduleId', fromPresetSchedule],
  ['showingId', fromShowing],
  ['raffleId', fromRaffle],
]

/** The resolvers for the scene-naming params in a route's url. */
function resolversFor(url: string): SceneFrom[] {
  return RESOLVERS.filter(([p]) => new RegExp(`:${p}(?:/|$)`).test(url)).map(([, from]) => from)
}

async function deleted(sceneId: string): Promise<boolean> {
  const [row] = await db.select({ deletedAt: scenes.deletedAt }).from(scenes).where(eq(scenes.id, sceneId))
  return !!row?.deletedAt
}

function guardFor(from: SceneFrom[]): preHandlerHookHandler {
  return async function deletedSceneGuard(request: FastifyRequest, reply: FastifyReply) {
    for (const f of from) {
      const sceneId = await f(request)
      if (sceneId && (await deleted(sceneId))) return reply.status(404).send({ error: 'Scene not found' })
    }
  }
}

export function registerDeletedSceneGuard(app: FastifyInstance): void {
  app.addHook('onRoute', (route: RouteOptions) => {
    if (route.config?.deletedScene) return
    const from = resolversFor(route.url)
    if (!from.length) return
    const guard = guardFor(from)
    const existing = route.preHandler
    route.preHandler = existing ? [...(Array.isArray(existing) ? existing : [existing]), guard] : [guard]
  })
}
