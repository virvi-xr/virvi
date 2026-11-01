import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Wallet } from 'ethers'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { issueArPass, issueHyperfyPass } from '../src/auth/scene-pass.js'
import { db } from '../src/db/connection.js'
import { arDevices, arSpaces, hyperfyPairings, hyperfyWorlds } from '../src/db/schema.js'

const pass = (u: any, sceneId: string | null, locationId: string | null = null) => tokenFor(u, { kind: 'scene', sceneId, locationId, orgId: null })

// Routes that never read a bearer token (signed fetch, webhook keys, codes, public browse, static).
// A new public route must be added here deliberately, with its reason.
// Exact `METHOD url` matches.
const PUBLIC_EXACT = [
  'POST /api/auth/register', // creates an account from email + password; no bearer
  'POST /api/auth/login', // email + password; no bearer
  'POST /api/auth/refresh', // takes a refresh token only; an access token (pass or account) gets 401 "Not a refresh token"
  'POST /api/auth/platform', // DCL signed fetch; issues the pass
  'GET /api/auth/providers', // static list of enabled sign-in providers
  'POST /api/auth/forgot-password', // email only
  'POST /api/auth/reset-password', // reset token in body
  'POST /api/auth/wallet/challenge', // nonce for an address; no bearer
  'POST /api/auth/handoff/exchange', // single-use code in body
  'POST /api/setup', // DCL signed fetch (location setup)
  'POST /api/setup/status', // DCL signed fetch (location setup status)
  'GET /api/setup/scene', // public: Virvi scene for a set-up location (guest content-only connect)
  'GET /api/setup/models', // public: model list for a set-up location
  'GET /api/hyperfy/feed', // world-key auth
  'POST /api/hyperfy/analytics', // world-key auth
  'POST /api/hyperfy/pair', // world-key auth; the HUD starts a pairing
  'GET /api/hyperfy/pair/:code/qr.png', // public: the code is the auth (QR of its approve link)
  'POST /api/hyperfy/pair/:code/claim', // the code plus the browser secret is the auth
  'POST /api/hyperfy/pairings/:id/renew', // the pairing's browser secret is the auth
  'POST /api/hyperfy/pairings/vouch', // world-secret auth; a hosted world speaks for its player
  'GET /api/hyperfy/app.hyp', // public: the built Virvi Hyperfy app download
  'POST /api/ar/spaces/:id/analytics', // public for a published space (visits from a headset)
  'POST /api/ar/spaces/:id/report', // public for a published space (a visitor reports it from the headset menu)
  'POST /api/ar/pair', // public: a headset starts a pairing with the hash of its secret
  'POST /api/ar/pair/:code/claim', // the code plus the headset secret is the auth
  'POST /api/ar/devices/:id/pass', // the headset secret is the auth
  'POST /api/ar/devices/:id/end', // the headset secret is the auth
  'POST /api/ar/devices/:id/spaces', // the headset secret is the auth
  'POST /api/ar/devices/:id/scenes', // the headset secret is the auth
  'GET /.well-known/assetlinks.json', // public: the Android app links file, nothing of ours in it
  'POST /api/ingest', // DCL signed fetch / ingest key
  'POST /api/analytics/claims/check-signed', // DCL signed fetch
  'POST /api/ads/serve', // DCL signed fetch (ads for the signed scene's spaces)
  'POST /api/ads/events', // DCL signed fetch (ad views from the signed scene)
  'POST /api/streaming/authorize', // media server callback, shared secret
  'GET /api/streaming/live-keys', // media server callback, shared secret
  'POST /api/streaming/webhook', // media server callback, shared secret
  'POST /api/billing/webhook', // Stripe signature
  'GET /api/assets', // public browse list (never reads a bearer)
  'GET /api/assets/:id', // public asset detail
  'GET /api/assets/categories', // public category list
  'GET /api/catalog/packs', // public credits list (no bearer)
  'POST /api/advertiser-leads', // public: landing page early-access form (anonymous visitors, never reads a bearer)
  'GET /api/studio/render-frames/*', // the signed frame token is the auth (no bearer)
  'GET /api/health', // health check
  'GET /metrics', // Prometheus scrape
  'GET /', // static dashboard
  'GET /*', // static dashboard files
]
// startsWith matches — only genuinely prefixed families.
const PUBLIC_PREFIX = [
  'GET /api/auth/google', // OAuth redirect + callback
  'GET /api/auth/discord', // OAuth redirect + callback
  'GET /api/upload/', // companion upload: the code is the auth
  'POST /api/upload/', // companion upload: the code is the auth
  'GET /hook/', // platform hooks: per-hook secret in the URL
  'POST /hook/', // platform hooks: per-hook secret in the URL
  'GET /api/docs', // Swagger UI and its static files
  'GET /uploads/', // static uploaded media
  'GET /api/studio/worker/', // studio worker machines: the per-design worker token is the auth
  'PUT /api/studio/worker/', // studio worker machines: the per-design worker token is the auth
  'POST /api/studio/worker/', // studio worker machines: the per-design worker token is the auth
]
// Read an optional bearer but treat a scene pass as no bearer (so the walk cannot see a 403).
// Each entry has its own test below.
const IGNORES_SCENE_PASS = [
  'POST /api/auth/wallet/verify', // a pass never links a wallet; it signs in as the wallet instead
]
const isPublic = (method: string, url: string) => {
  const key = `${method} ${url}`
  return PUBLIC_EXACT.includes(key) || PUBLIC_PREFIX.some((p) => key.startsWith(p)) || IGNORES_SCENE_PASS.includes(key)
}

