import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { userAuthMethods, users } from '../db/schema.js'
import type { ToolCtx } from './tools/types.js'

/**
 * The caller as the assistant's tools run them: their own email and wallets are theirs to see (redaction keeps them,
 * and hides everyone else's). Used by the assistant's routes and the MCP server (LIV-170).
 */
export async function callerCtx(app: FastifyInstance, request: FastifyRequest, walletRefs: string[] = []): Promise<ToolCtx> {
  const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, request.user.id))
  const wallets = await db.select({ w: userAuthMethods.identifier }).from(userAuthMethods)
    .where(and(eq(userAuthMethods.userId, request.user.id), eq(userAuthMethods.type, 'wallet')))
  return { app, request, user: request.user, self: { email: me?.email ?? request.user.email ?? null, wallets: wallets.map((r) => r.w) }, walletRefs }
}
