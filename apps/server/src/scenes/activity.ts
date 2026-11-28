import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneActivity, users } from '../db/schema.js'
import type { AuthUser } from '../middleware/auth.js'
import type { Actor } from '../auth/actor.js'

/**
 * A scene's activity log (LIV-32): who changed what, and when. Recording never gets in the way of the change: a failed
 * write is logged and dropped.
 */

export const SCENE_ACTIVITY_ACTIONS = [
  'scene.updated', 'scene.thumbnail_changed', 'scene.deleted', 'scene.restored',
  'element.created', 'element.updated', 'element.deleted', 'element.live_on', 'element.live_off',
  'instance.added', 'instance.updated', 'instance.removed', 'instances.cleared',
  'preset.created', 'preset.renamed', 'preset.deleted', 'preset.activated',
  'collaborator.added', 'collaborator.changed', 'collaborator.removed',
  'role.granted', 'role.revoked', 'host.transferred',
  'deploy.started',
  'rule.created', 'rule.updated', 'rule.deleted',
] as const
export type SceneActivityAction = (typeof SCENE_ACTIVITY_ACTIONS)[number]

export type ActivityVia = 'dashboard' | 'in_world' | 'api'

export interface ActivityActor {
  userId: string | null
  wallet: string | null
  via: ActivityVia
}

export interface ActivitySubject {
  type?: string | null
  id?: string | null
  name?: string | null
}

/** Repeat edits of one thing by one person within this window fold into one row. */
export const FOLD_MS = 60_000
/** Only edits fold (a model dragged about, a screen retuned); an add, a delete or a role change is always its own row. */
const FOLDS = new Set<SceneActivityAction>(['element.updated', 'instance.updated', 'scene.updated', 'preset.renamed'])

/** The actor of a REST request: a scene pass (a HUD in a world) is in-world, an API key is the API. */
export function requestActor(user: AuthUser): ActivityActor {
  const via: ActivityVia = user.kind === 'scene' || user.via === 'hyperfy' || user.via === 'ar' ? 'in_world' : user.viaApiKey ? 'api' : 'dashboard'
  return { userId: user.guest ? null : user.id ?? null, wallet: user.wallet ? user.wallet.toLowerCase() : null, via }
}

/** The actor of a scene-room message (always in-world). */
export function roomActor(actor: Actor | undefined | null): ActivityActor {
  return { userId: actor?.userId ?? null, wallet: actor?.wallet ?? null, via: 'in_world' }
}

export async function recordSceneActivity(
  sceneId: string,
  actor: ActivityActor,
  action: SceneActivityAction,
  subject: ActivitySubject = {},
  detail?: Record<string, unknown>,
  now = new Date(),
): Promise<void> {
  try {
    if (!actor.userId && !actor.wallet) return // nobody to name (a guest): nothing worth a row
    if (FOLDS.has(action) && (await fold(sceneId, actor, action, subject, detail, now))) return
    await db.insert(sceneActivity).values({
      sceneId,
      actorUserId: actor.userId,
      actorWallet: actor.wallet,
      via: actor.via,
      action,
      subjectType: subject.type ?? null,
      subjectId: subject.id ?? null,
      subjectName: subject.name ?? null,
      detail: detail ?? null,
      createdAt: now,
      lastAt: now,
    })
  } catch (err) {
    console.error('[scene-activity] not recorded:', action, sceneId, err instanceof Error ? err.message : err)
  }
}

/** Folds into this person's last row for the same edit of the same thing, if it's recent. True when it did. */
async function fold(sceneId: string, actor: ActivityActor, action: SceneActivityAction, subject: ActivitySubject, detail: Record<string, unknown> | undefined, now: Date): Promise<boolean> {
    const sameActor = actor.userId ? eq(sceneActivity.actorUserId, actor.userId) : and(isNull(sceneActivity.actorUserId), eq(sceneActivity.actorWallet, actor.wallet!))
    const sameSubject = subject.id ? eq(sceneActivity.subjectId, subject.id) : isNull(sceneActivity.subjectId)
    const [folded] = await db
      .update(sceneActivity)
      .set({ count: sql`${sceneActivity.count} + 1`, lastAt: now, ...(subject.name ? { subjectName: subject.name } : {}), ...(detail ? { detail } : {}) })
      .where(and(
        eq(sceneActivity.sceneId, sceneId),
        eq(sceneActivity.action, action),
        sameActor,
        sameSubject,
        eq(sceneActivity.via, actor.via),
        gt(sceneActivity.lastAt, new Date(now.getTime() - FOLD_MS)),
      ))
      .returning({ id: sceneActivity.id })
    return !!folded
}

/** Fire-and-forget form for hot paths (the scene room): the caller never waits on the log. */
export function noteSceneActivity(...args: Parameters<typeof recordSceneActivity>): void {
  void recordSceneActivity(...args)
}

export interface SceneActivityEntry {
  id: string
  action: string
  via: string
  subject: { type: string | null; id: string | null; name: string | null }
  detail: Record<string, unknown> | null
  count: number
  at: string
  firstAt: string
  actor: { name: string | null; wallet: string | null }
}

export const ACTIVITY_PAGE = 50

/** Newest first. `before` pages back: pass the last entry's `at` and `id`. */
export async function listSceneActivity(sceneId: string, opts: { limit?: number; before?: { at: Date; id: string } } = {}): Promise<{ entries: SceneActivityEntry[]; more: boolean }> {
  const limit = Math.min(Math.max(1, opts.limit ?? ACTIVITY_PAGE), 200)
  const b = opts.before
  const rows = await db
    .select()
    .from(sceneActivity)
    .where(and(
      eq(sceneActivity.sceneId, sceneId),
      b ? or(lt(sceneActivity.lastAt, b.at), and(eq(sceneActivity.lastAt, b.at), lt(sceneActivity.id, b.id))) : undefined,
    ))
    .orderBy(desc(sceneActivity.lastAt), desc(sceneActivity.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const ids = [...new Set(page.map((r) => r.actorUserId).filter((x): x is string => !!x))]
  const names = new Map(
    ids.length ? (await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : [],
  )
  return {
    more: rows.length > limit,
    entries: page.map((r) => ({
      id: r.id,
      action: r.action,
      via: r.via,
      subject: { type: r.subjectType, id: r.subjectId, name: r.subjectName },
      detail: r.detail ?? null,
      count: r.count,
      at: r.lastAt.toISOString(),
      firstAt: r.createdAt.toISOString(),
      actor: { name: (r.actorUserId && names.get(r.actorUserId)) || null, wallet: r.actorWallet },
    })),
  }
}
