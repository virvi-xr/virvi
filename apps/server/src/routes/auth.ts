import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { users, userAuthMethods, passwordResetTokens, scenes } from '../db/schema.js'
import { deleteUserWithModels, releaseModelFiles } from '../library/user-models.js'
import { authenticate } from '../middleware/auth.js'
import { config } from '../config.js'
import { sendPasswordResetEmail } from '../services/email.js'
import { initialRoleForNewUser } from '../auth/roles.js'
import { linkWalletGrants } from '../auth/permissions.js'
import { resolveVerifiedWalletUser } from '../auth/wallet-users.js'
import { verifyDclSceneRequest, hasDclAuthHeaders } from '../middleware/dcl-auth.js'
import { bindSceneRequest, type SceneBinding } from '../auth/scene-binding.js'
import type { SessionClaims } from '../auth/tokens.js'
import { issueScenePass, issueStudioPass, sceneClaims } from '../auth/scene-pass.js'
import { isOfficialRealm, isWorldRealm } from '../auth/official-realms.js'
import { trialClaims } from '../auth/trial.js'
import { issueAccountSession } from '../auth/sessions.js'
import { recordTrialEvent, cleanAction } from '../auth/trial-events.js'
import { convertTrial, finishOAuth, isTrialGone, mergeTrial, movedHeadsetsField, refuseExpiredTrial, trialFromBearer } from '../auth/trial-convert.js'
import { hostedWorldsBlockingDelete } from '../hyperfy/hosting.js'
import { deleteImportFiles, importsGoingWith } from '../services/import/imports.js'
import { CREDENTIAL_RATE_LIMIT } from '../auth/credential-rate-limit.js'

interface RegisterBody {
  email: string
  password: string
  displayName: string
  fromAction?: string
}

interface LoginBody {
  email: string
  password: string
  fromAction?: string
}

/** An OAuth `state` from the web app: an opaque random per-tab value, echoed back to /auth/callback. */
const OAUTH_STATE = /^[A-Za-z0-9_-]{16,64}$/

