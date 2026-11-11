import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioRatings, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign } from './helpers/studio.js'

describe('the default agent per design kind', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let admin: TestUser
  let owner: TestUser
  const prev = config.studioEnabled
  beforeAll(() => { (config as any).studioEnabled = true })
  afterAll(() => { (config as any).studioEnabled = prev })
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    admin = await createUser({ role: 'admin' })
    owner = await createUser()
  })
  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const set = (kind: string, agent: unknown, u = admin) => app.inject({ method: 'PUT', url: `/api/admin/studio/defaults/${kind}`, headers: as(u), payload: { agent } as any })

  it('an admin sets it by hand; new-design pages (trials too) read it; existing designs keep theirs', async () => {
    const before = await createDesign(owner, { kind: 'emote', agent: 'codex' })
    expect((await app.inject({ method: 'GET', url: '/api/studio/defaults', headers: as(owner) })).json())
      .toEqual({ agents: { wearable: null, emote: null, scene: null } })
    const res = await set('emote', 'claude')
    expect(res.statusCode).toBe(200)
    expect(res.json().defaults.emote).toMatchObject({ agent: 'claude', model: config.studioClaudeModel, updatedBy: admin.id })
    const t = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    const { accessToken } = issueTrialSession(app, { id: t.id, displayName: t.displayName, role: 'creator', trialLastActiveAt: new Date() })
    expect((await app.inject({ method: 'GET', url: '/api/studio/defaults', headers: { authorization: `Bearer ${accessToken}` } })).json())
      .toEqual({ agents: { wearable: null, emote: 'claude', scene: null } })
    const [kept] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, before.id))
    expect(kept.agent).toBe('codex')
    expect((await set('emote', 'gpt')).statusCode).toBe(400)
    expect((await set('emote', 'grok')).statusCode).toBe(400) // retired: new designs aren't offered it
    expect((await set('hat', 'claude')).statusCode).toBe(404)
    expect((await set('emote', 'codex', owner)).statusCode).toBe(403)
  })

  it('shows the last four weeks of 👍 rates per kind beside it, and never switches on its own', async () => {
    const d = await createDesign(owner)
    for (let i = 0; i < 20; i++) {
      const rev = await addRevision(d, 'hat')
      await db.insert(studioRatings).values({ jobId: rev.jobId, designId: d.id, userId: owner.id, rating: i < 15 ? 'up' : 'down', kind: 'wearable', agent: 'codex', model: 'gpt-x' })
    }
    const res = await app.inject({ method: 'GET', url: '/api/admin/studio/defaults', headers: as(admin) })
    const body = res.json()
    expect(body).toMatchObject({ ratesDays: 28, minSample: 20, agents: ['claude', 'codex'], defaults: { wearable: null } })
    expect(body.rates.find((k: any) => k.kind === 'wearable').leader).toEqual({ agent: 'codex', model: 'gpt-x', rate: 0.75 })
    expect((await app.inject({ method: 'GET', url: '/api/studio/defaults', headers: as(owner) })).json().agents.wearable).toBeNull()
  })
})
