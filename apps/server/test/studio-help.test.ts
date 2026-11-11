import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { notifications, studioDesignMembers, studioHelpRequests, studioJobs } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { discordMessage, HELP_PER_DAY, setHelpPost } from '../src/studio/help.js'
import { flushNotifications } from '../src/notifications/notifications.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, fakeFly } from './helpers/studio.js'

const S = '/api/studio'
const HOOK = 'https://discord.test/api/webhooks/1/secret'

describe('Help: asking Virvi support to step in on a design', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let admin: TestUser
  let owner: TestUser
  let posts: { url: string; body: any }[]
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, hook: config.studioHelpDiscordWebhookUrl }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).studioHelpDiscordWebhookUrl = prev.hook
    setStudioStore(null)
    setMachineDeps(null)
    setHelpPost(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    ;(config as any).studioHelpDiscordWebhookUrl = HOOK
    posts = []
    setHelpPost(async (url, body) => { posts.push({ url, body }) })
    app = await testApp()
    admin = await createUser({ role: 'admin', name: 'Ada Admin' })
    owner = await createUser({ name: 'Olive Owner' })
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const ask = (u: TestUser, id: string, text: unknown = 'Can I resell the GLBs after editing them?') =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/help`, headers: as(u), payload: { text } as any })
  const detail = async (u: TestUser, id: string) => (await app.inject({ method: 'GET', url: `${S}/designs/${id}`, headers: as(u) })).json()
  const queue = async () => (await app.inject({ method: 'GET', url: '/api/admin/studio/help', headers: as(admin) })).json().requests
  const bell = async (u: TestUser) => db.select().from(notifications).where(and(eq(notifications.userId, u.id), eq(notifications.kind, 'studio_help')))

  it('shows in the conversation, waits in the queue, rings support and posts to Discord, and starts nothing', async () => {
    const d = await createDesign(owner, { name: 'Neon Cap' } as any)
    const res = await ask(owner, d.id)
    expect(res.statusCode).toBe(201)
    await flushNotifications()
    const view = await detail(owner, d.id)
    expect(view.messages).toMatchObject([{ role: 'help', text: 'Can I resell the GLBs after editing them?', support: false, sender: { userId: owner.id } }])
    expect(view.help).toMatchObject({ id: res.json().help.id })
    expect(await db.select().from(studioJobs)).toHaveLength(0)
    expect(await queue()).toMatchObject([{ designId: d.id, text: 'Can I resell the GLBs after editing them?', displayName: 'Olive Owner' }])
    expect(await bell(admin)).toHaveLength(1)
    expect(await bell(owner)).toHaveLength(0)
    // The admin's bell lists it as reachable, though support isn't on the design
    const list = (await app.inject({ method: 'GET', url: '/api/notifications', headers: as(admin) })).json()
    expect(list.items).toMatchObject([{ kind: 'studio_help', gone: false }])
    // Discord hears who and where, never their words
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe(HOOK)
    expect(posts[0].body.content).toContain('Olive Owner')
    expect(posts[0].body.content).toContain(`/studio/${d.id}`)
    expect(JSON.stringify(posts[0].body)).not.toContain('resell')
    expect(posts[0].body.allowed_mentions).toEqual({ parse: [] })
  })

  it('one open request per design', async () => {
    const d = await createDesign(owner)
    expect((await ask(owner, d.id)).statusCode).toBe(201)
    const again = await ask(owner, d.id)
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('help_open')
  })

  it("support's note resolves it, and support's bell for it is read", async () => {
    const d = await createDesign(owner)
    await ask(owner, d.id)
    await flushNotifications()
    const res = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/support-notes`, headers: as(admin), payload: { text: 'Yes: full rights, resale OK.' } })
    expect(res.statusCode).toBe(201)
    expect((await detail(owner, d.id)).help).toBeNull()
    expect(await queue()).toEqual([])
    expect((await bell(admin))[0].readAt).not.toBeNull()
    const [r] = await db.select().from(studioHelpRequests)
    expect(r.resolvedBy).toBe(admin.id)
    // Asking again opens a new one
    expect((await ask(owner, d.id)).statusCode).toBe(201)
  })

  it("support's prompt resolves it too", async () => {
    const d = await createDesign(owner)
    await ask(owner, d.id)
    const res = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompts`, headers: as(admin), payload: { text: 'make the brim wider' } })
    expect(res.statusCode).toBe(202)
    expect((await detail(owner, d.id)).help).toBeNull()
  })

  it('support can mark it resolved in the queue; only support', async () => {
    const d = await createDesign(owner)
    const id = (await ask(owner, d.id)).json().help.id
    expect((await app.inject({ method: 'GET', url: '/api/admin/studio/help', headers: as(owner) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/admin/studio/help/${id}/resolve`, headers: as(owner) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/admin/studio/help/${id}/resolve`, headers: as(admin) })).statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: `/api/admin/studio/help/${id}/resolve`, headers: as(admin) })).statusCode).toBe(404)
    expect(await queue()).toEqual([])
  })

  it('a collaborator may ask; a viewer and a stranger may not', async () => {
    const d = await createDesign(owner)
    const editor = await createUser({ name: 'Cole Collab' })
    const watcher = await createUser({ name: 'Vera Viewer' })
    const stranger = await createUser()
    await db.insert(studioDesignMembers).values([
      { designId: d.id, userId: editor.id, role: 'collaborator', invitedBy: owner.id },
      { designId: d.id, userId: watcher.id, role: 'viewer', invitedBy: owner.id },
    ])
    expect((await ask(stranger, d.id)).statusCode).toBe(404)
    expect((await ask(watcher, d.id)).statusCode).toBe(403)
    expect((await ask(editor, d.id)).statusCode).toBe(201)
    expect((await queue())[0].displayName).toBe('Cole Collab')
  })

  it('needs words, and has a daily limit per account', async () => {
    const d = await createDesign(owner)
    expect((await ask(owner, d.id, '   ')).statusCode).toBe(400)
    expect((await ask(owner, d.id, 'x'.repeat(2001))).statusCode).toBe(400)
    for (let i = 0; i < HELP_PER_DAY; i++) {
      const e = await createDesign(owner)
      expect((await ask(owner, e.id)).statusCode).toBe(201)
    }
    const over = await ask(owner, d.id)
    expect(over.statusCode).toBe(429)
    expect(over.json().code).toBe('help_limit')
  })

  it('without a webhook, or when Discord fails, the request still goes through', async () => {
    ;(config as any).studioHelpDiscordWebhookUrl = ''
    const d = await createDesign(owner)
    expect((await ask(owner, d.id)).statusCode).toBe(201)
    await flushNotifications()
    expect(posts).toHaveLength(0)
    ;(config as any).studioHelpDiscordWebhookUrl = HOOK
    setHelpPost(async () => { throw new Error('Discord answered 500') })
    const e = await createDesign(owner)
    expect((await ask(owner, e.id)).statusCode).toBe(201)
    await flushNotifications()
    expect(await bell(admin)).toHaveLength(2)
  })

  it("the Discord message can't mention anyone or break its formatting", () => {
    const m = discordMessage({ name: '@everyone **[click](http://x)**', kind: 'wearable', who: '<@123> Bob', link: 'https://virvi.io/studio/x' })
    expect(m.content).not.toContain('@everyone')
    expect(m.content).not.toContain('<@123>')
    expect(m.content).not.toContain('](')
    expect(m.allowed_mentions).toEqual({ parse: [] })
  })
})