export default async function authRoutes(app: FastifyInstance) {
  // ── GET /api/auth/providers — which OAuth providers are configured ──────

  app.get('/api/auth/providers', async () => ({
    google: !!(config.googleClientId && config.googleClientSecret),
    discord: !!(config.discordClientId && config.discordClientSecret),
  }))

  // ── POST /api/auth/register ──────────────────────────────────────────────

  app.post<{ Body: RegisterBody }>('/api/auth/register', { preHandler: refuseExpiredTrial(app), config: { rateLimit: CREDENTIAL_RATE_LIMIT } }, async (request, reply) => {
    const { email, password, displayName } = request.body

    if (!email || !password || !displayName) {
      return reply.status(400).send({ error: 'email, password, and displayName are required' })
    }

    // Check if email is already registered
    const existing = await db.query.userAuthMethods.findFirst({
      where: and(
        eq(userAuthMethods.type, 'email'),
        eq(userAuthMethods.identifier, email.toLowerCase()),
      ),
    })

    if (existing) {
      return reply.status(409).send({ error: 'Email already registered' })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    // A trial visitor's sign-up turns the same row into the account (it keeps everything); otherwise a new user
    const trialId = await trialFromBearer(app, request)
    let user: typeof users.$inferSelect | undefined
    if (trialId) {
      // A concurrent sign-up may have converted the trial first: then this one is a sign-up without a trial
      user = await db.transaction(async (tx) => {
        const converted = await convertTrial(trialId, { email: email.toLowerCase(), displayName }, tx)
        await tx.insert(userAuthMethods).values({ userId: trialId, type: 'email', identifier: email.toLowerCase(), credentialHash: passwordHash })
        return converted
      }).catch((e) => { if (isTrialGone(e)) return undefined; throw e })
      if (user) recordTrialEvent('signed_up', trialId, cleanAction(request.body.fromAction))
    }
    if (!user) {
      if (trialId) {
        const taken = await db.query.userAuthMethods.findFirst({
          where: and(eq(userAuthMethods.type, 'email'), eq(userAuthMethods.identifier, email.toLowerCase())),
        })
        if (taken) return reply.status(409).send({ error: 'Email already registered' })
      }
      const role = await initialRoleForNewUser()
      ;[user] = await db.insert(users).values({ displayName, email: email.toLowerCase(), role }).returning()
      await db.insert(userAuthMethods).values({
        userId: user.id,
        type: 'email',
        identifier: email.toLowerCase(),
        credentialHash: passwordHash,
      })
    }

    return reply.status(201).send(issueAccountSession(app, user))
  })

  // ── POST /api/auth/login ─────────────────────────────────────────────────

  app.post<{ Body: LoginBody }>('/api/auth/login', { preHandler: refuseExpiredTrial(app), config: { rateLimit: CREDENTIAL_RATE_LIMIT } }, async (request, reply) => {
    const { email, password } = request.body

    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password are required' })
    }

    const authMethod = await db.query.userAuthMethods.findFirst({
      where: and(
        eq(userAuthMethods.type, 'email'),
        eq(userAuthMethods.identifier, email.toLowerCase()),
      ),
    })

    if (!authMethod || !authMethod.credentialHash) {
      return reply.status(401).send({ error: 'Invalid email or password' })
    }

    const valid = await bcrypt.compare(password, authMethod.credentialHash)
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid email or password' })
    }

    let user: any
    try {
      const [row] = await db.select().from(users).where(eq(users.id, authMethod.userId))
      user = row
    } catch {
      // Fallback if active_org_id column doesn't exist yet (pre-migration)
      const [row] = await db.select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        role: users.role,
      }).from(users).where(eq(users.id, authMethod.userId))
      user = { ...row, activeOrgId: null }
    }

    // Signing in from a trial moves the trial's work into this account
    const trialId = await trialFromBearer(app, request)
    const merged = trialId && trialId !== user.id ? await mergeTrial(trialId, user.id, request.body.fromAction) : false

    return reply.send({ ...issueAccountSession(app, user), ...movedHeadsetsField(merged) })
  })

  // ── POST /api/auth/refresh ───────────────────────────────────────────────

  app.post('/api/auth/refresh', async (request, reply) => {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Refresh token required' })
    }

    const token = authHeader.slice(7)

    try {
      const decoded = app.jwt.verify<{ id: string; email: string | null; role: string; wallet?: string | null; verified?: boolean; refresh?: boolean; kind?: 'account' | 'scene' | 'trial'; sceneId?: string | null; locationId?: string | null }>(token)

      if (!decoded.refresh) {
        return reply.status(401).send({ error: 'Not a refresh token' })
      }
      if (decoded.kind !== 'account' && decoded.kind !== 'scene' && decoded.kind !== 'trial') {
        return reply.status(401).send({ error: 'Invalid or expired refresh token' })
      }
      // Verified scene passes are never refreshed (none are issued); only local-preview passes are.
      if (decoded.kind === 'scene' && decoded.verified !== false) {
        return reply.status(401).send({ error: 'Invalid or expired refresh token' })
      }

      // Verify user still exists
      const user = await db.query.users.findFirst({
        where: eq(users.id, decoded.id),
      })

      if (!user) {
        return reply.status(401).send({ error: 'User not found' })
      }

      if (decoded.kind === 'trial') {
        // A converted (or swept) trial's tokens end here; the web app swaps to its account tokens.
        if (!user.isTrial) return reply.status(401).send({ error: 'trial_ended' })
        return reply.send({ accessToken: app.jwt.sign(trialClaims(user), { expiresIn: config.jwtAccessExpiry }) })
      }

      const claims =
        decoded.kind === 'scene'
          ? {
              ...sceneClaims({ id: user.id, role: user.role }, decoded.wallet ?? '', {
                sceneId: decoded.sceneId ?? null,
                locationId: decoded.locationId ?? null,
              }),
              // Unverified local-preview passes stay unverified and walletless.
              ...(decoded.verified === false ? { verified: false, wallet: decoded.wallet ?? null } : {}),
            }
          : {
              id: user.id,
              email: user.email,
              role: user.role,
              orgId: user.activeOrgId || null,
              wallet: decoded.wallet ?? null,
              verified: true,
              kind: 'account' as const,
            }
      const accessToken = app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry })

      return reply.send({ accessToken })
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' })
    }
  })

  // ── POST /api/auth/platform — Platform-specific auth ───────────────────
  // Verifies Decentraland signed fetch headers. Unverified requests get a guest token unless ALLOW_UNVERIFIED_PLATFORM_AUTH=true (local preview).

  app.post<{ Body: { sceneId?: string; user?: any; world?: string; [key: string]: any } }>(
    '/api/auth/platform',
    async (request, reply) => {
      const { sceneId, user: platformUser, world } = request.body ?? {}

      let verifiedWallet: string | null = null
      let binding: SceneBinding | null = null
      let studio = false
      let displayName = platformUser?.displayName || platformUser?.name || 'Guest'

      // ── Try to verify DCL signed fetch headers ────────────────────────────
      if (hasDclAuthHeaders(request.headers as Record<string, string | string[] | undefined>)) {
        try {
          const raw = ((request as any).rawBody as string | undefined) ?? null
          const signed = await verifyDclSceneRequest(
            request.method,
            request.url.split('?')[0],
            request.headers as Record<string, string | string[] | undefined>,
            raw,
            // The web explorer signs the request but not its body; only the display name comes from it
            { allowUnsignedBody: true },
          )
          if (!signed.scene.isGuest) {
            verifiedWallet = signed.wallet.toLowerCase()
            if (!signed.bodySigned) displayName = `${verifiedWallet.slice(0, 6)}…${verifiedWallet.slice(-4)}`
            request.log.info({ wallet: verifiedWallet, bodySigned: signed.bodySigned }, 'DCL signed fetch verified')
            const localPreview =
              config.mode !== 'cloud' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(signed.scene.realm.hostname)
            // The studio scene: its Genesis City parcel, on an official realm (a World or a stranger's realm can claim any parcel).
            studio =
              !!config.studioSceneParcel &&
              signed.scene.parcel === config.studioSceneParcel &&
              (localPreview || (!isWorldRealm(signed.scene) && (await isOfficialRealm(signed.scene))))
            if (studio) {
              request.log.info({ ctx: { parcel: signed.scene.parcel, realm: signed.scene.realm } }, 'studio scene sign-in')
            } else {
              try {
                binding = await bindSceneRequest(signed.scene, verifiedWallet, { preview: localPreview })
                request.log.info({ ctx: { sceneId: signed.scene.sceneId, parcel: signed.scene.parcel, realm: signed.scene.realm }, binding }, 'scene binding')
              } catch (err) {
                // Binding trouble degrades to a visitor pass, never a 500 or an account token.
                request.log.warn({ err: (err as Error).message }, 'scene binding failed; issuing visitor pass')
                binding = null
              }
            }
          }
        } catch (err) {
          request.log.warn({ err: (err as Error).message }, 'DCL scene signed fetch refused')
          // Don't reject — fall through to the guest / preview path
        }
      }

      // ── No verified wallet: guest (or preview identity in local dev) ──────
      if (!verifiedWallet && !(config.allowUnverifiedPlatformAuth && config.mode !== 'cloud')) {
        const guestId = `guest:${crypto.randomUUID()}`
        const accessToken = app.jwt.sign(
          { id: guestId, email: null, role: 'viewer', orgId: null, wallet: null, verified: false, guest: true },
          { expiresIn: config.jwtAccessExpiry },
        )
        return reply.send({
          user: { id: guestId, displayName, email: null, role: 'viewer' },
          accessToken,
          refreshToken: null,
          verified: false,
          guest: true,
        })
      }

      const identifier =
        verifiedWallet ??
        `preview:${platformUser?.id || platformUser?.walletAddress || crypto.randomUUID()}`

      let dbUser
      if (verifiedWallet) {
        dbUser = await resolveVerifiedWalletUser(verifiedWallet, displayName, 'visitor')
      } else {
        const authMethod = await db.query.userAuthMethods.findFirst({
          where: and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, identifier)),
          with: { user: true },
        })
        if (authMethod) {
          dbUser = authMethod.user
        } else {
          const [newUser] = await db
            .insert(users)
            .values({ displayName, email: null, role: await initialRoleForNewUser() })
            .returning()
          await db.insert(userAuthMethods).values({
            userId: newUser.id,
            type: 'wallet',
            identifier,
            metadata: { world, sceneId, verified: false },
          })
          dbUser = newUser
        }
      }

      if (verifiedWallet) await linkWalletGrants(dbUser.id, verifiedWallet)

      if (verifiedWallet && studio) {
        return reply.send({ ...issueStudioPass(app, dbUser, verifiedWallet), verified: true, studio: true })
      }

      if (verifiedWallet) {
        return reply.send({
          ...issueScenePass(app, dbUser, verifiedWallet, binding ?? { sceneId: null, locationId: null }),
          verified: true,
        })
      }

      // Local-preview identity (self-declared by design): bind to an existing scene named in the body.
      let previewSceneId: string | null = null
      if (typeof sceneId === 'string' && /^[0-9a-f-]{36}$/i.test(sceneId)) {
        const row = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
        previewSceneId = row ? row.id : null
      }
      const claims = {
        ...sceneClaims(dbUser, '', { sceneId: previewSceneId, locationId: null }),
        wallet: null,
        verified: false,
      } as unknown as SessionClaims
      const accessToken = app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry })
      const refreshToken = app.jwt.sign({ ...claims, refresh: true }, { expiresIn: config.jwtRefreshExpiry })

      return reply.send({
        user: { id: dbUser.id, displayName: dbUser.displayName, email: dbUser.email, role: dbUser.role },
        accessToken,
        refreshToken,
        verified: false,
      })
    },
  )

  // ── GET /api/auth/google — Redirect to Google OAuth consent screen ───────

  app.get<{ Querystring: { state?: string } }>('/api/auth/google', async (request, reply) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      return reply.status(501).send({ error: 'Google OAuth is not configured' })
    }

    const redirectUri = `${config.oauthCallbackUrl}/api/auth/google/callback`

    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'email profile',
      access_type: 'offline',
      prompt: 'consent',
    })

    // The web app's random per-tab state rides through and comes back to /auth/callback (see trial hand-over)
    if (OAUTH_STATE.test(request.query.state ?? '')) params.set('state', request.query.state!)

    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
  })

  // ── GET /api/auth/google/callback — Handle the OAuth callback ────────────

  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
    '/api/auth/google/callback',
    async (request, reply) => {
      if (!config.googleClientId || !config.googleClientSecret) {
        return reply.status(501).send({ error: 'Google OAuth is not configured' })
      }

      const { code, error: oauthError, state } = request.query

      if (oauthError || !code) {
        return reply.redirect(`${config.publicUrl}/auth/callback?error=${oauthError || 'missing_code'}`)
      }

      const redirectUri = `${config.oauthCallbackUrl}/api/auth/google/callback`
      const oauthClient = new OAuth2Client(config.googleClientId, config.googleClientSecret, redirectUri)

      try {
        // Exchange code for tokens
        const { tokens } = await oauthClient.getToken(code)
        oauthClient.setCredentials(tokens)

        // Verify and decode the id_token
        const ticket = await oauthClient.verifyIdToken({
          idToken: tokens.id_token!,
          audience: config.googleClientId,
        })
        const payload = ticket.getPayload()

        if (!payload || !payload.sub) {
          return reply.redirect(`${config.publicUrl}/auth/callback?error=invalid_token`)
        }

        const googleUserId = payload.sub
        const email = payload.email || null
        const displayName = payload.name || payload.email || 'Google User'
        const identifier = `google:${googleUserId}`

        const session = await finishOAuth(
          app,
          {
            type: 'oauth',
            identifier,
            email,
            displayName,
            metadata: { provider: 'google', googleUserId, email, name: payload.name, picture: payload.picture },
          },
        )

        // Redirect to frontend with tokens
        const params = new URLSearchParams({
          token: session.accessToken,
          refresh: session.refreshToken,
        })
        if (OAUTH_STATE.test(state ?? '')) params.set('state', state!)

        return reply.redirect(`${config.publicUrl}/auth/callback?${params.toString()}`)
      } catch (err) {
        request.log.error(err, 'Google OAuth callback error')
        return reply.redirect(`${config.publicUrl}/auth/callback?error=oauth_failed`)
      }
    },
  )

  // ── GET /api/auth/discord — Redirect to Discord OAuth consent screen ──────

  app.get<{ Querystring: { state?: string } }>('/api/auth/discord', async (request, reply) => {
    if (!config.discordClientId || !config.discordClientSecret) {
      return reply.status(501).send({ error: 'Discord OAuth is not configured' })
    }

    const redirectUri = `${config.oauthCallbackUrl}/api/auth/discord/callback`

    const params = new URLSearchParams({
      client_id: config.discordClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify email',
    })

    if (OAUTH_STATE.test(request.query.state ?? '')) params.set('state', request.query.state!)

    return reply.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`)
  })

  // ── GET /api/auth/discord/callback — Handle the OAuth callback ────────────

  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
    '/api/auth/discord/callback',
    async (request, reply) => {
      if (!config.discordClientId || !config.discordClientSecret) {
        return reply.status(501).send({ error: 'Discord OAuth is not configured' })
      }

      const { code, error: oauthError, state } = request.query

      if (oauthError || !code) {
        return reply.redirect(`${config.publicUrl}/auth/callback?error=${oauthError || 'missing_code'}`)
      }

      const redirectUri = `${config.oauthCallbackUrl}/api/auth/discord/callback`

      try {
        // Exchange code for access token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.discordClientId,
            client_secret: config.discordClientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }),
        })

        if (!tokenRes.ok) {
          request.log.error({ status: tokenRes.status }, 'Discord token exchange failed')
          return reply.redirect(`${config.publicUrl}/auth/callback?error=token_exchange_failed`)
        }

        const tokenData = (await tokenRes.json()) as { access_token: string; token_type: string }

        // Get user profile from Discord
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        })

        if (!userRes.ok) {
          request.log.error({ status: userRes.status }, 'Discord user fetch failed')
          return reply.redirect(`${config.publicUrl}/auth/callback?error=user_fetch_failed`)
        }

        const discordUser = (await userRes.json()) as {
          id: string
          username: string
          email: string | null
          avatar: string | null
        }

        const discordUserId = discordUser.id
        const email = discordUser.email || null
        const displayName = discordUser.username || 'Discord User'
        const identifier = `discord:${discordUserId}`

        const session = await finishOAuth(
          app,
          {
            type: 'oauth',
            identifier,
            email,
            displayName,
            metadata: { provider: 'discord', discordUserId, email, username: discordUser.username, avatar: discordUser.avatar },
          },
        )

        // Redirect to frontend with tokens
        const params = new URLSearchParams({
          token: session.accessToken,
          refresh: session.refreshToken,
        })
        if (OAUTH_STATE.test(state ?? '')) params.set('state', state!)

        return reply.redirect(`${config.publicUrl}/auth/callback?${params.toString()}`)
      } catch (err) {
        request.log.error(err, 'Discord OAuth callback error')
        return reply.redirect(`${config.publicUrl}/auth/callback?error=oauth_failed`)
      }
    },
  )

  // ── PUT /api/auth/profile — Update display name ──────────────────────────

  app.put<{ Body: { displayName: string } }>(
    '/api/auth/profile',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { displayName } = request.body

      if (!displayName || !displayName.trim()) {
        return reply.status(400).send({ error: 'displayName is required' })
      }

      const [updated] = await db
        .update(users)
        .set({ displayName: displayName.trim(), updatedAt: new Date() })
        .where(eq(users.id, request.user.id))
        .returning()

      return reply.send({
        user: { id: updated.id, displayName: updated.displayName, email: updated.email, role: updated.role },
      })
    },
  )

  // ── PUT /api/auth/password — Change password ─────────────────────────────

  app.put<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/auth/password',
    { preHandler: [authenticate], config: { rateLimit: CREDENTIAL_RATE_LIMIT } },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body

      if (!currentPassword || !newPassword) {
        return reply.status(400).send({ error: 'currentPassword and newPassword are required' })
      }

      if (newPassword.length < 8) {
        return reply.status(400).send({ error: 'New password must be at least 8 characters' })
      }

      // Find email auth method for this user
      const authMethod = await db.query.userAuthMethods.findFirst({
        where: and(
          eq(userAuthMethods.userId, request.user.id),
          eq(userAuthMethods.type, 'email'),
        ),
      })

      if (!authMethod || !authMethod.credentialHash) {
        return reply.status(400).send({ error: 'No password-based auth method found for this account' })
      }

      const valid = await bcrypt.compare(currentPassword, authMethod.credentialHash)
      if (!valid) {
        return reply.status(401).send({ error: 'Current password is incorrect' })
      }

      const newHash = await bcrypt.hash(newPassword, 12)

      await db
        .update(userAuthMethods)
        .set({ credentialHash: newHash, updatedAt: new Date() })
        .where(eq(userAuthMethods.id, authMethod.id))

      return reply.send({ success: true })
    },
  )

  // ── POST /api/auth/forgot-password — Request password reset ──────────────

  app.post<{ Body: { email: string } }>(
    '/api/auth/forgot-password',
    { config: { rateLimit: CREDENTIAL_RATE_LIMIT } },
    async (request, reply) => {
      const { email } = request.body

      // Always return 200 to prevent email enumeration
      if (!email) {
        return reply.send({ message: 'If an account with that email exists, a reset link has been sent.' })
      }

      const authMethod = await db.query.userAuthMethods.findFirst({
        where: and(
          eq(userAuthMethods.type, 'email'),
          eq(userAuthMethods.identifier, email.toLowerCase()),
        ),
      })

      if (!authMethod) {
        return reply.send({ message: 'If an account with that email exists, a reset link has been sent.' })
      }

      const token = crypto.randomBytes(32).toString('hex')
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

      await db.insert(passwordResetTokens).values({
        userId: authMethod.userId,
        token,
        expiresAt,
      })

      await sendPasswordResetEmail(email.toLowerCase(), token)

      return reply.send({
        message: 'If an account with that email exists, a reset link has been sent.',
      })
    },
  )

  // ── POST /api/auth/reset-password — Reset password with token ────────────

  app.post<{ Body: { token: string; newPassword: string } }>(
    '/api/auth/reset-password',
    { config: { rateLimit: CREDENTIAL_RATE_LIMIT } },
    async (request, reply) => {
      const { token, newPassword } = request.body

      if (!token || !newPassword) {
        return reply.status(400).send({ error: 'token and newPassword are required' })
      }

      if (newPassword.length < 8) {
        return reply.status(400).send({ error: 'New password must be at least 8 characters' })
      }

      const resetToken = await db.query.passwordResetTokens.findFirst({
        where: eq(passwordResetTokens.token, token),
      })

      if (!resetToken) {
        return reply.status(400).send({ error: 'Invalid or expired reset token' })
      }

      if (resetToken.usedAt) {
        return reply.status(400).send({ error: 'This reset token has already been used' })
      }

      if (new Date(resetToken.expiresAt) < new Date()) {
        return reply.status(400).send({ error: 'Invalid or expired reset token' })
      }

      const newHash = await bcrypt.hash(newPassword, 12)

      // Update credential hash on the user's email auth method
      await db
        .update(userAuthMethods)
        .set({ credentialHash: newHash, updatedAt: new Date() })
        .where(
          and(
            eq(userAuthMethods.userId, resetToken.userId),
            eq(userAuthMethods.type, 'email'),
          ),
        )

      // Invalidate the token
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, resetToken.id))

      return reply.send({ success: true })
    },
  )

  // ── DELETE /api/auth/account — Delete account ────────────────────────────

  app.delete<{ Body: { password: string } }>(
    '/api/auth/account',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { password } = request.body

      if (!password) {
        return reply.status(400).send({ error: 'Password is required to delete account' })
      }

      // Find email auth method for this user
      const authMethod = await db.query.userAuthMethods.findFirst({
        where: and(
          eq(userAuthMethods.userId, request.user.id),
          eq(userAuthMethods.type, 'email'),
        ),
      })

      if (!authMethod || !authMethod.credentialHash) {
        return reply.status(400).send({ error: 'No password-based auth method found for this account' })
      }

      const valid = await bcrypt.compare(password, authMethod.credentialHash)
      if (!valid) {
        return reply.status(401).send({ error: 'Incorrect password' })
      }

      // Hosted worlds' rows would cascade away with it, leaving their Fly app, database and files running untracked.
      const blocked = await hostedWorldsBlockingDelete({ userId: request.user.id })
      if (blocked) return reply.status(409).send(blocked)
      // Delete user — cascading deletes handle related data
      const imports = await importsGoingWith({ userId: request.user.id })
      // Their private 3D Models go in the same transaction (public ones stay, ownerless)
      const models = await deleteUserWithModels(request.user.id, async (tx) => (await tx.delete(users).where(eq(users.id, request.user.id)).returning({ id: users.id })).length > 0)
      // Their imports' rows cascaded; the private files go too
      await deleteImportFiles(imports)
      await releaseModelFiles(models ?? [])

      return reply.status(204).send()
    },
  )
}