describe('scene pass guard', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('every route without scenePass config refuses a scene pass (route walk)', async () => {
    const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000a1' })
    const { scene } = await createScene(owner)
    const t = pass(owner, scene.id)
    // Collected by the onRoute hook installed in app.ts.
    const all = (app as any).registeredRoutes as Array<{ method: string; url: string; scenePass: boolean }>
    expect(all.length).toBeGreaterThan(50)
    const offenders: string[] = []
    for (const r of all.filter((r) => !r.scenePass && !isPublic(r.method, r.url))) {
      const url = r.url.replace(/:sceneId/g, scene.id).replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000')
      const res = await app.inject({ method: r.method as any, url, headers: { authorization: `Bearer ${t}` }, payload: {} })
      let error: unknown
      try { error = res.json().error } catch { error = undefined }
      if (res.statusCode !== 403 || error !== 'scene_pass_not_allowed') offenders.push(`${r.method} ${r.url} → ${res.statusCode}`)
    }
    expect(offenders).toEqual([])
  })

  it('every PUBLIC_EXACT entry is a registered route (no stale entries)', async () => {
    const keys = new Set(((app as any).registeredRoutes as Array<{ method: string; url: string }>).map((r) => `${r.method} ${r.url}`))
    const missing = [...PUBLIC_EXACT, ...IGNORES_SCENE_PASS].filter((k) => !keys.has(k) && k !== 'GET /' && k !== 'GET /*' && k !== 'GET /metrics')
    expect(missing).toEqual([])
  })

  it('POST /api/auth/wallet/verify treats a scene pass as no bearer (signs in, never links)', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const w = Wallet.createRandom()
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })
    const { nonce, message } = ch.json()
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { address: w.address, nonce, signature: await w.signMessage(message) },
      headers: { authorization: `Bearer ${pass(owner, scene.id)}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().linked).toBeUndefined()
    const claims = verifySessionToken(res.json().accessToken)
    expect(claims?.kind).toBe('account')
    expect(claims?.id).not.toBe(owner.id)
  })

  it('POST /api/auth/refresh refuses a scene access pass', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${pass(owner, scene.id)}` } })
    expect(res.statusCode).toBe(401)
  })

  it('POST /api/auth/handoff keeps its scenePass config through the auth scope (bound pass allowed, visitor pass refused)', async () => {
    const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000b2' })
    const { scene } = await createScene(owner)
    const routes = (app as any).registeredRoutes as Array<{ method: string; url: string; scenePass: boolean }>
    expect(routes.find((r) => r.method === 'POST' && r.url === '/api/auth/handoff')?.scenePass).toBe(true)
    const ok = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${pass(owner, scene.id)}` } })
    expect(ok.statusCode).toBe(200)
    const visitor = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${pass(owner, null)}` } })
    expect(visitor.statusCode).toBe(403)
    expect(visitor.json().error).toBe('scene_pass_not_allowed')
  })

  it('a pass for scene A is refused on scene B for each allowed route', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    const el = await createElement(b.preset.id)
    const inst = await createInstance(el.id)
    const t = pass(owner, a.scene.id)
    const h = { authorization: `Bearer ${t}` }
    const reqs: Array<[string, string]> = [
      ['GET', `/api/scenes/${b.scene.id}`], ['PUT', `/api/scenes/${b.scene.id}`],
      ['POST', `/api/presets/${b.preset.id}/elements`], ['PUT', `/api/elements/${el.id}`], ['DELETE', `/api/elements/${el.id}`],
      ['POST', `/api/elements/${el.id}/instances`], ['PUT', `/api/instances/${inst.id}`], ['DELETE', `/api/instances/${inst.id}`],
      ['GET', `/api/scenes/${b.scene.id}/roles`], ['POST', `/api/scenes/${b.scene.id}/roles`],
      ['DELETE', `/api/scenes/${b.scene.id}/roles/0xabc`], ['POST', `/api/scenes/${b.scene.id}/transfer-host`],
    ]
    for (const [method, url] of reqs) {
      const res = await app.inject({ method: method as any, url, headers: h, payload: {} })
      expect([method, url, res.statusCode]).toEqual([method, url, 403])
      expect(res.json().error).toBe('scene_pass_not_allowed')
    }
    const up = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: h, payload: { sceneId: b.scene.id } })
    expect(up.statusCode).toBe(403)
  })

  it('a visitor pass (sceneId null) is refused on every allowed route', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: { authorization: `Bearer ${pass(owner, null)}` } })
    expect(res.statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${pass(owner, null)}` } })
    expect(list.statusCode).toBe(403)
  })

  it('unknown element id under a pass → 403, not 500', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'PUT', url: '/api/elements/00000000-0000-0000-0000-000000000000', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` }, payload: {} })
    expect(res.statusCode).toBe(403)
    const bad = await app.inject({ method: 'PUT', url: '/api/instances/not-a-uuid', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` }, payload: {} })
    expect(bad.statusCode).toBe(403)
    expect(bad.json().error).toBe('scene_pass_not_allowed')
  })

  it('GET /api/scenes with a pass returns only the bound scene', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    await createScene(owner, 'B')
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` } })
    expect(res.json().scenes.map((s: any) => s.id)).toEqual([a.scene.id])
    expect(res.json().scenes[0].relationship).toBe('owner')
  })

  it('GET /api/scenes with a pass for a scene the user cannot reach returns nothing', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${pass(stranger, a.scene.id)}` } })
    expect(res.json().scenes).toEqual([])
  })

  it('the bound scene still works with normal role checks', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` } })
    expect(res.statusCode).toBe(200)
  })

  it('upload tokens require scene.edit on the scene, for every caller', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const a = await createScene(owner, 'A')
    const denied = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: { authorization: `Bearer ${tokenFor(stranger)}` }, payload: { sceneId: a.scene.id } })
    expect(denied.statusCode).toBe(403)
    const ok = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` }, payload: { sceneId: a.scene.id } })
    expect(ok.statusCode).toBe(201)
    const noScene = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` }, payload: {} })
    expect(noScene.statusCode).toBe(403)
  })

  it('PUT /api/scenes/:sceneId refuses an activePresetId from another scene (account token and pass)', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    for (const t of [tokenFor(owner), pass(owner, a.scene.id)]) {
      const h = { authorization: `Bearer ${t}` }
      const cross = await app.inject({ method: 'PUT', url: `/api/scenes/${a.scene.id}`, headers: h, payload: { activePresetId: b.preset.id } })
      expect(cross.statusCode).toBe(400)
      const junk = await app.inject({ method: 'PUT', url: `/api/scenes/${a.scene.id}`, headers: h, payload: { activePresetId: 'not-a-uuid' } })
      expect(junk.statusCode).toBe(400)
      const own = await app.inject({ method: 'PUT', url: `/api/scenes/${a.scene.id}`, headers: h, payload: { activePresetId: a.preset.id } })
      expect(own.statusCode).toBe(200)
    }
    const after = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(after.json().scene.activePresetId).toBe(a.preset.id)
  })

  it('a pass reads analytics only through its own scene tenure, not a past tenure of another scene', async () => {
    const pastHost = await createUser()
    const newHost = await createUser()
    const a = await createScene(newHost, 'A')
    const b = await createScene(pastHost, 'B')
    const l = await createAnalyticsScene({ locationKey: 'gc:3,3', baseParcel: '3,3', parcels: ['3,3'] } as any)
    await createSetup(l.id, b.scene.id, { startedAt: new Date(Date.now() - 60 * 86400_000), endedAt: new Date(Date.now() - 30 * 86400_000) })
    await createSetup(l.id, a.scene.id)
    const t = pass(pastHost, a.scene.id, l.id)
    const res = await app.inject({ method: 'GET', url: `/api/analytics/locations/${l.id}/summary`, headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: '/api/analytics/locations', headers: { authorization: `Bearer ${t}` } })
    expect(list.json().scenes).toEqual([])
    // Account behaviour is unchanged: the past host still reads their ended tenure.
    const acct = await app.inject({ method: 'GET', url: `/api/analytics/locations/${l.id}/summary`, headers: { authorization: `Bearer ${tokenFor(pastHost)}` } })
    expect(acct.statusCode).toBe(200)
  })

  it('analytics locations list is filtered to the pass location', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    const la = await createAnalyticsScene({ locationKey: 'gc:1,1', baseParcel: '1,1', parcels: ['1,1'] } as any)
    const lb = await createAnalyticsScene({ locationKey: 'gc:2,2', baseParcel: '2,2', parcels: ['2,2'] } as any)
    await createSetup(la.id, a.scene.id); await createSetup(lb.id, b.scene.id)
    const res = await app.inject({ method: 'GET', url: '/api/analytics/locations', headers: { authorization: `Bearer ${pass(owner, a.scene.id, la.id)}` } })
    expect(res.json().scenes.map((s: any) => s.id)).toEqual([la.id])
    const other = await app.inject({ method: 'GET', url: `/api/analytics/locations/${lb.id}/summary`, headers: { authorization: `Bearer ${pass(owner, a.scene.id, la.id)}` } })
    expect(other.statusCode).toBe(403)
    const own = await app.inject({ method: 'GET', url: `/api/analytics/locations/${la.id}/summary`, headers: { authorization: `Bearer ${pass(owner, a.scene.id, la.id)}` } })
    expect(own.statusCode).toBe(200)
  })

  describe('Hyperfy passes (refused unless the route opts in)', () => {
    // The HUD's routes (packages/hyperfy-app/src/virvi-api.ts); nothing else accepts a Hyperfy pass.
    const HUD_ROUTES = [
      'GET /api/scenes/:sceneId',
      'PUT /api/scenes/:sceneId',
      'POST /api/presets/:presetId/elements',
      'PUT /api/elements/:elementId',
      'DELETE /api/elements/:elementId',
      'POST /api/elements/:elementId/live',
      'POST /api/elements/:elementId/instances',
      'PUT /api/instances/:instanceId',
      'GET /api/scenes/:sceneId/library',
      'POST /api/scenes/:sceneId/library',
    ].sort()

    /** A live Hyperfy pass for the owner's own scene, plus ids under that scene for the walk. */
    async function fixture() {
      const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000a2' })
      const { scene, preset } = await createScene(owner)
      const element = await createElement(preset.id)
      const instance = await createInstance(element.id)
      const [world] = await db.insert(hyperfyWorlds).values({ sceneId: scene.id, ownerId: owner.id, name: 'W', keyHash: 'guard-world-hash', keyPrefix: 'virviw_g' }).returning()
      const [pairing] = await db.insert(hyperfyPairings).values({
        worldId: world.id, userId: owner.id, secretHash: 'guard-secret-hash', status: 'claimed', codeExpiresAt: new Date(Date.now() + 3600_000), expiresAt: new Date(Date.now() + 3600_000),
      }).returning()
      const { pass: hp } = issueHyperfyPass(app, owner, owner.wallet ?? null, { id: pairing.id, worldId: world.id, sceneId: scene.id })
      const url = (u: string) =>
        u.replace(/:sceneId/g, scene.id).replace(/:presetId/g, preset.id).replace(/:elementId/g, element.id).replace(/:instanceId/g, instance.id).replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000')
      return { owner, scene, preset, element, instance, hp, url }
    }

    it('only the HUD routes opt in', async () => {
      const all = (app as any).registeredRoutes as Array<{ method: string; url: string; scenePass: boolean; hyperfy: boolean }>
      expect(all.filter((r) => r.hyperfy).map((r) => `${r.method} ${r.url}`).sort()).toEqual(HUD_ROUTES)
      expect(all.filter((r) => r.hyperfy && !r.scenePass)).toEqual([])
    })

    it('every scenePass route without the opt-in refuses a Hyperfy pass for its own scene (route walk)', async () => {
      const f = await fixture()
      const all = (app as any).registeredRoutes as Array<{ method: string; url: string; scenePass: boolean; hyperfy: boolean }>
      const routes = all.filter((r) => r.scenePass && !r.hyperfy)
      expect(routes.length).toBeGreaterThan(15)
      const offenders: string[] = []
      for (const r of routes) {
        const res = await app.inject({ method: r.method as any, url: f.url(r.url), headers: { authorization: `Bearer ${f.hp}` }, payload: { sceneId: f.scene.id, wallet: '0x00000000000000000000000000000000000000b3', role: 'cohost' } })
        let error: unknown
        try { error = res.json().error } catch { error = undefined }
        if (res.statusCode !== 403 || error !== 'hyperfy_pass_not_allowed') offenders.push(`${r.method} ${r.url} → ${res.statusCode} ${String(error)}`)
      }
      expect(offenders).toEqual([])
    })

    it('role writes, transfer-host, upload tokens and the hand-off refuse a Hyperfy pass; nothing is changed', async () => {
      const f = await fixture()
      const h = { authorization: `Bearer ${f.hp}` }
      const cohost = '0x00000000000000000000000000000000000000b4'
      const cases: Array<[string, string, object | undefined]> = [
        ['POST', `/api/scenes/${f.scene.id}/roles`, { wallet: cohost, role: 'cohost' }],
        ['DELETE', `/api/scenes/${f.scene.id}/roles/${cohost}`, undefined],
        ['POST', `/api/scenes/${f.scene.id}/transfer-host`, { wallet: cohost }],
        ['POST', '/api/upload-tokens', { sceneId: f.scene.id }],
        ['POST', '/api/auth/handoff', {}],
      ]
      for (const [method, url, payload] of cases) {
        const res = await app.inject({ method: method as any, url, headers: h, payload })
        expect([res.statusCode, res.json().error], `${method} ${url}`).toEqual([403, 'hyperfy_pass_not_allowed'])
      }
      const roles = await app.inject({ method: 'GET', url: `/api/scenes/${f.scene.id}/roles`, headers: { authorization: `Bearer ${tokenFor(f.owner)}` } })
      expect(JSON.stringify(roles.json())).not.toContain(cohost)
    })

    it('the HUD routes still take a Hyperfy pass', async () => {
      const f = await fixture()
      const h = { authorization: `Bearer ${f.hp}` }
      const t = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      expect((await app.inject({ method: 'GET', url: `/api/scenes/${f.scene.id}`, headers: h })).statusCode).toBe(200)
      expect((await app.inject({ method: 'PUT', url: `/api/instances/${f.instance.id}`, headers: h, payload: t })).statusCode).toBe(200)
      expect((await app.inject({ method: 'PUT', url: `/api/elements/${f.element.id}`, headers: h, payload: { enabled: false } })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url: `/api/scenes/${f.scene.id}/library`, headers: h })).statusCode).toBe(200)
      const el = await app.inject({ method: 'POST', url: `/api/presets/${f.preset.id}/elements`, headers: h, payload: { type: 'model', name: 'Tree', properties: { modelSrc: 'https://x/t.glb' } } })
      expect(el.statusCode).toBe(201)
      const id = el.json().element.id
      expect((await app.inject({ method: 'POST', url: `/api/elements/${id}/instances`, headers: h, payload: t })).statusCode).toBe(201)
      expect((await app.inject({ method: 'DELETE', url: `/api/elements/${id}`, headers: h })).statusCode).toBe(204)
    })
  })

  describe('AR passes (refused unless the route opts in)', () => {
    // The headset's routes; nothing else accepts an AR pass.
    const AR_ROUTES = [
      'GET /api/scenes/:sceneId',
      'POST /api/presets/:presetId/elements',
      'PUT /api/elements/:elementId',
      'DELETE /api/elements/:elementId',
      'POST /api/elements/:elementId/instances',
      'PUT /api/instances/:instanceId',
      'GET /api/scenes/:sceneId/library',
      'POST /api/scenes/:sceneId/library',
      'GET /api/ar/markers/by-code/:code',
      'GET /api/ar/spaces/:id/feed',
      'POST /api/ar/room-scans',
      'GET /api/scenes/:sceneId/ar/spaces',
      'PUT /api/ar/markers/:id/pose',
      'PUT /api/ar/spaces/:id/adjustments/:instanceId',
      'DELETE /api/ar/spaces/:id/adjustments/:instanceId',
      'POST /api/ar/drafts',
      'POST /api/ar/drafts/end',
    ].sort()

    /** A live AR pass for the owner's own scene, plus ids under that scene for the walk. */
    async function fixture() {
      const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000a3' })
      const { scene, preset } = await createScene(owner)
      const element = await createElement(preset.id)
      const instance = await createInstance(element.id)
      const [space] = await db.insert(arSpaces).values({ sceneId: scene.id, name: 'S' }).returning()
      const [device] = await db.insert(arDevices).values({
        userId: owner.id, secretHash: 'guard-secret-hash', kind: 'personal', status: 'claimed', codeExpiresAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      }).returning()
      const { pass: ap } = issueArPass(app, owner, owner.wallet ?? null, { deviceId: device.id, sceneId: scene.id })
      const url = (u: string) =>
        u.replace(/:sceneId/g, scene.id).replace(/:presetId/g, preset.id).replace(/:elementId/g, element.id).replace(/:instanceId/g, instance.id)
          .replace(/:id/g, space.id).replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000')
      return { owner, scene, ap, url }
    }

    it('only the headset routes opt in', async () => {
      const all = (app as any).registeredRoutes as Array<{ method: string; url: string; scenePass: boolean; ar: boolean }>
      expect(all.filter((r) => r.ar).map((r) => `${r.method} ${r.url}`).sort()).toEqual(AR_ROUTES)
      expect(all.filter((r) => r.ar && !r.scenePass)).toEqual([])
    })

    it('every route without the opt-in refuses an AR pass for its own scene (route walk)', async () => {
      const f = await fixture()
      const all = (app as any).registeredRoutes as Array<{ method: string; url: string; scenePass: boolean; ar: boolean }>
      const routes = all.filter((r) => !r.ar && !isPublic(r.method, r.url))
      expect(routes.length).toBeGreaterThan(50)
      const offenders: string[] = []
      for (const r of routes) {
        const res = await app.inject({ method: r.method as any, url: f.url(r.url), headers: { authorization: `Bearer ${f.ap}` }, payload: { sceneId: f.scene.id, wallet: '0x00000000000000000000000000000000000000b5', role: 'cohost' } })
        let error: unknown
        try { error = res.json().error } catch { error = undefined }
        if (res.statusCode !== 403 || error !== 'ar_pass_not_allowed') offenders.push(`${r.method} ${r.url} → ${res.statusCode} ${String(error)}`)
      }
      expect(offenders).toEqual([])
    })

    it('a revoked headset refuses its pass everywhere, opted-in routes included', async () => {
      const f = await fixture()
      await db.update(arDevices).set({ status: 'revoked' })
      const res = await app.inject({ method: 'GET', url: `/api/scenes/${f.scene.id}`, headers: { authorization: `Bearer ${f.ap}` } })
      expect([res.statusCode, res.json().error]).toEqual([401, 'device_revoked'])
    })
  })
})
