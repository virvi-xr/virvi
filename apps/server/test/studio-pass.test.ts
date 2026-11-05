import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { authHandoffCodes } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'

// Signed-fetch fixture as in auth-platform.test.ts; the parcel, realm and guest flag come from test headers.
vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async () => { throw new Error('bad signature') },
  verifyDclSceneRequest: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    const scene = {
      sceneId: 'bafyStudio',
      parcel: h['x-test-parcel'] ?? '0,0',
      realm: { hostname: h['x-test-realm'] ?? 'peer.decentraland.org', serverName: h['x-test-server'] ?? 'main' },
      isGuest: h['x-test-guest'] === '1',
    }
    if (typeof v === 'string' && v.startsWith('valid:')) return { wallet: v.slice(6), scene, bodySigned: true }
    throw new Error('bad signature')
  },
}))

const WALLET = '0x00000000000000000000000000000000000000d1'
const PARCEL = '-12,34'

describe('the studio pass', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = { enabled: config.studioEnabled, parcel: config.studioSceneParcel }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioSceneParcel = PARCEL
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioSceneParcel = prev.parcel
    setStudioStore(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    app = await testApp()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await app.close()
  })

  const signIn = (headers: Record<string, string> = {}, wallet = WALLET) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${wallet}`, 'x-test-parcel': PARCEL, ...headers },
      payload: { user: { displayName: 'Visitor' } },
    })
  const studioPass = async (wallet = WALLET) => {
    const res = await signIn({}, wallet)
    expect(res.statusCode).toBe(200)
    return res.json().accessToken as string
  }
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
  const handoff = (t: string) => app.inject({ method: 'POST', url: '/api/auth/handoff', headers: bearer(t) })
  const exchange = (code: string) => app.inject({ method: 'POST', url: '/api/auth/handoff/exchange', payload: { code } })

  describe('issuing the pass', () => {
    it('a signed request from the studio parcel gets a studio pass', async () => {
      const res = await signIn()
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toMatchObject({ verified: true, studio: true, refreshToken: null })
      const claims = verifySessionToken(body.accessToken)!
      expect(claims).toMatchObject({ kind: 'scene', via: 'studio', sceneId: null, locationId: null, wallet: WALLET, verified: true })
      expect(body.user.id).toBe(claims.id)
    })

    it('a guest from the studio parcel gets a guest token', async () => {
      const res = await signIn({ 'x-test-guest': '1' })
      const body = res.json()
      expect(body.guest).toBe(true)
      expect(body.studio).toBeUndefined()
      expect(verifySessionToken(body.accessToken)!.guest).toBe(true)
    })

    it('another parcel gets a normal scene pass', async () => {
      const res = await signIn({ 'x-test-parcel': '1,1' })
      const body = res.json()
      expect(body.studio).toBeUndefined()
      const claims = verifySessionToken(body.accessToken)!
      expect(claims.kind).toBe('scene')
      expect(claims.via).toBeUndefined()
    })

    it('the same parcel in a World or an unofficial realm gets a normal scene pass', async () => {
      for (const headers of [
        { 'x-test-realm': 'worlds-content-server.decentraland.org', 'x-test-server': 'evil.dcl.eth' },
        { 'x-test-realm': 'evil-realm.example.com' },
      ]) {
        const body = (await signIn(headers)).json()
        expect(body.studio, JSON.stringify(headers)).toBeUndefined()
        expect(verifySessionToken(body.accessToken)!.via).toBeUndefined()
      }
    })

    it('no studio parcel set: nobody gets a studio pass', async () => {
      ;(config as any).studioSceneParcel = null
      try {
        const body = (await signIn()).json()
        expect(body.studio).toBeUndefined()
        expect(verifySessionToken(body.accessToken)!.via).toBeUndefined()
      } finally {
        ;(config as any).studioSceneParcel = PARCEL
      }
    })
  })

  describe('what the pass opens', () => {
    it('opens the studio routes, on the Free plan like the website', async () => {
      const t = await studioPass()
      const usage = await app.inject({ method: 'GET', url: '/api/studio/usage', headers: bearer(t) })
      expect(usage.statusCode).toBe(200)
      expect(usage.json()).toMatchObject({ plan: 'free', openDesignLimit: 1 })
      const first = await app.inject({ method: 'POST', url: '/api/studio/designs', headers: bearer(t), payload: { kind: 'wearable', agent: 'claude' } })
      expect(first.statusCode).toBe(201)
      const second = await app.inject({ method: 'POST', url: '/api/studio/designs', headers: bearer(t), payload: { kind: 'wearable', agent: 'claude' } })
      expect(second.statusCode).toBe(403)
      expect(second.json().code).toBe('open_design_limit')
      // The payment routes Task 6 added are studio routes too (unknown payment → 404, past the pass check).
      const pay = await app.inject({ method: 'GET', url: '/api/studio/payments/00000000-0000-0000-0000-000000000000', headers: bearer(t) })
      expect(pay.statusCode).toBe(404)
      // So is Task 9's MANA-back request (unknown report → 404, past the pass check)
      const back = await app.inject({ method: 'POST', url: '/api/studio/mana-refunds', headers: bearer(t), payload: { reportId: '00000000-0000-0000-0000-000000000000' } })
      expect(back.statusCode).toBe(404)
    })

    it('is refused everywhere else with studio_pass_not_allowed', async () => {
      const owner = await createUser()
      const { scene } = await createScene(owner)
      const t = await studioPass()
      for (const [method, url] of [
        ['PUT', '/api/elements/00000000-0000-0000-0000-000000000000'],
        ['GET', '/api/scenes'],
        ['GET', `/api/scenes/${scene.id}`],
        ['GET', '/api/admin/studio/flags'],
        ['GET', '/api/admin/studio/mana-refunds'],
        ['GET', '/api/admin/studio/mana-transfers'],
        ['GET', '/api/auth/wallets'],
      ] as const) {
        const res = await app.inject({ method, url, headers: bearer(t), payload: method === 'PUT' ? {} : undefined })
        expect(res.statusCode, `${method} ${url}`).toBe(403)
        expect(res.json().error, `${method} ${url}`).toBe('studio_pass_not_allowed')
      }
    })

    it('a normal scene pass stays locked out of the studio', async () => {
      const u = await createUser({ wallet: '0x00000000000000000000000000000000000000d2' })
      const { scene } = await createScene(u)
      for (const extra of [{ kind: 'scene', sceneId: scene.id, locationId: null }, { kind: 'scene', sceneId: null, locationId: null }]) {
        const res = await app.inject({ method: 'GET', url: '/api/studio/usage', headers: bearer(tokenFor(u, extra)) })
        expect(res.statusCode).toBe(403)
        expect(res.json().error).toBe('scene_pass_not_allowed')
      }
    })

    it('an account session still opens the studio', async () => {
      const u = await createUser()
      expect((await app.inject({ method: 'GET', url: '/api/studio/usage', headers: bearer(tokenFor(u)) })).statusCode).toBe(200)
    })
  })

  describe('the checkout link', () => {
    it('mints a 10-minute account code that exchanges once for a full account session', async () => {
      const t = await studioPass()
      const before = Date.now()
      const res = await handoff(t)
      expect(res.statusCode).toBe(200)
      const { code, expiresAt } = res.json()
      const exp = new Date(expiresAt).getTime()
      expect(exp).toBeGreaterThanOrEqual(before + 600_000)
      expect(exp).toBeLessThanOrEqual(Date.now() + 600_000)
      const [row] = await db.select().from(authHandoffCodes)
      expect(row).toMatchObject({ kind: 'account', sceneId: null, locationId: null, passExpiresAt: null, wallet: WALLET })

      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(before + 9 * 60_000))
      const ok = await exchange(code)
      expect(ok.statusCode).toBe(200)
      const claims = verifySessionToken(ok.json().accessToken)!
      expect(claims).toMatchObject({ kind: 'account', wallet: WALLET, verified: true, id: verifySessionToken(t)!.id })
      expect(claims.via).toBeUndefined()
      expect(claims.sceneId).toBeUndefined()
      expect(typeof ok.json().refreshToken).toBe('string')

      const again = await exchange(code)
      expect(again.statusCode).toBe(410)
    })

    it('a checkout code is refused 10 minutes and 1 second later', async () => {
      const t = await studioPass()
      const { code, expiresAt } = (await handoff(t)).json()
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(new Date(expiresAt).getTime() + 1000))
      expect((await exchange(code)).statusCode).toBe(410)
      const [row] = await db.select().from(authHandoffCodes).where(eq(authHandoffCodes.wallet, WALLET))
      expect(row.usedAt).toBeNull()
    })

    it("checkout codes have their own rate limit, apart from the HUD's sign-in codes", async () => {
      const t = await studioPass()
      const userId = verifySessionToken(t)!.id
      const account = tokenFor({ id: userId, email: null, role: 'viewer', wallet: WALLET } as any)
      for (let i = 0; i < 5; i++) expect((await handoff(account)).statusCode).toBe(200)
      expect((await handoff(account)).statusCode).toBe(429)
      expect((await handoff(t)).statusCode).toBe(200)
    })

    it("a normal scene pass's code still lasts 60 seconds and exchanges to a scene pass", async () => {
      const u = await createUser({ wallet: '0x00000000000000000000000000000000000000d3' })
      const { scene } = await createScene(u)
      const t = tokenFor(u, { kind: 'scene', sceneId: scene.id, locationId: null, orgId: null })
      const before = Date.now()
      const first = (await handoff(t)).json()
      expect(new Date(first.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 60_000)
      expect(new Date(first.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 59_000)
      const ok = await exchange(first.code)
      expect(ok.statusCode).toBe(200)
      expect(verifySessionToken(ok.json().accessToken)).toMatchObject({ kind: 'scene', sceneId: scene.id })
      expect(ok.json().refreshToken).toBeNull()

      const second = (await handoff(t)).json()
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(new Date(second.expiresAt).getTime() + 1000))
      expect((await exchange(second.code)).statusCode).toBe(410)
    })
  })
})
