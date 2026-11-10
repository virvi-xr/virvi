import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { resetDb } from './helpers/db.js'
import { testApp, createUser } from './helpers/factories.js'
import { isPublic } from './helpers/public-routes.js'
import { db } from '../src/db/connection.js'
import { users, studioDesigns } from '../src/db/schema.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { actorFromClaims } from '../src/auth/actor.js'

const ALLOWED = [
  'GET /api/studio/usage',
  'POST /api/studio/designs',
  'GET /api/studio/designs',
  'GET /api/studio/designs/:id',
  'PATCH /api/studio/designs/:id',
  'POST /api/studio/designs/:id/prompts',
  'POST /api/studio/designs/:id/prompt-help',
  'GET /api/studio/designs/:id/finalize',
  'POST /api/studio/designs/:id/pieces/:category/revisions/:number/report',
  'POST /api/studio/designs/:id/uploads',
  'GET /api/studio/designs/:id/uploads/:uploadId',
  'DELETE /api/studio/designs/:id/uploads/:uploadId',
  'POST /api/studio/designs/:id/renders',
  'POST /api/studio/designs/:id/set-renders',
  'POST /api/studio/designs/:id/emote-checks',
  'POST /api/studio/designs/:id/clipping',
  'GET /api/studio/designs/:id/set',
  'PUT /api/studio/designs/:id/revisions/:jobId/rating',
  'DELETE /api/studio/designs/:id/revisions/:jobId/rating',
  'POST /api/studio/designs/:id/revisions/:jobId/try-again',
  'GET /api/studio/defaults',
  'GET /api/scenes',
  'GET /api/scenes/:sceneId',
  'GET /api/scenes/:sceneId/delete-plan',
  'GET /api/scenes/deleted',
  'PUT /api/scenes/:sceneId',
  'DELETE /api/scenes/:sceneId',
  'POST /api/scenes/:sceneId/presets',
  'POST /api/scenes/:sceneId/purge',
  'POST /api/scenes/:sceneId/restore',
  'PATCH /api/presets/:presetId',
  'DELETE /api/presets/:presetId',
  'POST /api/presets/:presetId/activate',
  'POST /api/presets/:presetId/elements',
  'PUT /api/elements/:elementId',
  'POST /api/elements/:elementId/live',
  'DELETE /api/elements/:elementId',
  'POST /api/elements/:elementId/instances',
  'PUT /api/instances/:instanceId',
  'DELETE /api/instances/:instanceId',
  'DELETE /api/elements/:elementId/instances',
  'GET /api/wizard/catalog',
  'GET /api/wizard/options',
  'GET /api/room-scans',
  'GET /api/room-scans/:id',
  'DELETE /api/room-scans/:id',
  'GET /api/room-scans/:id/preview.glb',
  'GET /api/hyperfy/slots',
  'GET /api/assets',
  'GET /api/assets/:id',
  'GET /api/assets/categories',
  'POST /api/imports',
  'GET /api/imports',
  'GET /api/imports/:id',
  'GET /api/imports/:id/log',
  'GET /api/ar/pair/:code',
  'POST /api/ar/pair/:code/approve',
  'GET /api/ar/devices',
  'DELETE /api/ar/devices/:id',
].sort()

// Routes that are not public but never call `authenticate`: they check their own credential, so a trial bearer
// cannot answer account_required. For these the walk only asserts a trial bearer never gets a 2xx.
const OWN_AUTH: Record<string, string> = {}

async function makeTrial(app: Awaited<ReturnType<typeof testApp>>) {
  const u = await createUser({ email: null })
  await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
  const s = issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() })
  return { u, ...s }
}

