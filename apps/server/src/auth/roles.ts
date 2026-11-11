import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { users } from '../db/schema.js'
import { config } from '../config.js'

type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Admin only for the very first account in single/scalable mode; everyone else is a creator. Trial guests are not
 * accounts: one started before the first sign-up does not take the admin role from it.
 */
export async function initialRoleForNewUser(exec: Exec = db): Promise<'admin' | 'creator'> {
  if (!config.autoPromoteFirstUser) return 'creator'
  const [anyUser] = await exec.select({ id: users.id }).from(users).where(eq(users.isTrial, false)).limit(1)
  return anyUser ? 'creator' : 'admin'
}
