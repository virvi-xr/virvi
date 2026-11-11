import type { FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { users } from '../db/schema.js'
import { actorFromClaims, type Actor } from './actor.js'
import type { SessionClaims } from './tokens.js'

/**
 * Who is a Virvi admin: the users row's role, read when asked, never a token's claim. One check for every admin
 * route (admin.ts, admin-ads.ts, admin-studio.ts, advertiser-leads.ts, branding.ts) and for Virvi support on
 * Design Studio designs, so a demotion takes effect at once and a promotion does too.
 */

type Exec = Pick<typeof db, 'select'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A user's role as the database has it, or null for no such user. */
export async function dbRole(userId: string | null | undefined, exec: Exec = db): Promise<string | null> {
  if (!userId || !UUID.test(userId)) return null
  const [u] = await exec.select({ role: users.role }).from(users).where(eq(users.id, userId))
  return u?.role ?? null
}

export async function isVirviAdmin(userId: string | null | undefined, exec: Exec = db): Promise<boolean> {
  return (await dbRole(userId, exec)) === 'admin'
}

/**
 * The role a session acts with: a token's claim, except that a claim of admin is checked against the database (a
 * demotion counts at once; a gone user is a viewer). Only an admin claim costs a read: a lesser claim can't grant
 * power, and every admin guard reads the database itself (isAdminRequest), so a promotion counts there at once too.
 */
export async function sessionRole(userId: string | null | undefined, claimed: string | null | undefined): Promise<string> {
  if (claimed !== 'admin') return claimed ?? 'viewer'
  return (await dbRole(userId)) ?? 'viewer'
}

/**
 * A request with admin power: an account session (a dashboard login or the admin's own API key), not a scene pass or
 * a trial, whose user is an admin in the database.
 */
export async function isAdminRequest(request: FastifyRequest): Promise<boolean> {
  const u = request.user
  return !!u && u.kind === 'account' && !u.via && !u.trial && await isVirviAdmin(u.id)
}

/** The preHandler for admin routes, after `authenticate`. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!(await isAdminRequest(request))) {
    return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' })
  }
}

/** actorFromClaims for a room's join, with an admin claim checked against the database (sessionRole). */
export async function checkedActor(c: Partial<SessionClaims> | null | undefined): Promise<Actor> {
  const actor = actorFromClaims(c)
  return actor.role === 'admin' ? { ...actor, role: await sessionRole(actor.userId, actor.role) } : actor
}
