import { and, asc, count, eq, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesignMembers, studioDesigns, users } from '../db/schema.js'
import { type Exec } from './quota.js'

/**
 * Who a design is shared with (LIV-159). The owner is studio_designs.owner_id; everyone else is an open
 * studio_design_members row (left_at null). A member who left, or was removed, has no role: the same as a stranger.
 */
export type DesignRole = 'owner' | 'collaborator' | 'viewer'

/** The user's role on the design, or null for none (no such design, a stranger, a member who left). */
export async function designRole(designId: string, userId: string, exec: Exec = db): Promise<DesignRole | null> {
  const [d] = await exec.select({ ownerId: studioDesigns.ownerId }).from(studioDesigns).where(eq(studioDesigns.id, designId))
  if (!d) return null
  if (d.ownerId === userId) return 'owner'
  const [m] = await exec.select({ role: studioDesignMembers.role }).from(studioDesignMembers)
    .where(and(eq(studioDesignMembers.designId, designId), eq(studioDesignMembers.userId, userId), isNull(studioDesignMembers.leftAt)))
  return (m?.role as DesignRole | undefined) ?? null
}

/** Everyone on the design, with their names: the owner first, then open members by when they joined. */
export async function designMembers(designId: string, exec: Exec = db): Promise<{ userId: string; displayName: string | null; role: DesignRole }[]> {
  const [owner] = await exec.select({ userId: studioDesigns.ownerId, displayName: users.displayName }).from(studioDesigns)
    .innerJoin(users, eq(users.id, studioDesigns.ownerId)).where(eq(studioDesigns.id, designId))
  if (!owner) return []
  const members = await exec.select({ userId: studioDesignMembers.userId, displayName: users.displayName, role: studioDesignMembers.role })
    .from(studioDesignMembers).innerJoin(users, eq(users.id, studioDesignMembers.userId))
    .where(and(eq(studioDesignMembers.designId, designId), isNull(studioDesignMembers.leftAt)))
    .orderBy(asc(studioDesignMembers.joinedAt), asc(studioDesignMembers.id))
  return [{ ...owner, role: 'owner' as const }, ...members.map((m) => ({ ...m, role: m.role as DesignRole }))]
}

/** The ids of everyone on the design: the owner first, then open members by when they joined. */
export async function memberIds(designId: string, exec: Exec = db): Promise<string[]> {
  return (await designMembers(designId, exec)).map((m) => m.userId)
}

/** How many open members the design has, the owner left out. */
export async function memberCount(designId: string, exec: Exec = db): Promise<number> {
  const [{ n }] = await exec.select({ n: count() }).from(studioDesignMembers)
    .where(and(eq(studioDesignMembers.designId, designId), isNull(studioDesignMembers.leftAt)))
  return n
}
