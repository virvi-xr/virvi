import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { Wallet } from 'ethers'
import { createSigner } from 'fast-jwt'
import { db } from '../src/db/connection.js'
import { users, userAuthMethods, studioDesigns, studioUsageDays, scenes, sceneImports, roomScans, arDevices } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { TRIAL_DAY, reservePrompt } from '../src/studio/quota.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { finishOAuth, mergeTrial } from '../src/auth/trial-convert.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'
import { createDesign } from './helpers/studio.js'

describe('converting and merging a trial', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = config.studioEnabled
  beforeAll(() => { ;(config as any).studioEnabled = true })
  afterAll(() => { ;(config as any).studioEnabled = prev; setStudioStore(null) })
  beforeEach(async () => { await resetDb(); setStudioStore(memoryStudioStore()); app = await testApp() })
  afterEach(() => app.close())

  async function makeTrial(opts: { designs?: number; prompts?: number } = {}) {
    const u = await createUser({ email: null, name: 'Guest' })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
    for (let i = 0; i < (opts.designs ?? 1); i++) await createDesign(u, { name: `Trial ${i}` })
    for (let i = 0; i < (opts.prompts ?? 0); i++) await reservePrompt(u.id, new Date(), { counted: true })
    const s = issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() })
    return { u, ...s, headers: { authorization: `Bearer ${s.accessToken}` } }
  }
  const owned = async (id: string) => (await db.select().from(studioDesigns).where(eq(studioDesigns.ownerId, id))).length

  it('email sign-up from a trial keeps the same id, its designs, and resets prompts', async () => {
    const t = await makeTrial({ designs: 1, prompts: 2 })
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: t.headers, payload: { email: 'New@Test.dev', password: 'hunter2hunter2', displayName: 'Newbie', fromAction: 'more_prompts' } })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.user).toMatchObject({ id: t.u.id, email: 'new@test.dev', displayName: 'Newbie' })
    expect(await owned(t.u.id)).toBe(1)
    const [row] = await db.select().from(users).where(eq(users.id, t.u.id))
    expect(row.isTrial).toBe(false)
    expect(await db.select().from(studioUsageDays).where(eq(studioUsageDays.userId, t.u.id))).toEqual([])
    const usage = await app.inject({ method: 'GET', url: '/api/studio/usage', headers: { authorization: `Bearer ${body.accessToken}` } })
    expect(usage.json()).toMatchObject({ left: 3 })
    expect(usage.json().trial).toBeFalsy()
  })

  it('email sign-up from a trial with a taken email is still 409 and leaves the trial alone', async () => {
    const t = await makeTrial()
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'dup@test.dev', password: 'hunter2hunter2', displayName: 'A' } })
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: t.headers, payload: { email: 'dup@test.dev', password: 'hunter2hunter2', displayName: 'B' } })
    expect(res.statusCode).toBe(409)
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].isTrial).toBe(true)
  })

  it('signing in from a trial moves its designs into the account and removes the trial', async () => {
    const t = await makeTrial({ designs: 2, prompts: 1 })
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'old@test.dev', password: 'hunter2hunter2', displayName: 'Old' } })
    const accountId = reg.json().user.id
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: t.headers, payload: { email: 'old@test.dev', password: 'hunter2hunter2', fromAction: 'x' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.id).toBe(accountId)
    expect(await owned(accountId)).toBe(2)
    expect(await db.query.users.findFirst({ where: eq(users.id, t.u.id) })).toBeUndefined()
    const usage = await app.inject({ method: 'GET', url: '/api/studio/usage', headers: { authorization: `Bearer ${res.json().accessToken}` } })
    expect(usage.json()).toMatchObject({ left: 3 })
  })

  async function walletVerify(w: Wallet, headers?: Record<string, string>) {
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })
    const { nonce, message } = ch.json()
    return app.inject({ method: 'POST', url: '/api/auth/wallet/verify', headers, payload: { address: w.address, nonce, signature: await w.signMessage(message), fromAction: 'x' } })
  }

  it('wallet sign-in converts or merges', async () => {
    const t = await makeTrial({ designs: 1 })
    const w = Wallet.createRandom()
    const res = await walletVerify(w, t.headers)
    expect(res.statusCode).toBe(200)
    expect(res.json().user.id).toBe(t.u.id)
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].isTrial).toBe(false)
    expect(await owned(t.u.id)).toBe(1)

    const t2 = await makeTrial({ designs: 1 })
    const w2 = Wallet.createRandom()
    const known = await createUser({ wallet: w2.address })
    const res2 = await walletVerify(w2, t2.headers)
    expect(res2.statusCode).toBe(200)
    expect(res2.json().user.id).toBe(known.id)
    expect(await owned(known.id)).toBe(1)
    expect(await db.query.users.findFirst({ where: eq(users.id, t2.u.id) })).toBeUndefined()
  })

  const identity = (id: string) => ({ type: 'oauth' as const, identifier: `google:${id}`, email: `${id}@g.dev`, displayName: 'G User', metadata: { provider: 'google' } })
  const adopt = (accountToken: string, trialToken: unknown, fromAction?: string) =>
    app.inject({ method: 'POST', url: '/api/auth/trial/adopt', headers: { authorization: `Bearer ${accountToken}` }, payload: { trialToken, ...(fromAction ? { fromAction } : {}) } })

  it('after Google sign-in, the browser holding the trial session moves it into the account', async () => {
    const t = await makeTrial({ designs: 1 })
    const s = await finishOAuth(app, identity('new1'))
    expect(s.user.id).not.toBe(t.u.id)
    const res = await adopt(s.accessToken, t.refreshToken, 'more_prompts')
    expect([res.statusCode, res.json()]).toEqual([200, { moved: true }])
    expect(await owned(s.user.id)).toBe(1)
    expect(await db.query.users.findFirst({ where: eq(users.id, t.u.id) })).toBeUndefined()
    // a second hand-over of the same trial finds nothing to move
    expect((await adopt(s.accessToken, t.refreshToken)).json()).toEqual({ moved: false })
  })

  it('an expired trial access token still hands the trial over (the browser holds the session)', async () => {
    const t = await makeTrial({ designs: 1 })
    const s = await finishOAuth(app, identity('exp1'))
    const expired = createSigner({ key: config.jwtSecret, expiresIn: 1 })({ id: t.u.id, kind: 'trial', role: 'creator', displayName: 'Guest' })
    await new Promise((r) => setTimeout(r, 5))
    expect((await adopt(s.accessToken, expired)).json()).toEqual({ moved: true })
    expect(await owned(s.user.id)).toBe(1)
  })

  it('a forged token, an account token or garbage moves nothing', async () => {
    const t = await makeTrial({ designs: 1 })
    const s = await finishOAuth(app, identity('f1'))
    const forged = createSigner({ key: 'other-secret', expiresIn: 600_000 })({ id: t.u.id, kind: 'trial' })
    for (const bad of [forged, s.accessToken, 'garbage', 42, undefined]) {
      const res = await adopt(s.accessToken, bad)
      expect([res.statusCode, res.json()]).toEqual([200, { moved: false }])
    }
    expect(await owned(t.u.id)).toBe(1)
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].isTrial).toBe(true)
  })

  it('only an account can take a trial over: a trial bearer or no bearer is refused', async () => {
    const t = await makeTrial()
    const t2 = await makeTrial()
    const asTrial = await adopt(t2.accessToken, t.refreshToken)
    expect([asTrial.statusCode, asTrial.json().error]).toEqual([403, 'account_required'])
    const none = await app.inject({ method: 'POST', url: '/api/auth/trial/adopt', payload: { trialToken: t.refreshToken } })
    expect(none.statusCode).toBe(401)
  })

  it('an OAuth start link carries no trial: a crafted ?claim= is ignored', async () => {
    const t = await makeTrial({ designs: 1 })
    const prev = [config.googleClientId, config.googleClientSecret]
    ;(config as any).googleClientId = 'cid'; (config as any).googleClientSecret = 'sec'
    const res = await app.inject({ method: 'GET', url: `/api/auth/google?claim=${t.accessToken}` })
    ;(config as any).googleClientId = prev[0]; (config as any).googleClientSecret = prev[1]
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).not.toContain('state=')
    expect(await owned(t.u.id)).toBe(1)
  })

  it('an OAuth start passes a well-formed state through, and drops a malformed one', async () => {
    const prev = [config.googleClientId, config.googleClientSecret]
    ;(config as any).googleClientId = 'cid'; (config as any).googleClientSecret = 'sec'
    const ok = await app.inject({ method: 'GET', url: '/api/auth/google?state=AbCdEfGhIjKlMnOpQrStUv_-' })
    const bad = await app.inject({ method: 'GET', url: '/api/auth/google?state=x.y' })
    ;(config as any).googleClientId = prev[0]; (config as any).googleClientSecret = prev[1]
    expect(new URL(String(ok.headers.location)).searchParams.get('state')).toBe('AbCdEfGhIjKlMnOpQrStUv_-')
    expect(String(bad.headers.location)).not.toContain('state=')
  })

  it('a trial idle past its expiry is not handed over (the sweep may be removing it)', async () => {
    const t = await makeTrial({ designs: 1 })
    await db.update(users).set({ trialLastActiveAt: new Date(Date.now() - (config.trialIdleDays + 1) * 86400_000) }).where(eq(users.id, t.u.id))
    const s = await finishOAuth(app, identity('idle1'))
    expect((await adopt(s.accessToken, t.refreshToken)).json()).toEqual({ moved: false })
  })

  it("the trial's old tokens are refused after conversion", async () => {
    const t = await makeTrial()
    await app.inject({ method: 'POST', url: '/api/auth/register', headers: t.headers, payload: { email: 'c@test.dev', password: 'hunter2hunter2', displayName: 'C' } })
    const a = await app.inject({ method: 'GET', url: '/api/studio/designs', headers: t.headers })
    expect([a.statusCode, a.json().error]).toEqual([401, 'trial_ended'])
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${t.refreshToken}` } })
    expect([r.statusCode, r.json().error]).toEqual([401, 'trial_ended'])
  })

  /** A trial access token for `t` that ran out a minute ago (signed with the server's own key). */
  const expiredTrialHeaders = (t: { u: { id: string } }) => {
    const iat = Math.floor(Date.now() / 1000) - 3600
    const tok = createSigner({ key: config.jwtSecret })({ id: t.u.id, role: 'creator', kind: 'trial', iat, exp: iat + 60 })
    return { authorization: `Bearer ${tok}` }
  }

  it('sign-up with an expired trial bearer is 401 trial_expired, not a separate account', async () => {
    const t = await makeTrial({ designs: 1 })
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: expiredTrialHeaders(t), payload: { email: 'late@test.dev', password: 'hunter2hunter2', displayName: 'Late' } })
    expect([res.statusCode, res.json().error]).toEqual([401, 'trial_expired'])
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, 'late@test.dev') })).toBeUndefined()
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].isTrial).toBe(true)
  })

  it('sign-in and wallet sign-in with an expired trial bearer are 401 trial_expired', async () => {
    const t = await makeTrial({ designs: 1 })
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'acct@test.dev', password: 'hunter2hunter2', displayName: 'Acct' } })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: expiredTrialHeaders(t), payload: { email: 'acct@test.dev', password: 'hunter2hunter2' } })
    expect([login.statusCode, login.json().error]).toEqual([401, 'trial_expired'])
    const wallet = await walletVerify(Wallet.createRandom(), expiredTrialHeaders(t))
    expect([wallet.statusCode, wallet.json().error]).toEqual([401, 'trial_expired'])
    expect(await owned(t.u.id)).toBe(1)
  })

  /**
   * Runs `request` while another transaction holds the trial row, having already turned it into an account (the winner
   * of a concurrent conversion): the request reads the trial before the winner commits and converts after.
   */
  async function losingConvert<T>(trialId: string, winner: (tx: any) => Promise<void>, request: () => Promise<T>): Promise<T> {
    let release!: () => void
    let updated!: () => void
    const held = new Promise<void>((r) => { release = r })
    const ready = new Promise<void>((r) => { updated = r })
    const done = db.transaction(async (tx) => {
      await tx.update(users).set({ isTrial: false }).where(eq(users.id, trialId))
      await winner(tx)
      updated()
      await held
    })
    await ready
    const res = request()
    for (let i = 0; i < 200; i++) {
      const [{ n }] = await db.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`) as unknown as [{ n: number }]
      if (n > 0) break
      await new Promise((r) => setTimeout(r, 25))
    }
    release()
    await done
    return res
  }

  it('losing a concurrent conversion on sign-up makes a normal account, not a 500', async () => {
    const t = await makeTrial()
    const res = await losingConvert(t.u.id, async () => {}, () =>
      app.inject({ method: 'POST', url: '/api/auth/register', headers: t.headers, payload: { email: 'late@test.dev', password: 'hunter2hunter2', displayName: 'Late' } }))
    expect(res.statusCode).toBe(201)
    expect(res.json().user.id).not.toBe(t.u.id)
    expect(res.json().user.email).toBe('late@test.dev')
  })

  it('losing a concurrent conversion on sign-up to the same email is 409, not a 500', async () => {
    const t = await makeTrial()
    const res = await losingConvert(t.u.id, async (tx) => {
      await tx.insert(userAuthMethods).values({ userId: t.u.id, type: 'email', identifier: 'same@test.dev', credentialHash: 'x' })
    }, () => app.inject({ method: 'POST', url: '/api/auth/register', headers: t.headers, payload: { email: 'same@test.dev', password: 'hunter2hunter2', displayName: 'Same' } }))
    expect([res.statusCode, res.json().error]).toEqual([409, 'Email already registered'])
  })

  it('losing a concurrent conversion on wallet sign-in signs into the wallet account, not a 500', async () => {
    const t = await makeTrial()
    const w = Wallet.createRandom()
    const fresh = await losingConvert(t.u.id, async () => {}, () => walletVerify(w, t.headers))
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json().user.id).not.toBe(t.u.id)

    // The winner linked this same wallet: the loser lands in the account the trial became
    const t2 = await makeTrial()
    const w2 = Wallet.createRandom()
    const same = await losingConvert(t2.u.id, async (tx) => {
      await tx.insert(userAuthMethods).values({ userId: t2.u.id, type: 'wallet', identifier: w2.address.toLowerCase(), metadata: { verified: true } })
    }, () => walletVerify(w2, t2.headers))
    expect(same.statusCode).toBe(200)
    expect(same.json().user.id).toBe(t2.u.id)
  })

  describe('scenes, imports, scans and headsets (phase 2)', () => {
    const scanLayout = (): any => ({ version: 1, rooms: [{ label: 'R', floor: [[0, 0], [4, 0], [4, 3], [0, 3]], floorY: 0, ceilingHeight: 2.5, walls: [], objects: [], anchor: { source: 'quest-mruk', roomId: 'r', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } } }] })

    /** A trial with an import's scene (sandbox import, thumbnail), a room scan and an approved personal headset. */
    async function withSceneData(t: { u: { id: string } }) {
      const { scene } = await createScene(t.u as any, 'Imported')
      const [imp] = await db.insert(sceneImports).values({ userId: t.u.id, sceneId: scene.id, worldName: 'x.dcl.eth', kind: 'sdk7', sourceKey: 'imports/x/source.zip', status: 'built', sandbox: true }).returning()
      const [scan] = await db.insert(roomScans).values({ userId: t.u.id, name: 'Lounge', source: 'quest-mruk', layout: scanLayout() }).returning()
      const [device] = await db.insert(arDevices).values({ userId: t.u.id, secretHash: 'h', kind: 'personal', status: 'claimed', codeExpiresAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) }).returning()
      return { scene, imp, scan, device }
    }
    async function expectOwnedBy(d: Awaited<ReturnType<typeof withSceneData>>, userId: string) {
      expect((await db.select().from(scenes).where(eq(scenes.id, d.scene.id)))[0]).toMatchObject({ ownerId: userId, orgId: null })
      // a guest's import stays sandbox: the account claims it for its place when it deploys it
      expect((await db.select().from(sceneImports).where(eq(sceneImports.id, d.imp.id)))[0]).toMatchObject({ userId, sceneId: d.scene.id, sandbox: true })
      expect((await db.select().from(roomScans).where(eq(roomScans.id, d.scan.id)))[0].userId).toBe(userId)
      expect((await db.select().from(arDevices).where(eq(arDevices.id, d.device.id)))[0]).toMatchObject({ userId, status: 'claimed' })
    }

    it('signing in from a trial moves its scenes, imports, scans and headsets', async () => {
      const t = await makeTrial({ designs: 0 })
      const d = await withSceneData(t)
      const account = await createUser()
      expect(await mergeTrial(t.u.id, account.id)).toBe(true)
      await expectOwnedBy(d, account.id)
      expect(await db.query.users.findFirst({ where: eq(users.id, t.u.id) })).toBeUndefined()
    })

    it("wallet sign-in from a trial at Deploy merges into the wallet's account", async () => {
      const t = await makeTrial({ designs: 0 })
      const d = await withSceneData(t)
      const w = Wallet.createRandom()
      const known = await createUser({ wallet: w.address })
      const res = await walletVerify(w, t.headers)
      expect([res.statusCode, res.json().user.id]).toEqual([200, known.id])
      await expectOwnedBy(d, known.id)
      expect(await db.query.users.findFirst({ where: eq(users.id, t.u.id) })).toBeUndefined()
    })

    it('email sign-up keeps them on the same id', async () => {
      const t = await makeTrial({ designs: 0 })
      const d = await withSceneData(t)
      const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: t.headers, payload: { email: 'keep@test.dev', password: 'hunter2hunter2', displayName: 'Keep' } })
      expect(res.statusCode).toBe(201)
      await expectOwnedBy(d, t.u.id)
      expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].isTrial).toBe(false)
    })

    it("every scene moves, whatever the account already holds (no plan limits scenes; quotas stop new work, not moved work)", async () => {
      const account = await createUser()
      await createScene(account, 'Mine')
      const t = await makeTrial({ designs: 0 })
      await createScene(t.u as any, 'Guest 1')
      await createScene(t.u as any, 'Guest 2')
      expect(await mergeTrial(t.u.id, account.id)).toBe(true)
      expect((await db.select().from(scenes).where(eq(scenes.ownerId, account.id))).map((s) => s.name).sort()).toEqual(['Guest 1', 'Guest 2', 'Mine'])
    })
  })

  it('TRIAL_DAY usage never lands on the account when merging', async () => {
    const t = await makeTrial({ prompts: 2 })
    const acct = await createUser()
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'm@test.dev', password: 'hunter2hunter2', displayName: 'M' } })
    await app.inject({ method: 'POST', url: '/api/auth/login', headers: t.headers, payload: { email: 'm@test.dev', password: 'hunter2hunter2' } })
    expect(await db.select().from(studioUsageDays).where(eq(studioUsageDays.day, TRIAL_DAY))).toEqual([])
    void acct; void reg
  })
})
