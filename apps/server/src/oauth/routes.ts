import type { FastifyInstance, FastifyReply } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { oauthClients, oauthCodes } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { getSceneAccess } from '../auth/permissions.js'
import { actorFromClaims } from '../auth/actor.js'
import { config } from '../config.js'
import { issueApiKey } from './keys.js'

/**
 * OAuth 2.1 for MCP clients (LIV-170): the protected-resource and authorization-server metadata, dynamic client
 * registration (public clients only), the authorization code flow with PKCE S256, and a token endpoint. The person
 * approves on virvi.io (/oauth/authorize), choosing read-only or full access and optionally scenes; the access token
 * is an API key tied to that app, so read-only, scene limits, the call log and revoking work as for any key.
 */
export const OAUTH_TOKEN_DAYS = 90
const CODE_MINUTES = 10
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A redirect URI a client may register: https anywhere, or http on this machine (desktop and CLI clients). */
export function redirectAllowed(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 500) return false
  let u: URL
  try { u = new URL(uri) } catch { return false }
  if (u.hash) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
}

const api = () => config.publicUrl.replace(/\/+$/, '')
const web = () => config.webAppUrl.replace(/\/+$/, '')

export function authorizationServerMetadata() {
  return {
    issuer: api(),
    authorization_endpoint: `${web()}/oauth/authorize/`,
    token_endpoint: `${api()}/oauth/token`,
    registration_endpoint: `${api()}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['read', 'full'],
    service_documentation: `${web()}/docs/agents/use-virvi-with-your-agent/`,
  }
}

const oauthError = (reply: FastifyReply, status: number, error: string, description: string) =>
  reply.status(status).header('cache-control', 'no-store').send({ error, error_description: description })

export default async function oauthRoutes(app: FastifyInstance) {
  const resource = () => ({ resource: `${api()}/mcp`, authorization_servers: [api()], scopes_supported: ['read', 'full'], resource_name: 'Virvi' })
  app.get('/.well-known/oauth-protected-resource', async () => resource())
  app.get('/.well-known/oauth-protected-resource/mcp', async () => resource())
  app.get('/.well-known/oauth-authorization-server', async () => authorizationServerMetadata())

  // RFC 7591: anyone may register a public client; what it can do is decided by the person who approves it
  app.post('/oauth/register', async (request, reply) => {
    const b = (request.body ?? {}) as { client_name?: unknown; redirect_uris?: unknown; token_endpoint_auth_method?: unknown }
    const uris = b.redirect_uris
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(redirectAllowed)) {
      return oauthError(reply, 400, 'invalid_redirect_uri', 'Give 1 to 5 redirect_uris: https, or http on localhost.')
    }
    if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') {
      return oauthError(reply, 400, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported.')
    }
    const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 100) : 'An AI app'
    const id = `vc_${b64url(randomBytes(18))}`
    const [row] = await db.insert(oauthClients).values({ id, name, redirectUris: [...new Set(uris as string[])] }).returning()
    return reply.status(201).header('cache-control', 'no-store').send({
      client_id: row.id, client_name: row.name, redirect_uris: row.redirectUris, client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
    })
  })

  // The approval page reads the app's name and redirect URIs (public: a client id names no person)
  app.get<{ Params: { clientId: string } }>('/api/oauth/clients/:clientId', async (request, reply) => {
    const [c] = await db.select().from(oauthClients).where(eq(oauthClients.id, request.params.clientId))
    if (!c) return reply.status(404).send({ error: 'client_not_found' })
    return reply.send({ clientId: c.id, name: c.name, redirectUris: c.redirectUris })
  })

  // The signed-in person approves: a one-time code for the app's redirect, bound to its PKCE challenge
  app.post('/api/oauth/authorize', { preHandler: [authenticate] }, async (request, reply) => {
    if (request.user.viaApiKey || request.user.kind !== 'account' || request.user.trial) return reply.status(403).send({ error: 'account_required', message: 'Sign in to Virvi to connect an app.' })
    const b = (request.body ?? {}) as Record<string, unknown>
    const [c] = typeof b.clientId === 'string' ? await db.select().from(oauthClients).where(eq(oauthClients.id, b.clientId)) : []
    if (!c) return reply.status(400).send({ error: 'invalid_client', message: 'That app is not registered.' })
    if (typeof b.redirectUri !== 'string' || !c.redirectUris.includes(b.redirectUri)) return reply.status(400).send({ error: 'invalid_redirect_uri', message: "That redirect isn't one the app registered." })
    if (b.codeChallengeMethod !== 'S256' || typeof b.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(b.codeChallenge)) {
      return reply.status(400).send({ error: 'invalid_request', message: 'The app must use PKCE with S256.' })
    }
    const access = b.access === 'read' ? 'read' : b.access === 'full' ? 'full' : null
    if (!access) return reply.status(400).send({ error: 'invalid_request', message: "access must be 'read' or 'full'" })
    const sceneIds = b.sceneIds === undefined ? [] : b.sceneIds
    if (!Array.isArray(sceneIds) || sceneIds.length > 50 || !sceneIds.every((x) => typeof x === 'string' && UUID.test(x))) return reply.status(400).send({ error: 'invalid_request', message: 'sceneIds must be up to 50 scene ids' })
    for (const sceneId of sceneIds as string[]) {
      if ((await getSceneAccess(actorFromClaims(request.user), sceneId)).level === 'none') return reply.status(404).send({ error: 'scene_not_found', message: 'One of those scenes was not found.' })
    }
    const code = b64url(randomBytes(32))
    await db.insert(oauthCodes).values({
      codeHash: sha256(code), clientId: c.id, userId: request.user.id, redirectUri: b.redirectUri, codeChallenge: b.codeChallenge,
      access, sceneIds: [...new Set(sceneIds as string[])], expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
    })
    const to = new URL(b.redirectUri)
    to.searchParams.set('code', code)
    if (typeof b.state === 'string' && b.state) to.searchParams.set('state', b.state.slice(0, 500))
    to.searchParams.set('iss', api())
    return reply.send({ redirect: to.toString() })
  })

  // The token endpoint takes form bodies (RFC 6749) as well as JSON
  await app.register(async (token) => {
    token.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => {
      try { done(null, Object.fromEntries(new URLSearchParams(String(body)))) } catch (err) { done(err as Error, undefined) }
    })
    token.post('/oauth/token', async (request, reply) => {
      const b = (request.body ?? {}) as Record<string, unknown>
      if (b.grant_type !== 'authorization_code') return oauthError(reply, 400, 'unsupported_grant_type', 'Only authorization_code is supported.')
      const { code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri } = b
      if (typeof code !== 'string' || typeof verifier !== 'string' || typeof clientId !== 'string' || typeof redirectUri !== 'string') {
        return oauthError(reply, 400, 'invalid_request', 'code, code_verifier, client_id and redirect_uri are required.')
      }
      // Used once: the update that claims it is the only one that can succeed
      const [row] = await db.update(oauthCodes).set({ usedAt: new Date() })
        .where(and(eq(oauthCodes.codeHash, sha256(code)), isNull(oauthCodes.usedAt), gt(oauthCodes.expiresAt, new Date())))
        .returning()
      if (!row || row.clientId !== clientId || row.redirectUri !== redirectUri) return oauthError(reply, 400, 'invalid_grant', 'That code is not valid (used, expired, or for another app).')
      if (b64url(createHash('sha256').update(verifier).digest()) !== row.codeChallenge) return oauthError(reply, 400, 'invalid_grant', 'The code_verifier does not match.')
      const [client] = await db.select({ name: oauthClients.name }).from(oauthClients).where(eq(oauthClients.id, row.clientId))
      const { rawKey } = await issueApiKey({
        userId: row.userId, orgId: null, name: `${client?.name ?? 'An AI app'} (connected app)`,
        access: row.access === 'read' ? 'read' : 'full', sceneIds: row.sceneIds, expiresAt: new Date(Date.now() + OAUTH_TOKEN_DAYS * 86_400_000), oauthClientId: row.clientId,
      })
      return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send({
        access_token: rawKey, token_type: 'Bearer', expires_in: OAUTH_TOKEN_DAYS * 86_400, scope: row.access,
      })
    })
  })
}
