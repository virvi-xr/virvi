import type { FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { users } from '../db/schema.js'

/**
 * Who is a Virvi admin: the users row's role, read when asked, never a token's claim. One check for every admin
 * route (admin.ts, admin-ads.ts, admin-studio.ts, advertiser-leads.ts, branding.ts) and for Virvi support on
 * Design Studio designs, so a demotion takes effect at once and a promotion does too.
 */

type Exec = Pick<typeof db, 'select'>

export async function isVirviAdmin(userId: string | null | undefined, exec: Exec = db): Promise<boolean> {
  if (!userId) return false
  const [u] = await exec.select({ role: users.role }).from(users).where(eq(users.id, userId))
  return u?.role === 'admin'
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
