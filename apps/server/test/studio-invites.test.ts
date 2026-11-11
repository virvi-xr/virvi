import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesignInvites, studioDesignMembers, studioPauses, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { initBus } from '../src/realtime/bus.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, fakeFly } from './helpers/studio.js'

// The mail transport: sendEmail reaches it only when SMTP is set
const sendMail = vi.hoisted(() => vi.fn(async (_m: { to: string; subject: string; html: string }) => ({})))
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }))

const S = '/api/studio'
const DAY = 24 * 3600_000

describe('design invites and people', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  const published: Array<{ topic: string; data: any }> = []
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, max: config.studioMaxMembers, smtp: config.smtpHost, web: config.webAppUrl }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).webAppUrl = 'https://app.virvi.test'
    initBus({ publish: (topic, data) => { published.push({ topic, data }) }, subscribe: () => {}, unsubscribe: () => {} })
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).webAppUrl = prev.web
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
    owner = await createUser({ name: 'Olive Owner', email: 'olive@test.dev' })
    published.length = 0
    sendMail.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    ;(config as any).studioMaxMembers = prev.max
    ;(config as any).smtpHost = prev.smtp
  })

  const as = (u: TestUser | { accessToken: string }) => ({ authorization: `Bearer ${'accessToken' in u ? u.accessToken : tokenFor(u)}` })
  const invite = (u: TestUser | { accessToken: string }, designId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `${S}/designs/${designId}/invites`, headers: as(u), payload })
  const myInvites = async (u: TestUser) => (await app.inject({ method: 'GET', url: `${S}/invites`, headers: as(u) })).json()
  const act = (u: TestUser | { accessToken: string }, path: string, payload?: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `${S}${path}`, headers: as(u), payload: payload ?? {} })
  const people = (u: TestUser, designId: string) => app.inject({ method: 'GET', url: `${S}/designs/${designId}/people`, headers: as(u) })
  const tokenOf = async (inviteId: string) =>
    (await db.select({ token: studioDesignInvites.token }).from(studioDesignInvites).where(eq(studioDesignInvites.id, inviteId)))[0].token
  const prompt = (u: TestUser, id: string) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/prompts`, headers: as(u), payload: { text: 'a neon cap', selectedSlots: ['hat'] } })
  const makeTrial = async () => {
    const u = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
    return issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() })
  }

  it('owner invites an existing account: it shows in their invites, and accepting makes them a collaborator', async () => {
    const d = await createDesign(owner, { name: 'Neon cap' })
    const cora = await createUser({ name: 'Cora', email: 'cora@test.dev' })
    const res = await invite(owner, d.id, { email: 'cora@test.dev' })
    expect(res.statusCode).toBe(201)
    const inv = res.json().invite
    expect(inv).toMatchObject({ email: 'cora@test.dev', role: 'collaborator' })
    expect(inv.link).toBe(`https://app.virvi.test/studio/invite/${await tokenOf(inv.id)}`)
    expect(new Date(inv.expiresAt).getTime()).toBeGreaterThan(Date.now() + 13.9 * DAY)
    expect(await myInvites(cora)).toEqual([{ id: inv.id, designId: d.id, designName: 'Neon cap', inviterName: 'Olive Owner', role: 'collaborator', expiresAt: inv.expiresAt }])
    expect(await myInvites(owner)).toEqual([])

    const ok = await act(cora, `/invites/${inv.id}/accept`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ designId: d.id, role: 'collaborator' })
    expect(await myInvites(cora)).toEqual([])
    expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(cora) })).json().role).toBe('collaborator')
    // People: the owner sees members and open invites (none left); a member sees members only
    const p = await people(owner, d.id)
    expect(p.statusCode).toBe(200)
    expect(p.json()).toMatchObject({ members: [{ userId: owner.id, displayName: 'Olive Owner', role: 'owner' }, { userId: cora.id, displayName: 'Cora', role: 'collaborator' }], invites: [] })
    expect(p.json().members[1].joinedAt).toBeTruthy()
    const pc = (await people(cora, d.id)).json()
    expect(pc.members).toHaveLength(2)
    expect(pc.invites).toBeUndefined()
    // A second accept of the same invite is not open any more
    expect((await act(cora, `/invites/${inv.id}/accept`)).statusCode).toBe(404)
  })

  it('invite email is trimmed and case-insensitive; duplicate is 409', async () => {
    const d = await createDesign(owner)
    const cora = await createUser({ email: 'Cora@Test.dev' })
    const res = await invite(owner, d.id, { email: '  CORA@test.DEV ', role: 'viewer' })
    expect(res.statusCode).toBe(201)
    expect(res.json().invite).toMatchObject({ email: 'cora@test.dev', role: 'viewer' })
    const [row] = await db.select().from(studioDesignInvites)
    expect(row.userId).toBe(cora.id)
    expect((await invite(owner, d.id, { email: 'cora@TEST.dev' })).json()).toEqual({ error: 'already_invited', code: 'already_invited' })
    expect((await invite(owner, d.id, { email: 'cora@test.dev' })).statusCode).toBe(409)
  })

  it('refuses a bad email or role, the owner themselves, and someone already on it', async () => {
    const d = await createDesign(owner)
    const cora = await createUser({ email: 'cora@test.dev' })
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: cora.id, role: 'viewer' })
    expect((await invite(owner, d.id, { email: 'not an email' })).statusCode).toBe(400)
    expect((await invite(owner, d.id, { email: 'x@test.dev', role: 'owner' })).statusCode).toBe(400)
    expect((await invite(owner, d.id, { email: ' OLIVE@test.dev' })).json()).toEqual({ error: 'self', code: 'self' })
    const dup = await invite(owner, d.id, { email: 'cora@test.dev' })
    expect([dup.statusCode, dup.json().code]).toEqual([409, 'already_member'])
  })

  it('decline: the invite leaves their list and they are not a member', async () => {
    const d = await createDesign(owner)
    const cora = await createUser({ email: 'cora@test.dev' })
    const other = await createUser()
    const inv = (await invite(owner, d.id, { email: 'cora@test.dev' })).json().invite
    expect((await act(other, `/invites/${inv.id}/decline`)).statusCode).toBe(404)
    expect((await act(other, `/invites/${inv.id}/accept`)).statusCode).toBe(404)
    expect((await act(cora, `/invites/${inv.id}/decline`)).statusCode).toBe(204)
    expect(await myInvites(cora)).toEqual([])
    expect((await act(cora, `/invites/${inv.id}/accept`)).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(cora) })).statusCode).toBe(404)
    // Declined, the same email can be invited again
    expect((await invite(owner, d.id, { email: 'cora@test.dev' })).statusCode).toBe(201)
  })

  it('cancel: the invite is gone from their list, the owner’s people and its link', async () => {
    const d = await createDesign(owner)
    const cora = await createUser({ email: 'cora@test.dev' })
    const inv = (await invite(owner, d.id, { email: 'cora@test.dev' })).json().invite
    expect((await people(owner, d.id)).json().invites).toEqual([{ id: inv.id, email: 'cora@test.dev', wallet: null, role: 'collaborator', expiresAt: inv.expiresAt, link: inv.link }])
    expect((await act(cora, `/designs/${d.id}/invites/${inv.id}/cancel`)).statusCode).toBe(404)
    expect((await act(owner, `/designs/${d.id}/invites/${inv.id}/cancel`)).statusCode).toBe(204)
    expect(await myInvites(cora)).toEqual([])
    expect((await people(owner, d.id)).json().invites).toEqual([])
    expect((await act(cora, `/invites/${inv.id}/accept`)).statusCode).toBe(404)
    const token = await tokenOf(inv.id)
    expect((await app.inject({ method: 'GET', url: `${S}/invite-links/${token}`, headers: as(cora) })).json().status).toBe('used')
    expect((await act(cora, `/invite-links/${token}/accept`)).statusCode).toBe(409)
  })

  it('an expired invite can’t be accepted; resend gives it 14 more days and the same link', async () => {
    const d = await createDesign(owner)
    const cora = await createUser({ email: 'cora@test.dev' })
    const inv = (await invite(owner, d.id, { email: 'cora@test.dev' })).json().invite
    const token = await tokenOf(inv.id)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 15 * DAY))
    expect(await myInvites(cora)).toEqual([])
    const late = await act(cora, `/invites/${inv.id}/accept`)
    expect([late.statusCode, late.json().code]).toEqual([409, 'expired'])
    expect((await app.inject({ method: 'GET', url: `${S}/invite-links/${token}`, headers: as(cora) })).json().status).toBe('expired')
    expect((await act(cora, `/invite-links/${token}/accept`)).json().code).toBe('expired')

    const re = await act(owner, `/designs/${d.id}/invites/${inv.id}/resend`)
    expect(re.statusCode).toBe(200)
    expect(re.json().invite.link).toBe(inv.link)
    expect(new Date(re.json().invite.expiresAt).getTime()).toBe(Date.now() + 14 * DAY)
    expect(await myInvites(cora)).toHaveLength(1)
    expect((await act(cora, `/invites/${inv.id}/accept`)).statusCode).toBe(200)
  })

  it('an expired, unanswered invite doesn’t block a new one to the same email', async () => {
    const d = await createDesign(owner)
    await invite(owner, d.id, { email: 'cora@test.dev' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 15 * DAY))
    expect((await invite(owner, d.id, { email: 'cora@test.dev' })).statusCode).toBe(201)
  })

  it('a no-account invite is in nobody’s list, but its link accepts for whoever signs up and opens it', async () => {
    const d = await createDesign(owner, { name: 'Neon cap' })
    const inv = (await invite(owner, d.id, { email: 'newbie@test.dev', role: 'viewer' })).json().invite
    const [row] = await db.select().from(studioDesignInvites)
    expect(row.userId).toBeNull()
    const newbie = await createUser({ email: 'someone-else@test.dev' })
    expect(await myInvites(newbie)).toEqual([])
    const token = await tokenOf(inv.id)
    const look = await app.inject({ method: 'GET', url: `${S}/invite-links/${token}`, headers: as(newbie) })
    expect(look.json()).toEqual({ designId: d.id, designName: 'Neon cap', inviterName: 'Olive Owner', role: 'viewer', status: 'open' })
    const ok = await act(newbie, `/invite-links/${token}/accept`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ designId: d.id, role: 'viewer' })
    expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(newbie) })).json().role).toBe('viewer')
    // A used link shows used, and can't be accepted again by someone else
    const late = await createUser()
    expect((await app.inject({ method: 'GET', url: `${S}/invite-links/${token}`, headers: as(late) })).json().status).toBe('used')
    expect((await act(late, `/invite-links/${token}/accept`)).json().code).toBe('used')
    expect((await app.inject({ method: 'GET', url: `${S}/invite-links/not-a-token`, headers: as(late) })).statusCode).toBe(404)
  })

  it('a trial can’t invite (403) or accept (403)', async () => {
    const d = await createDesign(owner)
    const inv = (await invite(owner, d.id, { email: 'x@test.dev' })).json().invite
    const token = await tokenOf(inv.id)
    const trial = await makeTrial()
    const [t] = await db.select().from(users).where(eq(users.isTrial, true))
    const own = await createDesign({ ...t, wallet: null })
    const r1 = await invite(trial, own.id, { email: 'y@test.dev' })
    expect([r1.statusCode, r1.json().error]).toEqual([403, 'account_required'])
    const r2 = await act(trial, `/invite-links/${token}/accept`)
    expect([r2.statusCode, r2.json().error]).toEqual([403, 'account_required'])
    const r3 = await act(trial, `/invites/${inv.id}/accept`)
    expect([r3.statusCode, r3.json().error]).toEqual([403, 'account_required'])
  })

  it('a collaborator can’t invite, cancel or change roles (404)', async () => {
    const d = await createDesign(owner)
    const cora = await createUser()
    const vic = await createUser()
    await db.insert(studioDesignMembers).values([{ designId: d.id, userId: cora.id, role: 'collaborator' }, { designId: d.id, userId: vic.id, role: 'viewer' }])
    const inv = (await invite(owner, d.id, { email: 'x@test.dev' })).json().invite
    expect((await invite(cora, d.id, { email: 'y@test.dev' })).statusCode).toBe(404)
    expect((await act(cora, `/designs/${d.id}/invites/${inv.id}/cancel`)).statusCode).toBe(404)
    expect((await act(cora, `/designs/${d.id}/invites/${inv.id}/resend`)).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: `${S}/designs/${d.id}/members/${vic.id}`, headers: as(cora), payload: { role: 'collaborator' } })).statusCode).toBe(404)
    // ...and can't remove someone else
    expect((await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/members/${vic.id}`, headers: as(cora) })).statusCode).toBe(404)
  })

  it('members_full at the cap, members and open invites counted; and on accept if the cap was reached since', async () => {
    ;(config as any).studioMaxMembers = 2
    const d = await createDesign(owner)
    const cora = await createUser({ email: 'cora@test.dev' })
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: (await createUser()).id, role: 'viewer' })
    const inv = (await invite(owner, d.id, { email: 'cora@test.dev' })).json().invite
    const full = await invite(owner, d.id, { email: 'third@test.dev' })
    expect([full.statusCode, full.json().code]).toEqual([409, 'members_full'])
    // Someone joins by other means meanwhile: the accept is refused
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: (await createUser()).id, role: 'viewer' })
    const late = await act(cora, `/invites/${inv.id}/accept`)
    expect([late.statusCode, late.json().code]).toEqual([409, 'members_full'])
  })

  it('the 51st invite in a UTC day is 429 invite_limit', async () => {
    ;(config as any).studioMaxMembers = 100
    const d = await createDesign(owner)
    const now = new Date()
    await db.insert(studioDesignInvites).values(Array.from({ length: 50 }, (_, i) => ({
      designId: d.id, email: `p${i}@test.dev`, role: 'viewer', token: `t${i}`, invitedBy: owner.id, createdAt: now, expiresAt: new Date(now.getTime() + 14 * DAY),
    })))
    const res = await invite(owner, d.id, { email: 'p51@test.dev' })
    expect([res.statusCode, res.json().code]).toEqual([429, 'invite_limit'])
  })

  it('owner removes a collaborator: 404 for them afterwards, and a member_removed event', async () => {
    const d = await createDesign(owner)
    const cora = await createUser()
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: cora.id, role: 'collaborator' })
    const res = await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/members/${cora.id}`, headers: as(owner) })
    expect(res.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(cora) })).statusCode).toBe(404)
    expect(published).toEqual([{ topic: `studio:${d.id}`, data: { type: 'member_removed', userId: cora.id } }])
    const [m] = await db.select().from(studioDesignMembers)
    expect(m.leftAt).not.toBeNull()
    expect((await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/members/${cora.id}`, headers: as(owner) })).statusCode).toBe(404)
    // The owner can't be removed, nor leave
    const own = await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/members/${owner.id}`, headers: as(owner) })
    expect([own.statusCode, own.json().code]).toEqual([400, 'owner'])
  })

  it('a viewer leaves; re-joining after leaving makes a new membership', async () => {
    const d = await createDesign(owner)
    const vic = await createUser({ email: 'vic@test.dev' })
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: vic.id, role: 'viewer' })
    expect((await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/members/${vic.id}`, headers: as(vic) })).statusCode).toBe(204)
    expect(published.map((p) => p.data)).toEqual([{ type: 'member_removed', userId: vic.id }])
    expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(vic) })).statusCode).toBe(404)
    const inv = (await invite(owner, d.id, { email: 'vic@test.dev' })).json().invite
    expect((await act(vic, `/invites/${inv.id}/accept`)).statusCode).toBe(200)
    const rows = await db.select().from(studioDesignMembers).where(eq(studioDesignMembers.userId, vic.id))
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => !r.leftAt)).toHaveLength(1)
  })

  it('role change collaborator → viewer, then a prompt is 403 viewer', async () => {
    const d = await createDesign(owner)
    const cora = await createUser()
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: cora.id, role: 'collaborator' })
    const bad = await app.inject({ method: 'PATCH', url: `${S}/designs/${d.id}/members/${cora.id}`, headers: as(owner), payload: { role: 'owner' } })
    expect(bad.statusCode).toBe(400)
    const own = await app.inject({ method: 'PATCH', url: `${S}/designs/${d.id}/members/${owner.id}`, headers: as(owner), payload: { role: 'viewer' } })
    expect([own.statusCode, own.json().code]).toEqual([400, 'owner'])
    const res = await app.inject({ method: 'PATCH', url: `${S}/designs/${d.id}/members/${cora.id}`, headers: as(owner), payload: { role: 'viewer' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: cora.id, role: 'viewer' })
    const p = await prompt(cora, d.id)
    expect([p.statusCode, p.json()]).toEqual([403, { error: 'viewer', code: 'viewer' }])
  })

  it('archiving cancels open invites, and an archived design can’t send one', async () => {
    const d = await createDesign(owner)
    const cora = await createUser({ email: 'cora@test.dev' })
    await invite(owner, d.id, { email: 'cora@test.dev' })
    expect((await app.inject({ method: 'PATCH', url: `${S}/designs/${d.id}`, headers: as(owner), payload: { archived: true } })).statusCode).toBe(200)
    expect(await myInvites(cora)).toEqual([])
    const [row] = await db.select().from(studioDesignInvites)
    expect(row.cancelledAt).not.toBeNull()
    const res = await invite(owner, d.id, { email: 'other@test.dev' })
    expect([res.statusCode, res.json().code]).toEqual([409, 'archived'])
  })

  it('a paused account can accept and view, not invite', async () => {
    const d = await createDesign(owner)
    const cora = await createUser({ email: 'cora@test.dev' })
    const inv = (await invite(owner, d.id, { email: 'cora@test.dev' })).json().invite
    await db.insert(studioPauses).values([{ userId: cora.id }, { userId: owner.id }])
    expect((await act(cora, `/invites/${inv.id}/accept`)).statusCode).toBe(200)
    expect((await people(cora, d.id)).statusCode).toBe(200)
    expect((await invite(owner, d.id, { email: 'x@test.dev' })).json().code).toBe('studio_paused')
  })

  it('the invite email goes out only when SMTP is set', async () => {
    const d = await createDesign(owner, { name: 'Neon <cap>' })
    await invite(owner, d.id, { email: 'a@test.dev' })
    expect(sendMail).not.toHaveBeenCalled()
    ;(config as any).smtpHost = 'smtp.test'
    const inv = (await invite(owner, d.id, { email: 'b@test.dev' })).json().invite
    expect(sendMail).toHaveBeenCalledTimes(1)
    const m = sendMail.mock.calls[0][0]
    expect(m.to).toBe('b@test.dev')
    expect(m.subject).toBe('Olive Owner invited you to Neon <cap> on Virvi')
    expect(m.html).toContain(inv.link)
    expect(m.html).toContain('Neon &lt;cap&gt;')
    // Resend mails again, but not within the hour
    const soon = await act(owner, `/designs/${d.id}/invites/${inv.id}/resend`)
    expect([soon.statusCode, soon.json()]).toEqual([429, { error: 'resend_too_soon', code: 'resend_too_soon' }])
    expect(sendMail).toHaveBeenCalledTimes(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 3600_000))
    expect((await act(owner, `/designs/${d.id}/invites/${inv.id}/resend`)).statusCode).toBe(200)
    expect(sendMail).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
    // A failing transport doesn't fail the invite
    sendMail.mockRejectedValueOnce(new Error('smtp down'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await invite(owner, d.id, { email: 'c@test.dev' })).statusCode).toBe(201)
    expect(logged).toHaveBeenCalledWith('[virvi-studio] invite email failed:', expect.any(Error))
    logged.mockRestore()
    expect(await db.select().from(studioDesignInvites).where(and(eq(studioDesignInvites.designId, d.id), eq(studioDesignInvites.email, 'c@test.dev')))).toHaveLength(1)
  })

  // Last: once SMTP is set, email.ts keeps its transport for the rest of the file
  it('resend: at most once an hour, and 3 times in all', async () => {
    ;(config as any).smtpHost = 'smtp.test'
    const d = await createDesign(owner)
    const inv = (await invite(owner, d.id, { email: 'cora@test.dev' })).json().invite
    const resend = () => act(owner, `/designs/${d.id}/invites/${inv.id}/resend`)
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let n = 1; n <= 3; n++) {
      vi.setSystemTime(new Date(Date.now() + 3600_000))
      expect((await resend()).statusCode).toBe(200)
      if (n === 3) break
      const again = await resend()
      expect([again.statusCode, again.json().code]).toEqual([429, 'resend_too_soon'])
    }
    expect(sendMail).toHaveBeenCalledTimes(4)
    vi.setSystemTime(new Date(Date.now() + 3600_000))
    const fourth = await resend()
    expect([fourth.statusCode, fourth.json()]).toEqual([429, { error: 'resend_limit', code: 'resend_limit' }])
    expect(sendMail).toHaveBeenCalledTimes(4)
    const [row] = await db.select().from(studioDesignInvites)
    expect(row.resendCount).toBe(3)
  })
})
