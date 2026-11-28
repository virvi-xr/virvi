import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'
import { redirectAllowed } from '../src/oauth/routes.js'

/** LIV-170: OAuth 2.1 with PKCE for MCP clients; the token is an API key tied to the app. */
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

describe('OAuth for MCP clients', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  const register = () => app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: [REDIRECT] } })
  const pkce = () => {
    const verifier = b64url(randomBytes(32))
    return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
  }
  const approve = (u: TestUser, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/oauth/authorize', headers: { authorization: `Bearer ${tokenFor(u)}` }, payload: body })
  const exchange = (form: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(form).toString() })

  it('publishes its metadata, and /mcp says where to sign in', async () => {
    const meta = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json()
    expect(meta).toMatchObject({ code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'] })
    expect(meta.authorization_endpoint).toMatch(/\/oauth\/authorize\/$/)
    expect((await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })).json().resource).toMatch(/\/mcp$/)
    const unauth = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })
    expect(unauth.statusCode).toBe(401)
    expect(unauth.headers['www-authenticate']).toMatch(/resource_metadata=".*\/\.well-known\/oauth-protected-resource"/)
  })

  it('register → approve → token → use, as a read-only, scene-limited connected app', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner, 'Club')
    const other = await createScene(owner, 'Other')
    const reg = await register()
    expect(reg.statusCode).toBe(201)
    const clientId = reg.json().client_id
    expect((await app.inject({ method: 'GET', url: `/api/oauth/clients/${clientId}` })).json()).toEqual({ clientId, name: 'Claude', redirectUris: [REDIRECT] })

    const { verifier, challenge } = pkce()
    const ok = await approve(owner, { clientId, redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: 'S256', state: 'xyz', access: 'read', sceneIds: [scene.id] })
    expect(ok.statusCode).toBe(200)
    const to = new URL(ok.json().redirect)
    expect(to.origin + to.pathname).toBe(REDIRECT)
    expect(to.searchParams.get('state')).toBe('xyz')
    const code = to.searchParams.get('code')!

    // A wrong verifier fails, and burns the code
    expect((await exchange({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: clientId, redirect_uri: REDIRECT })).json().error).toBe('invalid_grant')
    const { verifier: v2, challenge: c2 } = pkce()
    const code2 = new URL((await approve(owner, { clientId, redirectUri: REDIRECT, codeChallenge: c2, codeChallengeMethod: 'S256', access: 'read', sceneIds: [scene.id] })).json().redirect).searchParams.get('code')!
    const tok = await exchange({ grant_type: 'authorization_code', code: code2, code_verifier: v2, client_id: clientId, redirect_uri: REDIRECT })
    expect(tok.statusCode).toBe(200)
    expect(tok.json()).toMatchObject({ token_type: 'Bearer', scope: 'read', expires_in: 90 * 86400 })
    // A code works once
    expect((await exchange({ grant_type: 'authorization_code', code: code2, code_verifier: v2, client_id: clientId, redirect_uri: REDIRECT })).json().error).toBe('invalid_grant')
    void verifier

    const access = tok.json().access_token
    const mcp = (body: unknown) => app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${access}` }, payload: body as any })
    const tools = (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json().result.tools.map((t: any) => t.name)
    expect(tools).toContain('get_scene')
    expect(tools).not.toContain('add_instance') // read-only
    const call = async (sceneId: string) => (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_scene', arguments: { sceneId } } })).json().result.isError
    expect(await call(scene.id)).toBe(false)
    expect(await call(other.scene.id)).toBe(true) // scene-limited

    // It shows in Settings as a connected app, and deleting it cuts the app off
    const keys = (await app.inject({ method: 'GET', url: '/api/keys', headers: { authorization: `Bearer ${tokenFor(owner)}` } })).json().keys
    expect(keys).toEqual([expect.objectContaining({ name: 'Claude (connected app)', oauthClientId: clientId, access: 'read', sceneIds: [scene.id] })])
    await app.inject({ method: 'DELETE', url: `/api/keys/${keys[0].id}`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect((await mcp({ jsonrpc: '2.0', id: 3, method: 'ping' })).statusCode).toBe(401)
  })

  it('refuses bad registrations, unregistered redirects, missing PKCE, and anyone but a signed-in account', async () => {
    expect((await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://evil.example/cb'] } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' } })).statusCode).toBe(400)
    const clientId = (await register()).json().client_id
    const owner = await createUser()
    const { challenge } = pkce()
    expect((await approve(owner, { clientId, redirectUri: 'https://elsewhere.example/cb', codeChallenge: challenge, codeChallengeMethod: 'S256', access: 'full' })).json().error).toBe('invalid_redirect_uri')
    expect((await approve(owner, { clientId, redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: 'plain', access: 'full' })).json().error).toBe('invalid_request')
    expect((await app.inject({ method: 'POST', url: '/api/oauth/authorize', payload: { clientId } })).statusCode).toBe(401)
    const theirs = await createScene(await createUser())
    expect((await approve(owner, { clientId, redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: 'S256', access: 'full', sceneIds: [theirs.scene.id] })).statusCode).toBe(404)
    expect((await exchange({ grant_type: 'password', username: 'a', password: 'b' })).json().error).toBe('unsupported_grant_type')
  })

  it('redirect URIs: https, or http on this machine', () => {
    expect(redirectAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(redirectAllowed('http://localhost:6274/oauth/callback')).toBe(true)
    expect(redirectAllowed('http://127.0.0.1:33418/')).toBe(true)
    expect(redirectAllowed('http://example.com/cb')).toBe(false)
    expect(redirectAllowed('javascript:alert(1)')).toBe(false)
    expect(redirectAllowed('https://a.example/cb#frag')).toBe(false)
  })
})
