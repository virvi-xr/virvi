import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { getAddress, verifyMessage } from 'ethers'
import { db } from '../db/connection.js'
import { userAuthMethods, walletChallenges } from '../db/schema.js'
import { config } from '../config.js'
import { actorFromClaims } from '../auth/actor.js'
import { authenticate } from '../middleware/auth.js'
import { linkWalletGrants } from '../auth/permissions.js'
import { recordTrialEvent, cleanAction } from '../auth/trial-events.js'
import { convertTrial, isTrialGone, mergeTrial, movedHeadsetsField, refuseExpiredTrial, trialFromBearer } from '../auth/trial-convert.js'
import { linkVerifiedWallet, resolveVerifiedWalletUser } from '../auth/wallet-users.js'
import { issueWalletSession } from '../auth/sessions.js'
import { CREDENTIAL_RATE_LIMIT } from '../auth/credential-rate-limit.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const TTL_MS = 5 * 60_000

function siweOrigin(): { host: string; origin: string } {
  for (const candidate of [config.webAppUrl, config.publicUrl]) {
    try {
      const u = new URL(candidate)
      return { host: u.host, origin: u.origin }
    } catch {
      /* try the next candidate */
    }
  }
  return { host: 'localhost', origin: 'http://localhost' }
}

export default async function walletAuthRoutes(app: FastifyInstance) {
  /**
   * A trial visitor's wallet sign-in converts the trial (new wallet) or moves it into the wallet's account. Null when a
   * concurrent sign-up converted or merged the trial first: the caller carries on as a sign-in without a trial.
   */
  async function signInFromTrial(trialId: string, recovered: string, fromAction: unknown) {
    const known = await db.query.userAuthMethods.findFirst({
      where: and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, recovered)),
      with: { user: true },
    })
    const verified = !!known && (known.metadata as { verified?: unknown } | null)?.verified === true
    const user = verified
      ? await resolveVerifiedWalletUser(recovered, `${recovered.slice(0, 6)}…${recovered.slice(-4)}`, 'account')
      : await db.transaction(async (tx) => {
          const converted = await convertTrial(trialId, { displayName: `${recovered.slice(0, 6)}…${recovered.slice(-4)}` }, tx)
          await tx.insert(userAuthMethods).values({ userId: trialId, type: 'wallet', identifier: recovered, metadata: { verified: true } })
          return converted
        }).catch((e) => { if (isTrialGone(e)) return null; throw e })
    if (!user) return null
    const merged = user.id !== trialId ? await mergeTrial(trialId, user.id, fromAction) : false
    if (user.id === trialId) recordTrialEvent('signed_up', trialId, cleanAction(fromAction))
    await linkWalletGrants(user.id, recovered)
    return { ...issueWalletSession(app, user, recovered), ...movedHeadsetsField(merged) }
  }

  app.post<{ Body: { address?: string } }>('/api/auth/wallet/challenge', async (request, reply) => {
    const address = request.body?.address
    if (!address || !ADDRESS_RE.test(address)) return reply.status(400).send({ error: 'address must be a 0x wallet address' })
    const nonce = randomBytes(16).toString('hex')
    const url = siweOrigin()
    const issuedAt = new Date()
    const expiresAt = new Date(issuedAt.getTime() + TTL_MS)
    const message = [
      `${url.host} wants you to sign in with your Ethereum account:`,
      getAddress(address.toLowerCase()),
      '',
      'Sign in to Virvi to manage your scenes and analytics.',
      '',
      `URI: ${url.origin}`,
      'Version: 1',
      'Chain ID: 1',
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expiration Time: ${expiresAt.toISOString()}`,
    ].join('\n')
    await db.insert(walletChallenges).values({ nonce, address: address.toLowerCase(), message, expiresAt })
    return reply.send({ nonce, message })
  })

  app.post<{ Body: { address?: string; nonce?: string; signature?: string; fromAction?: string } }>('/api/auth/wallet/verify', { preHandler: refuseExpiredTrial(app), config: { rateLimit: CREDENTIAL_RATE_LIMIT } }, async (request, reply) => {
    const { address, nonce, signature } = request.body ?? {}
    if (!address || !ADDRESS_RE.test(address) || !nonce || !signature) return reply.status(400).send({ error: 'address, nonce and signature are required' })
    // Single use: delete first so a failed attempt also burns the nonce.
    const [challenge] = await db.delete(walletChallenges).where(eq(walletChallenges.nonce, nonce)).returning()
    if (!challenge || challenge.expiresAt < new Date() || challenge.address !== address.toLowerCase()) {
      return reply.status(401).send({ error: 'Challenge expired or invalid' })
    }
    let recovered: string
    try {
      recovered = verifyMessage(challenge.message, signature).toLowerCase()
    } catch {
      return reply.status(401).send({ error: 'Invalid signature' })
    }
    if (recovered !== challenge.address) return reply.status(401).send({ error: 'Invalid signature' })

    const trialId = await trialFromBearer(app, request)
    const fromTrial = trialId ? await signInFromTrial(trialId, recovered, request.body?.fromAction) : null
    if (fromTrial) return reply.send(fromTrial)

    const auth = request.headers.authorization
    // Only an account session may link a wallet; a scene pass is ignored as if absent (it must never link one).
    // A trial bearer that lost a concurrent conversion is ignored too: this is then a plain wallet sign-in.
    const bearerKind = auth?.startsWith('Bearer ') ? (app.jwt.decode<{ kind?: string }>(auth.slice(7)) as { kind?: string } | null)?.kind : undefined
    if (!trialId && auth?.startsWith('Bearer ') && bearerKind !== 'scene') {
      let bearer: { id: string; refresh?: boolean; guest?: boolean; verified?: boolean; kind?: 'account' | 'scene' } | null = null
      try {
        bearer = app.jwt.verify<{ id: string; refresh?: boolean; guest?: boolean; verified?: boolean; kind?: 'account' | 'scene' }>(auth.slice(7))
      } catch {
        return reply.status(401).send({ error: 'Invalid token' })
      }
      const actor = actorFromClaims(bearer)
      if (bearer!.kind !== 'account' || bearer!.refresh || !actor.userId || !actor.verified) return reply.status(401).send({ error: 'Invalid token' })
      const result = await linkVerifiedWallet(actor.userId, recovered)
      if (result === 'conflict') return reply.status(409).send({ error: 'That wallet is linked to another account' })
      await linkWalletGrants(actor.userId, recovered)
      return reply.send({ linked: true })
    }

    const user = await resolveVerifiedWalletUser(recovered, `${recovered.slice(0, 6)}…${recovered.slice(-4)}`, 'account')
    await linkWalletGrants(user.id, recovered)
    return reply.send(issueWalletSession(app, user, recovered))
  })

  /** Verified wallets linked to the signed-in user (legacy unverified records are not shown). */
  app.get('/api/auth/wallets', { preHandler: authenticate }, async (request) => {
    const methods = await db.query.userAuthMethods.findMany({
      where: and(eq(userAuthMethods.userId, request.user.id), eq(userAuthMethods.type, 'wallet')),
    })
    const wallets = methods
      .filter((m) => (m.metadata as { verified?: unknown } | null)?.verified === true)
      .map((m) => ({ address: m.identifier, linkedAt: m.createdAt.toISOString() }))
    return { wallets }
  })
}
