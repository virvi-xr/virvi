import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { Wallet } from 'ethers'
import { db } from '../src/db/connection.js'
import { notifications, studioDesignInvites, studioDesignMembers, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { initBus } from '../src/realtime/bus.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { linkVerifiedWallet, resolveVerifiedWalletUser } from '../src/auth/wallet-users.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, randomWallet, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, fakeFly } from './helpers/studio.js'

// The mail transport: sendEmail reaches it only when SMTP is set
const sendMail = vi.hoisted(() => vi.fn(async (_m: { to: string; subject: string; html: string }) => ({})))
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }))

const S = '/api/studio'
const DAY = 24 * 3600_000

describe('design invites by linked wallet', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, smtp: config.smtpHost, web: config.webAppUrl }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).webAppUrl = 'https://app.virvi.test'
    ;(config as any).smtpHost = 'smtp.test'
    initBus({ publish: () => {}, subscribe: () => {}, unsubscribe: () => {} })
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).webAppUrl = prev.web
    ;(config as any).smtpHost = prev.smtp
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
    owner = await createUser({ name: 'Olive Owner', email: 'olive@test.dev', wallet: randomWallet() })
    sendMail.mockClear()
  })
  afterEach(() => { vi.useRealTimers() })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const invite = (u: TestUser, designId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `${S}/designs/${designId}/invites`, headers: as(u), payload })
  const myInvites = async (u: TestUser) => (await app.inject({ method: 'GET', url: `${S}/invites`, headers: as(u) })).json()
  const act = (u: TestUser, path: string) => app.inject({ method: 'POST', url: `${S}${path}`, headers: as(u), payload: {} })
  const people = (u: TestUser, designId: string) => app.inject({ method: 'GET', url: `${S}/designs/${designId}/people`, headers: as(u) })
  const inviteNotes = (userId: string) =>
    db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, 'studio_invite')))
  /** The wallet sign-in route, signed by `w` (with `bearer`, it links the wallet to that account instead). */
  const walletVerify = async (w: Wallet, bearer?: string) => {
    const ch = (await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })).json()
    return app.inject({
      method: 'POST', url: '/api/auth/wallet/verify',
      payload: { address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message) },
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    })
  }

  it('an account with the wallet linked gets it (mixed case matches), accepts it, and no email goes out', async () => {
    const d = await createDesign(owner, { name: 'Neon cap' })
    const w = randomWallet()
    const cora = await createUser({ name: 'Cora', email: 'cora@test.dev', wallet: w })
    const mixed = '0x' + w.slice(2).toUpperCase()
    const res = await invite(owner, d.id, { wallet: `  ${mixed} `, role: 'viewer' })
    expect(res.statusCode).toBe(201)
    const inv = res.json().invite
    expect(inv).toMatchObject({ email: null, wallet: w, role: 'viewer' })
    const [row] = await db.select().from(studioDesignInvites)
    expect([row.wallet, row.email, row.userId]).toEqual([w, null, cora.id])
    expect(sendMail).not.toHaveBeenCalled()
    expect(await myInvites(cora)).toEqual([{ id: inv.id, designId: d.id, designName: 'Neon cap', inviterName: 'Olive Owner', role: 'viewer', expiresAt: inv.expiresAt }])
    expect(await inviteNotes(cora.id)).toHaveLength(1)
    expect((await act(cora, `/invites/${inv.id}/accept`)).statusCode).toBe(200)
    const [m] = await db.select().from(studioDesignMembers).where(eq(studioDesignMembers.userId, cora.id))
    expect(m.role).toBe('viewer')
  })

  it('resend on a wallet invite extends it and notifies again, never emails', async () => {
    const d = await createDesign(owner)
    const w = randomWallet()
    const cora = await createUser({ wallet: w })
    const inv = (await invite(owner, d.id, { wallet: w })).json().invite
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 3600_000))
    const re = await act(owner, `/designs/${d.id}/invites/${inv.id}/resend`)
    expect(re.statusCode).toBe(200)
    expect(new Date(re.json().invite.expiresAt).getTime()).toBe(Date.now() + 14 * DAY)
    expect(sendMail).not.toHaveBeenCalled()
    const notes = await inviteNotes(cora.id)
    expect(notes.filter((n) => !n.readAt)).toHaveLength(1)
    expect(notes).toHaveLength(2)
    // The resend limits still hold
    const soon = await act(owner, `/designs/${d.id}/invites/${inv.id}/resend`)
    expect([soon.statusCode, soon.json().code]).toEqual([429, 'resend_too_soon'])
  })

  it('refuses both fields, a bad wallet, a duplicate, the owner’s own wallet and a member’s wallet', async () => {
    const d = await createDesign(owner)
    const w = randomWallet()
    expect((await invite(owner, d.id, { email: 'a@test.dev', wallet: w })).statusCode).toBe(400)
    expect((await invite(owner, d.id, {})).statusCode).toBe(400)
    for (const bad of ['0x123', 'not a wallet', '0x' + 'g'.repeat(40), 42, w + '0']) {
      expect((await invite(owner, d.id, { wallet: bad })).statusCode).toBe(400)
    }
    expect((await invite(owner, d.id, { wallet: w })).statusCode).toBe(201)
    const dup = await invite(owner, d.id, { wallet: w.toUpperCase().replace('0X', '0x') })
    expect([dup.statusCode, dup.json().code]).toEqual([409, 'already_invited'])
    const self = await invite(owner, d.id, { wallet: owner.wallet })
    expect([self.statusCode, self.json()]).toEqual([400, { error: 'self', code: 'self' }])
    const vic = await createUser({ wallet: randomWallet() })
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: vic.id, role: 'viewer' })
    const member = await invite(owner, d.id, { wallet: vic.wallet })
    expect([member.statusCode, member.json().code]).toEqual([409, 'already_member'])
  })

  it('a trial holding the wallet is not matched', async () => {
    const d = await createDesign(owner)
    const w = randomWallet()
    const t = await createUser({ email: null, wallet: w })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    expect((await invite(owner, d.id, { wallet: w })).statusCode).toBe(201)
    const [row] = await db.select().from(studioDesignInvites)
    expect(row.userId).toBeNull()
  })

  it('an unmatched wallet invite waits, and the account that signs in with the wallet gets it', async () => {
    const d = await createDesign(owner, { name: 'Neon cap' })
    const w = Wallet.createRandom()
    const inv = (await invite(owner, d.id, { wallet: w.address })).json().invite
    const [row] = await db.select().from(studioDesignInvites)
    expect([row.userId, row.wallet]).toEqual([null, w.address.toLowerCase()])
    const other = await createUser()
    expect(await myInvites(other)).toEqual([])

    const signIn = await walletVerify(w)
    expect(signIn.statusCode).toBe(200)
    const [me] = await db.select().from(users).where(eq(users.id, signIn.json().user.id))
    const meUser = { ...me, wallet: w.address.toLowerCase() }
    expect((await myInvites(meUser)).map((i: { id: string }) => i.id)).toEqual([inv.id])
    const notes = await inviteNotes(me.id)
    expect(notes).toHaveLength(1)
    expect(notes[0].data).toMatchObject({ inviteId: inv.id, designName: 'Neon cap', inviterName: 'Olive Owner' })
    // Signing in again neither duplicates nor moves it
    await resolveVerifiedWalletUser(w.address, 'x', 'account')
    expect(await inviteNotes(me.id)).toHaveLength(1)
    expect((await act(meUser, `/invites/${inv.id}/accept`)).statusCode).toBe(200)
  })

  it('linking the wallet to an existing account claims the waiting invite', async () => {
    const d = await createDesign(owner)
    const w = Wallet.createRandom()
    const inv = (await invite(owner, d.id, { wallet: w.address })).json().invite
    const cora = await createUser({ email: 'cora@test.dev' })
    expect((await walletVerify(w, tokenFor(cora))).json()).toEqual({ linked: true })
    expect((await myInvites(cora)).map((i: { id: string }) => i.id)).toEqual([inv.id])
    expect(await inviteNotes(cora.id)).toHaveLength(1)
  })

  it('a cancelled or expired invite isn’t claimed, nor one on a design the account is already on', async () => {
    const d1 = await createDesign(owner)
    const d2 = await createDesign(owner)
    const d3 = await createDesign(owner)
    const w = randomWallet()
    const i1 = (await invite(owner, d1.id, { wallet: w })).json().invite
    await act(owner, `/designs/${d1.id}/invites/${i1.id}/cancel`)
    await invite(owner, d2.id, { wallet: w })
    await db.update(studioDesignInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(studioDesignInvites.designId, d2.id))
    await invite(owner, d3.id, { wallet: w })
    const cora = await createUser({ email: 'cora@test.dev' })
    await db.insert(studioDesignMembers).values({ designId: d3.id, userId: cora.id, role: 'viewer' })
    expect(await linkVerifiedWallet(cora.id, w)).toBe('linked')
    const claimed = await db.select().from(studioDesignInvites).where(eq(studioDesignInvites.userId, cora.id))
    expect(claimed).toEqual([])
    expect(await inviteNotes(cora.id)).toEqual([])
  })

  it('the owner linking the invited wallet doesn’t claim their own invite', async () => {
    const d = await createDesign(owner)
    const w = randomWallet()
    await invite(owner, d.id, { wallet: w })
    expect(await linkVerifiedWallet(owner.id, w)).toBe('linked')
    const [row] = await db.select().from(studioDesignInvites)
    expect(row.userId).toBeNull()
  })

  it('a trial never claims', async () => {
    const d = await createDesign(owner)
    const w = randomWallet()
    await invite(owner, d.id, { wallet: w })
    const t = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    expect(await linkVerifiedWallet(t.id, w)).toBe('linked')
    const [row] = await db.select().from(studioDesignInvites)
    expect(row.userId).toBeNull()
    expect(await inviteNotes(t.id)).toEqual([])
  })

  it('a trial that signs up with the wallet claims it once it is an account', async () => {
    const d = await createDesign(owner)
    const w = Wallet.createRandom()
    const inv = (await invite(owner, d.id, { wallet: w.address })).json().invite
    const t = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    const trial = issueTrialSession(app, { id: t.id, displayName: t.displayName, role: 'creator', trialLastActiveAt: new Date() })
    const res = await walletVerify(w, trial.accessToken)
    expect(res.statusCode).toBe(200)
    expect(res.json().user.id).toBe(t.id)
    const [row] = await db.select().from(studioDesignInvites).where(eq(studioDesignInvites.id, inv.id))
    expect(row.userId).toBe(t.id)
    expect(await inviteNotes(t.id)).toHaveLength(1)
  })

  it('an in-world visitor’s claimed wallet invite follows the wallet to the account it is linked to', async () => {
    const d = await createDesign(owner)
    const w = randomWallet()
    const inv = (await invite(owner, d.id, { wallet: w })).json().invite
    const shell = await resolveVerifiedWalletUser(w, 'Visitor', 'visitor')
    expect((await db.select().from(studioDesignInvites))[0].userId).toBe(shell.id)
    const cora = await createUser({ email: 'cora@test.dev' })
    expect(await linkVerifiedWallet(cora.id, w)).toBe('linked')
    expect((await myInvites(cora)).map((i: { id: string }) => i.id)).toEqual([inv.id])
  })

  for (const who of ['owner', 'member'] as const) {
    it(`a visitor’s claimed invite merged onto the design’s ${who} is cancelled and its bell item read`, async () => {
      const d = await createDesign(owner)
      const w = randomWallet()
      const inv = (await invite(owner, d.id, { wallet: w })).json().invite
      const shell = await resolveVerifiedWalletUser(w, 'Visitor', 'visitor')
      expect((await inviteNotes(shell.id)).filter((n) => !n.readAt)).toHaveLength(1)
      let target = owner
      if (who === 'member') {
        target = await createUser({ email: 'cora@test.dev' })
        await db.insert(studioDesignMembers).values({ designId: d.id, userId: target.id, role: 'viewer' })
      }
      expect(await linkVerifiedWallet(target.id, w)).toBe('linked')
      expect(await myInvites(target)).toEqual([])
      expect((await inviteNotes(target.id)).filter((n) => !n.readAt)).toEqual([])
      const [row] = await db.select().from(studioDesignInvites).where(eq(studioDesignInvites.id, inv.id))
      expect(row.cancelledAt).not.toBeNull()
    })
  }

  it('an invite link’s page doesn’t show the wallet', async () => {
    const d = await createDesign(owner)
    const w = randomWallet()
    const inv = (await invite(owner, d.id, { wallet: w })).json().invite
    const [row] = await db.select().from(studioDesignInvites).where(eq(studioDesignInvites.id, inv.id))
    const cora = await createUser()
    const look = await app.inject({ method: 'GET', url: `${S}/invite-links/${row.token}`, headers: as(cora) })
    expect(look.statusCode).toBe(200)
    expect(Object.keys(look.json()).sort()).toEqual(['designId', 'designName', 'inviterName', 'role', 'status'])
    expect(JSON.stringify(look.json())).not.toContain(w)
  })

  it('the 400 for both or neither starts with email, so the page asks for one', async () => {
    const d = await createDesign(owner)
    for (const payload of [{ email: 'a@test.dev', wallet: randomWallet() }, {}]) {
      const res = await invite(owner, d.id, payload)
      expect([res.statusCode, res.json().error]).toEqual([400, 'email or wallet is required, not both'])
    }
  })

  it('a failed claim never fails sign-in', async () => {
    const d = await createDesign(owner)
    const w = Wallet.createRandom()
    await invite(owner, d.id, { wallet: w.address })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const update = vi.spyOn(db, 'update').mockImplementationOnce(() => { throw new Error('db down') })
    const res = await walletVerify(w)
    update.mockRestore()
    expect(res.statusCode).toBe(200)
    expect(logged).toHaveBeenCalledWith('[virvi-studio] wallet invite claim failed:', expect.any(Error))
    logged.mockRestore()
  })

  it('the owner’s People view carries the wallet; a member’s has no invites', async () => {
    const d = await createDesign(owner)
    const w = randomWallet()
    const inv = (await invite(owner, d.id, { wallet: w })).json().invite
    const e = (await invite(owner, d.id, { email: 'x@test.dev' })).json().invite
    expect((await people(owner, d.id)).json().invites).toEqual([
      { id: inv.id, email: null, wallet: w, role: 'collaborator', expiresAt: inv.expiresAt, link: inv.link },
      { id: e.id, email: 'x@test.dev', wallet: null, role: 'collaborator', expiresAt: e.expiresAt, link: e.link },
    ])
    const cora = await createUser()
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: cora.id, role: 'collaborator' })
    const pc = (await people(cora, d.id)).json()
    expect(pc.invites).toBeUndefined()
    expect(JSON.stringify(pc)).not.toContain(w)
  })
})