describe('trial guard', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const routes = () => (app as any).registeredRoutes as Array<{ method: string; url: string; trial: boolean }>

  it('only the listed routes take a trial token', () => {
    expect(routes().filter((r) => r.trial).map((r) => `${r.method} ${r.url}`).sort()).toEqual(ALLOWED)
  })

  it('every other route answers account_required to a trial token', async () => {
    const t = await makeTrial(app)
    const offenders: string[] = []
    const ownAuthSeen: string[] = []
    for (const r of routes().filter((r) => !r.trial && !isPublic(r.method, r.url))) {
      const url = r.url.replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000')
      const res = await app.inject({ method: r.method as any, url, headers: { authorization: `Bearer ${t.accessToken}` }, payload: {} })
      const key = `${r.method} ${r.url}`
      if (key in OWN_AUTH) {
        ownAuthSeen.push(key)
        if (res.statusCode >= 200 && res.statusCode < 300) offenders.push(`${key} (own auth) → ${res.statusCode}`)
        continue
      }
      let body: any
      try { body = res.json() } catch { body = {} }
      if (res.statusCode !== 403 || body.error !== 'account_required' || body.action !== key) offenders.push(`${key} → ${res.statusCode} ${res.body.slice(0, 100)}`)
    }
    expect(offenders).toEqual([])
    expect(ownAuthSeen.sort()).toEqual(Object.keys(OWN_AUTH).sort())
  }, 60_000)

  it('the allowlisted routes take a trial token', async () => {
    const t = await makeTrial(app)
    const res = await app.inject({ method: 'GET', url: '/api/studio/designs', headers: { authorization: `Bearer ${t.accessToken}` } })
    expect(res.statusCode).not.toBe(401)
    expect(res.json().error).not.toBe('account_required')
  })

  it("a converted or deleted trial's token is refused", async () => {
    const t = await makeTrial(app)
    const h = { authorization: `Bearer ${t.accessToken}` }
    await db.update(users).set({ isTrial: false }).where(eq(users.id, t.u.id))
    const conv = await app.inject({ method: 'GET', url: '/api/studio/designs', headers: h })
    expect([conv.statusCode, conv.json().error]).toEqual([401, 'trial_ended'])
    await db.delete(users).where(eq(users.id, t.u.id))
    const gone = await app.inject({ method: 'GET', url: '/api/studio/designs', headers: h })
    expect([gone.statusCode, gone.json().error]).toEqual([401, 'trial_ended'])
    // Also on a route that is not allowlisted: ended wins over account_required
    const other = await app.inject({ method: 'POST', url: '/api/scenes', headers: h, payload: { name: 'x' } })
    expect([other.statusCode, other.json().error]).toEqual([401, 'trial_ended'])
  })

  it('a trial token is no Colyseus session; its actor is an unverified trial creator', async () => {
    const t = await makeTrial(app)
    expect(verifySessionToken(t.accessToken)).toBeNull()
    expect(actorFromClaims({ id: t.u.id, kind: 'trial', role: 'admin', email: null, wallet: '0xAB', verified: true }))
      .toEqual({ userId: t.u.id, role: 'creator', wallet: null, verified: false, trial: true })
  })

  it('sets request.user.trial and refreshes trialLastActiveAt only when stale', async () => {
    const t = await makeTrial(app)
    const h = { authorization: `Bearer ${t.accessToken}` }
    const old = new Date(Date.now() - 3600_000)
    await db.update(users).set({ trialLastActiveAt: old }).where(eq(users.id, t.u.id))
    await app.inject({ method: 'GET', url: '/api/studio/designs', headers: h })
    await new Promise((r) => setTimeout(r, 200))
    const [a] = await db.select().from(users).where(eq(users.id, t.u.id))
    expect(a.trialLastActiveAt!.getTime()).toBeGreaterThan(old.getTime() + 3000_000)
    const stamp = a.trialLastActiveAt!.getTime()
    await app.inject({ method: 'GET', url: '/api/studio/designs', headers: h })
    await new Promise((r) => setTimeout(r, 200))
    const [b] = await db.select().from(users).where(eq(users.id, t.u.id))
    expect(b.trialLastActiveAt!.getTime()).toBe(stamp)
  })

  it('a trial over its upload total gets account_required upload_more', async () => {
    const t = await makeTrial(app)
    const h = { authorization: `Bearer ${t.accessToken}` }
    const { config } = await import('../src/config.js')
    const [design] = await db.insert(studioDesigns).values({ ownerId: t.u.id, name: 'T', kind: 'wearable', agent: 'claude' }).returning()
    const id = design.id
    const prev = config.trialUploadBytes
    const prevStudio = config.studioEnabled
    ;(config as any).studioEnabled = true
    ;(config as any).trialUploadBytes = 10
    try {
      const res = await app.inject({ method: 'POST', url: `/api/studio/designs/${id}/uploads?name=a.png`, headers: { ...h, 'content-type': 'image/png' }, payload: Buffer.alloc(50, 1) })
      expect([res.statusCode, res.json()]).toEqual([403, { error: 'account_required', action: 'upload_more' }])
    } finally { ;(config as any).trialUploadBytes = prev; (config as any).studioEnabled = prevStudio }
  })
})
