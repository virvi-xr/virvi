import { and, eq, isNull, or } from 'drizzle-orm'
import { checkEditArea, type EditArea } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { sceneRoles } from '../db/schema.js'
import type { Actor } from './actor.js'

export type SceneRole = 'cohost' | 'editor' | 'viewer'

/**
 * The actor's active scene role rows, matched by user id or by their verified wallet (wallet only with `walletOnly`,
 * for signed-fetch callers that have no user). Host is not a role (see scenes.ownerId).
 */
async function roleRows(sceneId: string, actor: Actor, opts: { walletOnly?: boolean }) {
  if (!actor.verified) return []
  if (opts.walletOnly) {
    if (!actor.wallet) return []
  } else if (!actor.userId) return []
  const subject = opts.walletOnly
    ? eq(sceneRoles.walletAddress, actor.wallet as string)
    : actor.wallet
    ? or(eq(sceneRoles.userId, actor.userId as string), eq(sceneRoles.walletAddress, actor.wallet))
    : eq(sceneRoles.userId, actor.userId as string)
  return db.select({ role: sceneRoles.role, area: sceneRoles.area }).from(sceneRoles).where(and(eq(sceneRoles.sceneId, sceneId), isNull(sceneRoles.revokedAt), subject))
}

/** A stored area, checked again (a malformed one limits to nothing rather than to everything). */
const areaOf = (raw: unknown): EditArea | null => {
  const c = checkEditArea(raw)
  return c.ok ? c.value : null
}

/**
 * The actor's role and, for an area-limited editor (LIV-32, a tenant), the areas they may edit. An editor role with an
 * area is not 'editor': callers that don't handle areas (setup, the HUD's host check) see a viewer, so nothing that
 * predates areas lets a tenant edit everywhere. An unlimited editor role wins over an area.
 */
export async function sceneRoleAccess(sceneId: string, actor: Actor, opts: { walletOnly?: boolean } = {}): Promise<{ role: SceneRole | null; tenant: boolean; areas: EditArea[] }> {
  const rows = await roleRows(sceneId, actor, opts)
  if (rows.some((r) => r.role === 'cohost')) return { role: 'cohost', tenant: false, areas: [] }
  if (rows.some((r) => r.role === 'editor' && r.area == null)) return { role: 'editor', tenant: false, areas: [] }
  const areas = rows.filter((r) => r.role === 'editor' && r.area != null).map((r) => areaOf(r.area)).filter((a): a is EditArea => !!a)
  const tenant = rows.some((r) => r.role === 'editor' && r.area != null)
  return { role: rows.length ? 'viewer' : null, tenant, areas }
}

/** The actor's active scene role; an area-limited editor counts as a viewer here (see sceneRoleAccess). */
export async function sceneRoleFor(sceneId: string, actor: Actor, opts: { walletOnly?: boolean } = {}): Promise<SceneRole | null> {
  return (await sceneRoleAccess(sceneId, actor, opts)).role
}
