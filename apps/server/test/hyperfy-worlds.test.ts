import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { HYPERFY_FEED } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import bcrypt from 'bcryptjs'
import { hyperfyWorlds, subscriptions, sceneCollaborators, scenes, users, userAuthMethods, organizations } from '../src/db/schema.js'
import { worldDbName } from '../src/hyperfy/worlds-db.js'
import type { HostingDeps } from '../src/hyperfy/hosting.js'
import { config } from '../src/config.js'
import { findWorldByKey } from '../src/hyperfy/worlds.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

// Route calls go to the real hosting module, with Fly, the worlds DB, the bucket and the health check faked.
const fake = vi.hoisted(() => ({ deps: {} as Partial<HostingDeps>, onSwitch: undefined as undefined | (() => Promise<void>) }))
vi.mock('../src/hyperfy/hosting.js', async (orig) => {
  const m = await orig<typeof import('../src/hyperfy/hosting.js')>()
  return {
    ...m,
    createHostedWorld: (i: Parameters<typeof m.createHostedWorld>[0]) => m.createHostedWorld(i, fake.deps),
    destroyHostedWorld: (id: string) => m.destroyHostedWorld(id, fake.deps),
    hostedWorldsBlockingDelete: (scope: Parameters<typeof m.hostedWorldsBlockingDelete>[0]) => m.hostedWorldsBlockingDelete(scope, fake.deps),
    switchHostedWorldScene: async (id: string, sceneId: string) => {
      await m.switchHostedWorldScene(id, sceneId)
      await fake.onSwitch?.()
    },
    rotateHostedWorldKey: (id: string) => m.rotateHostedWorldKey(id, fake.deps),
    restoreHostedWorld: (id: string) => m.restoreHostedWorld(id, fake.deps),
  }
})

const HOSTING_CONFIG = {
  hyperfyInfraProvider: 'fly',
  flyApiToken: 'FlyV1 fm2_token_s3cr3t',
  flyWorldsOrg: 'vlm-worlds',
  hyperfyImage: 'registry.fly.io/vlm-hyperfy-image:abc123',
  hyperfyWorldsDatabaseUrl: 'postgres://admin:adminpw@worlds-db.internal/worlds',
  hyperfyWorldsDbUrlTemplate: 'postgres://{user}:{password}@worlds-db.flycast:5432/worlds',
  hyperfyAssetsS3Uri: 's3://r2key:r2s3cr3t@acct.r2.cloudflarestorage.com/virvi-hyperfy',
  hyperfyAssetsBaseUrl: 'https://worlds-cdn.virvi.io',
  hyperfyRouterDomain: 'worlds.virvi.io',
  hyperfySecretKey: 'ab'.repeat(32),
  publicUrl: 'https://api.virvi.io',
}

function installFakes(opts: { failStart?: boolean; failUpdate?: boolean; failDeleteApp?: boolean } = {}) {
  const started: string[] = []
  const destroyed: string[] = []
  const machines = new Map<string, { id: string; env: Record<string, string> }>()
  fake.deps = {
    fly: {
      async createApp() {},
      async deleteApp(name: string) {
        if (opts.failDeleteApp) throw new Error('fly down')
        destroyed.push(`deleteApp ${name}`)
        machines.delete(name)
      },
      async allocatePublicIps() {},
      async allocatePrivateIp() {},
      async createMachine(app: string, m: any) { machines.set(app, { id: `m-${app}`, env: { ...m.env } }); return { id: `m-${app}` } },
      async updateMachine(app: string, id: string, m: any) {
        if (opts.failUpdate) throw new Error('fly down')
        machines.set(app, { id, env: { ...m.env } })
      },
      async listMachines(app: string) { const m = machines.get(app); return m ? [{ id: m.id, state: 'stopped' }] : [{ id: `m-${app}`, state: 'stopped' }] },
      async getMachineEnv(app: string) { return { ...(machines.get(app)?.env ?? {}) } },
      async startMachine(app: string, id: string) { if (opts.failStart) throw new Error('fly down'); started.push(`${app}/${id}`) },
    },
    async createWorldDatabase(slug: string) { return { dbUri: 'postgres://x', schema: worldDbName(slug) } },
    async dropWorldDatabase(slug: string) { destroyed.push(`dropWorldDatabase ${slug}`) },
    async deleteWorldFiles(slug: string) { destroyed.push(`deleteWorldFiles ${slug}`); return 0 },
    fetch: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    sleep: async () => { await new Promise((r) => setImmediate(r)) },
    log: { info() {}, warn() {}, error() {} },
  }
  return { started, destroyed }
}

describe('connect-your-own Hyperfy world', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let sceneId: string
  const mode = config.mode
  const unlocked = config.allFeaturesUnlocked
  const saved = { provider: config.hyperfyInfraProvider, token: config.flyApiToken }

  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    owner = await createUser()
    sceneId = (await createScene(owner, 'World')).scene.id
  })
  afterEach(async () => {
    ;(config as any).mode = mode
    config.allFeaturesUnlocked = unlocked
    ;(config as any).hyperfyInfraProvider = saved.provider
    ;(config as any).flyApiToken = saved.token
    await app.close()
  })

  const call = (user: TestUser, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: payload as any })
  const connect = (user = owner, name = 'My world') => call(user, 'POST', '/api/hyperfy/worlds', { sceneId, name })

  it('creating a world returns a virviw_ key once and stores only its hash', async () => {
    const res = await connect()
    expect(res.statusCode).toBe(201)
    const { world, key } = res.json()
    expect(key).toMatch(/^virviw_[0-9a-f]{64}$/)
    expect(world).toMatchObject({ sceneId, name: 'My world', kind: 'self', lastSeenAt: null, keyPrefix: key.slice(0, 12) })
    expect(JSON.stringify(world)).not.toContain(key)
    const [row] = await db.select().from(hyperfyWorlds)
    expect(row.keyHash).toBe(createHash('sha256').update(key).digest('hex'))
    expect(row.keyPrefix).toBe(key.slice(0, 12))
    expect(row.ownerId).toBe(owner.id)
    expect(JSON.stringify(row)).not.toContain(key)
  })

  it('findWorldByKey finds it, and fails after rotate-key', async () => {
    const { world, key } = (await connect()).json()
    expect((await findWorldByKey(key))?.id).toBe(world.id)
    expect(await findWorldByKey('virviw_nope')).toBeNull()
    const rotated = await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/rotate-key`)
    expect(rotated.statusCode).toBe(200)
    const next = rotated.json().key
    expect(next).toMatch(new RegExp(`^${HYPERFY_FEED.keyPrefix}[0-9a-f]{64}$`))
    expect(next).not.toBe(key)
    expect(rotated.json().world.id).toBe(world.id)
    expect(rotated.json().world.keyPrefix).toBe(next.slice(0, 12))
    expect(rotated.json().world.keyPrefix).not.toBe(world.keyPrefix)
    expect(await findWorldByKey(key)).toBeNull()
    expect((await findWorldByKey(next))?.id).toBe(world.id)
  })

  it('listing never includes the key', async () => {
    const { key } = (await connect()).json()
    const res = await call(owner, 'GET', `/api/hyperfy/worlds?sceneId=${sceneId}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().worlds).toHaveLength(1)
    expect(res.body).not.toContain(key)
    expect(res.body).not.toContain('keyHash')
    expect(res.json().worlds[0].key).toBeUndefined()
    expect(res.json().worlds[0].keyPrefix).toBe(key.slice(0, 12))
  })

  it("another user can't list, rotate or delete it", async () => {
    const other = await createUser()
    const { world, key } = (await connect()).json()
    const list = await call(other, 'GET', `/api/hyperfy/worlds?sceneId=${sceneId}`)
    expect(list.statusCode).toBe(404)
    expect((await call(other, 'POST', `/api/hyperfy/worlds/${world.id}/rotate-key`)).statusCode).toBe(404)
    expect((await call(other, 'DELETE', `/api/hyperfy/worlds/${world.id}`)).statusCode).toBe(404)
    expect((await connect(other)).statusCode).toBe(404)
    expect((await findWorldByKey(key))?.id).toBe(world.id)
    expect((await call(owner, 'DELETE', `/api/hyperfy/worlds/${world.id}`)).json()).toEqual({ deleted: true })
    expect(await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, world.id))).toHaveLength(0)
  })

  it('connecting works while Hyperfy hosting is unavailable (cloud mode)', async () => {
    ;(config as any).mode = 'cloud'
    ;(config as any).hyperfyInfraProvider = undefined
    ;(config as any).flyApiToken = undefined
    const res = await connect()
    expect(res.statusCode).toBe(201)
    expect(res.json().key).toMatch(/^virviw_/)
  })

  it('the free plan can connect a Hyperfy world (no deployment feature gate)', async () => {
    config.allFeaturesUnlocked = false
    const res = await connect()
    expect(res.statusCode).toBe(201)
    expect(await db.select().from(hyperfyWorlds)).toHaveLength(1)
  })

  it('a free-plan owner can still list, rotate and delete a world', async () => {
    const { world } = (await connect()).json()
    config.allFeaturesUnlocked = false
    const list = await call(owner, 'GET', `/api/hyperfy/worlds?sceneId=${sceneId}`)
    expect(list.statusCode).toBe(200)
    expect(list.json().worlds.map((w: { id: string }) => w.id)).toEqual([world.id])
    const rotated = await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/rotate-key`)
    expect(rotated.statusCode).toBe(200)
    expect(rotated.json().key).toMatch(/^virviw_/)
    expect((await call(owner, 'DELETE', `/api/hyperfy/worlds/${world.id}`)).json()).toEqual({ deleted: true })
    expect(await db.select().from(hyperfyWorlds)).toHaveLength(0)
  })

  it('validates the body', async () => {
    expect((await call(owner, 'POST', '/api/hyperfy/worlds', { sceneId, name: '  ' })).statusCode).toBe(400)
    expect((await call(owner, 'POST', '/api/hyperfy/worlds', { sceneId: 'nope', name: 'x' })).statusCode).toBe(404)
    expect((await call(owner, 'GET', '/api/hyperfy/worlds')).statusCode).toBe(400)
  })

  it('app.hyp downloads the built app', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hyperfy/app.hyp' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toBe('attachment; filename="virvi.hyp"')
    const body = res.rawPayload
    const headerLen = body.readUInt32LE(0)
    expect(headerLen).toBeGreaterThan(0)
    expect(headerLen).toBeLessThan(body.length)
    const header = JSON.parse(body.subarray(4, 4 + headerLen).toString('utf8'))
    expect(header.blueprint).toBeTruthy()
    expect(Array.isArray(header.assets)).toBe(true)
  })
})


describe('hosted Hyperfy world routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let sceneId: string
  const saved: Record<string, unknown> = {}

  const call = (user: TestUser, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: payload as any })
  const create = (user = owner, extra: Record<string, unknown> = {}, scene = sceneId) =>
    call(user, 'POST', '/api/hyperfy/worlds', { sceneId: scene, name: 'Moon Base', kind: 'hosted', ...extra })
  const row = async (id: string) => (await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, id)))[0]
  const settled = async (id: string) => {
    const { hostedWorldSettled } = await vi.importActual<typeof import('../src/hyperfy/hosting.js')>('../src/hyperfy/hosting.js')
    await hostedWorldSettled(id)
  }
  const makeEnded = (id: string, purgeAfter: Date) =>
    db.update(hyperfyWorlds).set({ status: 'ended', endedAt: new Date(), endsAt: new Date(Date.now() - 1000), purgeAfter }).where(eq(hyperfyWorlds.id, id))

  beforeEach(async () => {
    await resetDb()
    for (const [k, v] of Object.entries({ ...HOSTING_CONFIG, allFeaturesUnlocked: false })) {
      saved[k] = (config as any)[k]
      ;(config as any)[k] = v
    }
    app = await testApp()
    owner = await createUser()
    sceneId = (await createScene(owner, 'World')).scene.id
    await db.insert(subscriptions).values({ userId: owner.id, tier: 'creator' })
    installFakes()
  })
  afterEach(async () => {
    fake.onSwitch = undefined
    for (const [k, v] of Object.entries(saved)) (config as any)[k] = v
    await app.close()
  })

  it('hosted create is 503 when hosting is unavailable and self-run still works', async () => {
    ;(config as any).hyperfyInfraProvider = undefined
    const res = await create()
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('hyperfy_hosting_unavailable')
    expect(await db.select().from(hyperfyWorlds)).toHaveLength(0)
    const self = await call(owner, 'POST', '/api/hyperfy/worlds', { sceneId, name: 'Mine' })
    expect(self.statusCode).toBe(201)
    expect(self.json().key).toMatch(/^virviw_/)
  })

  it('hosted create returns 202 with the admin code once; list never has it', async () => {
    const res = await create()
    expect(res.statusCode).toBe(202)
    const { world, adminCode } = res.json()
    expect(adminCode).toMatch(/^[0-9a-f]{24}$/)
    expect(world).toMatchObject({ kind: 'hosted', status: 'provisioning', sceneId, endsAt: null })
    await settled(world.id)
    const list = await call(owner, 'GET', `/api/hyperfy/worlds?sceneId=${sceneId}`)
    expect(list.statusCode).toBe(200)
    expect(list.json().worlds[0]).toMatchObject({ id: world.id, status: 'running' })
    expect(list.body).not.toContain(adminCode)
    expect(list.body).not.toContain('adminCode')
    const again = await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/admin-code`)
    expect(again.json()).toEqual({ adminCode })
  })

  it('world_limit_reached carries used and limit', async () => {
    const first = (await create()).json().world
    await settled(first.id)
    const res = await create(owner, { name: 'Second' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: 'world_limit_reached', used: 1, limit: 1 })
    const free = await createUser()
    const freeScene = (await createScene(free, 'F')).scene.id
    const freeFirst = await create(free, {}, freeScene)
    expect(freeFirst.statusCode).toBe(202) // the free plan hosts one world (accepted, provisioning)
  })

  it('GET /api/hyperfy/slots reports used, limit and availability (null when unlimited)', async () => {
    const first = (await create()).json().world
    await settled(first.id)
    expect((await call(owner, 'GET', '/api/hyperfy/slots')).json()).toEqual({ used: 1, limit: 1, hostingAvailable: true })
    ;(config as any).allFeaturesUnlocked = true
    ;(config as any).hyperfyInfraProvider = undefined
    expect((await call(owner, 'GET', '/api/hyperfy/slots')).json()).toEqual({ used: 1, limit: null, hostingAvailable: false })
    ;(config as any).allFeaturesUnlocked = false
    const ent = await createUser()
    await db.insert(subscriptions).values({ userId: ent.id, tier: 'enterprise' })
    expect((await call(ent, 'GET', '/api/hyperfy/slots')).json()).toMatchObject({ used: 0, limit: null })
  })

  it('endsAt in the past is 400; clearing endsAt makes it permanent', async () => {
    expect((await create(owner, { endsAt: new Date(Date.now() - 60_000).toISOString() })).statusCode).toBe(400)
    expect((await create(owner, { endsAt: 'soon' })).statusCode).toBe(400)
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const { world } = (await create(owner, { endsAt: future })).json()
    expect(world.endsAt).toBe(future)
    await settled(world.id)
    const past = await call(owner, 'PATCH', `/api/hyperfy/worlds/${world.id}`, { endsAt: new Date(Date.now() - 1000).toISOString() })
    expect(past.statusCode).toBe(400)
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString()
    expect((await call(owner, 'PATCH', `/api/hyperfy/worlds/${world.id}`, { endsAt: later })).json().world.endsAt).toBe(later)
    const cleared = await call(owner, 'PATCH', `/api/hyperfy/worlds/${world.id}`, { endsAt: null })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().world.endsAt).toBeNull()
    expect((await row(world.id)).endsAt).toBeNull()
    expect((await call(owner, 'PATCH', `/api/hyperfy/worlds/${world.id}`, {})).statusCode).toBe(400)
  })

  it('PATCH endsAt on a self-run world is 400 not_hosted; an ended world is 409 already_ended', async () => {
    const self = (await call(owner, 'POST', '/api/hyperfy/worlds', { sceneId, name: 'Mine' })).json().world
    const res = await call(owner, 'PATCH', `/api/hyperfy/worlds/${self.id}`, { endsAt: null })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('not_hosted')
    const { world } = (await create()).json()
    await settled(world.id)
    await makeEnded(world.id, new Date(Date.now() + 86_400_000))
    const ended = await call(owner, 'PATCH', `/api/hyperfy/worlds/${world.id}`, { endsAt: null })
    expect(ended.statusCode).toBe(409)
    expect(ended.json().error).toBe('already_ended')
  })

  it('PATCH sceneId switches to another scene the caller has full access to, and 404s otherwise', async () => {
    const { world } = (await create()).json()
    await settled(world.id)
    const second = (await createScene(owner, 'Second')).scene.id
    const res = await call(owner, 'PATCH', `/api/hyperfy/worlds/${world.id}`, { sceneId: second })
    expect(res.statusCode).toBe(200)
    expect((await row(world.id)).sceneId).toBe(second)
    const stranger = await createUser()
    const theirs = (await createScene(stranger, 'Theirs')).scene.id
    expect((await call(owner, 'PATCH', `/api/hyperfy/worlds/${world.id}`, { sceneId: theirs })).statusCode).toBe(404)
    expect((await row(world.id)).sceneId).toBe(second)
  })

  it('restore within 30 days with a free slot restarts it; without a slot is 403', async () => {
    const { started } = installFakes()
    const { world } = (await create()).json()
    await settled(world.id)
    await makeEnded(world.id, new Date(Date.now() + 86_400_000))
    const res = await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/restore`)
    expect(res.statusCode).toBe(200)
    expect(res.json().world).toMatchObject({ status: 'running', endsAt: null, endedAt: null, purgeAfter: null })
    expect(started).toEqual([`vlm-w-${(await row(world.id)).slug}/m-vlm-w-${(await row(world.id)).slug}`])

    // The slot is taken again by the restored world, so a second ended world can't come back.
    const other = await db
      .insert(hyperfyWorlds)
      .values({ sceneId, ownerId: owner.id, name: 'Old', kind: 'hosted', keyHash: 'old-hash', keyPrefix: 'virviw_old', slug: 'old-world', flyApp: 'vlm-w-old-world', address: 'x', status: 'ended', endedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000) })
      .returning()
    const full = await call(owner, 'POST', `/api/hyperfy/worlds/${other[0].id}/restore`)
    expect(full.statusCode).toBe(403)
    expect(full.json()).toMatchObject({ error: 'world_limit_reached', used: 1, limit: 1 })
    expect((await row(other[0].id)).status).toBe('ended')
  })

  it('restore is 409 not_restorable when running, past retention or self-run, 503 without hosting, and reverts if machines will not start', async () => {
    const { world } = (await create()).json()
    await settled(world.id)
    expect((await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/restore`)).json().error).toBe('not_restorable')
    await makeEnded(world.id, new Date(Date.now() - 1000))
    const late = await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/restore`)
    expect(late.statusCode).toBe(409)
    expect(late.json().error).toBe('not_restorable')
    const self = (await call(owner, 'POST', '/api/hyperfy/worlds', { sceneId, name: 'Mine' })).json().world
    expect((await call(owner, 'POST', `/api/hyperfy/worlds/${self.id}/restore`)).statusCode).toBe(409)

    await makeEnded(world.id, new Date(Date.now() + 86_400_000))
    installFakes({ failStart: true })
    const failed = await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/restore`)
    expect(failed.statusCode).toBe(502)
    expect((await row(world.id)).status).toBe('ended')
    ;(config as any).hyperfyInfraProvider = undefined
    expect((await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/restore`)).statusCode).toBe(503)
  })

  it('rotate-key on a hosted world returns the new key; a failed machine update is 502 with the message', async () => {
    const { world } = (await create()).json()
    await settled(world.id)
    const ok = await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/rotate-key`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().key).toMatch(/^virviw_/)
    installFakes({ failUpdate: true })
    const bad = await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/rotate-key`)
    expect(bad.statusCode).toBe(502)
    expect(bad.json().message).toMatch(/rotate the key again/)
    expect(bad.body).not.toContain('fly down')
  })

  it('delete on a hosted world destroys it', async () => {
    const { destroyed } = installFakes()
    const { world } = (await create()).json()
    await settled(world.id)
    const { slug } = await row(world.id)
    expect((await call(owner, 'DELETE', `/api/hyperfy/worlds/${world.id}`)).json()).toEqual({ deleted: true })
    expect(await row(world.id)).toBeUndefined()
    expect(destroyed).toEqual([`deleteApp vlm-w-${slug}`, `dropWorldDatabase ${slug}`, `deleteWorldFiles ${slug}`])
  })

  it('PATCH with endsAt is 409 already_ended, and writes nothing, if the sweep ends the world between the check and the write', async () => {
    const { world } = (await create()).json()
    await settled(world.id)
    const second = (await createScene(owner, 'Second')).scene.id
    fake.onSwitch = () => makeEnded(world.id, new Date(Date.now() + 86_400_000)).then(() => undefined)
    const res = await call(owner, 'PATCH', `/api/hyperfy/worlds/${world.id}`, { sceneId: second, endsAt: new Date(Date.now() + 86_400_000).toISOString() })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('already_ended')
    const after = await row(world.id)
    expect(after.status).toBe('ended')
    expect(after.endsAt!.getTime()).toBeLessThan(Date.now())
  })

  it('a partial-access collaborator gets 404 on admin-code, and cannot PATCH a scene they only partly access', async () => {
    const { world } = (await create()).json()
    await settled(world.id)
    const editor = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId, userId: editor.id, role: 'editor' })
    expect((await call(editor, 'POST', `/api/hyperfy/worlds/${world.id}/admin-code`)).statusCode).toBe(404)
    expect((await call(editor, 'PATCH', `/api/hyperfy/worlds/${world.id}`, { endsAt: null })).statusCode).toBe(404)

    const stranger = await createUser()
    const partial = (await createScene(stranger, 'Partial')).scene.id
    await db.insert(sceneCollaborators).values({ sceneId: partial, userId: owner.id, role: 'editor' })
    const res = await call(owner, 'PATCH', `/api/hyperfy/worlds/${world.id}`, { sceneId: partial })
    expect(res.statusCode).toBe(404)
    expect((await row(world.id)).sceneId).toBe(sceneId)
  })

  it('PATCH name renames a hosted world and leaves its slug, address and Fly app alone', async () => {
    const { world } = (await create()).json()
    await settled(world.id)
    const before = await row(world.id)
    const res = await call(owner, 'PATCH', `/api/hyperfy/worlds/${world.id}`, { name: '  Moon Colony  ' })
    expect(res.statusCode).toBe(200)
    expect(res.json().world).toMatchObject({ id: world.id, name: 'Moon Colony', address: before.address })
    const after = await row(world.id)
    expect(after.name).toBe('Moon Colony')
    expect({ slug: after.slug, address: after.address, flyApp: after.flyApp, keyHash: after.keyHash, status: after.status })
      .toEqual({ slug: before.slug, address: before.address, flyApp: before.flyApp, keyHash: before.keyHash, status: before.status })
  })

  it('PATCH name: blank or over 100 characters is 400 and writes nothing; not the scene owner is 404', async () => {
    const self = (await call(owner, 'POST', '/api/hyperfy/worlds', { sceneId, name: 'Mine' })).json().world
    const url = `/api/hyperfy/worlds/${self.id}`
    for (const bad of ['', '   ', 'x'.repeat(101), 5, null]) {
      expect((await call(owner, 'PATCH', url, { name: bad })).statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect((await call(owner, 'PATCH', url, { name: 'x'.repeat(100) })).statusCode).toBe(200)
    // Hyperfy world routes need full access to the scene: an editor collaborator or a stranger gets 404, as on every other :id route.
    const editor = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId, userId: editor.id, role: 'editor' })
    const stranger = await createUser()
    for (const u of [editor, stranger]) expect((await call(u, 'PATCH', url, { name: 'Hijacked' })).statusCode).toBe(404)
    expect((await row(self.id)).name).toBe('x'.repeat(100))
  })

  it('another user gets 404 on every :id route', async () => {
    const { world } = (await create()).json()
    await settled(world.id)
    const other = await createUser()
    const id = `/api/hyperfy/worlds/${world.id}`
    for (const [method, url, body] of [
      ['PATCH', id, { endsAt: null }],
      ['POST', `${id}/restore`],
      ['POST', `${id}/admin-code`],
      ['POST', `${id}/rotate-key`],
      ['DELETE', id],
    ] as const) {
      expect((await call(other, method, url, body)).statusCode, `${method} ${url}`).toBe(404)
    }
    expect(await row(world.id)).toBeDefined()
  })

  it('GET /api/deploy/platforms still reports hyperfy hosting availability', async () => {
    const on = await call(owner, 'GET', '/api/deploy/platforms')
    expect(on.statusCode).toBe(200)
    expect(on.json().platforms.hyperfy).toBe(true)
    ;(config as any).hyperfyInfraProvider = undefined
    expect((await call(owner, 'GET', '/api/deploy/platforms')).json().platforms.hyperfy).toBe(false)
  })
  describe('deleting what a hosted world belongs to destroys the world first', () => {
    const hostedRunning = async (scene = sceneId) => {
      const { world } = (await create(owner, {}, scene)).json()
      await settled(world.id)
      return row(world.id)
    }
    const destroyedAll = (slug: string) => [`deleteApp vlm-w-${slug}`, `dropWorldDatabase ${slug}`, `deleteWorldFiles ${slug}`]
    const sceneRow = async (id: string) => (await db.select().from(scenes).where(eq(scenes.id, id)))[0]
    const userRow = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]

    it("deleting a scene with a running hosted world removes the world's Fly app, database and files, then the scene", async () => {
      const w = await hostedRunning()
      const { destroyed } = installFakes()
      const res = await call(owner, 'DELETE', `/api/scenes/${sceneId}`)
      expect(res.statusCode).toBe(204)
      expect(destroyed).toEqual(destroyedAll(w.slug!))
      expect(await sceneRow(sceneId)).toBeUndefined()
      expect(await row(w.id)).toBeUndefined()
    })

    it('a failing destroy blocks the scene delete with 409 hosted_world_destroy_failed, and nothing is deleted', async () => {
      const w = await hostedRunning()
      const self = (await call(owner, 'POST', '/api/hyperfy/worlds', { sceneId, name: 'Mine' })).json().world
      installFakes({ failDeleteApp: true })
      const res = await call(owner, 'DELETE', `/api/scenes/${sceneId}`)
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('hosted_world_destroy_failed')
      expect(res.body).not.toContain('fly down')
      expect(await sceneRow(sceneId)).toBeDefined()
      expect(await row(w.id)).toBeDefined()
      expect(await row(self.id)).toBeDefined()
      // Retrying once Fly answers again works.
      installFakes()
      expect((await call(owner, 'DELETE', `/api/scenes/${sceneId}`)).statusCode).toBe(204)
    })

    it('deleting the account destroys hosted worlds the user owns and hosted worlds on their scenes; a failing destroy is 409', async () => {
      await db.insert(userAuthMethods).values({ userId: owner.id, type: 'email', identifier: owner.email!, credentialHash: await bcrypt.hash('pw-1234', 4) })
      const mine = await hostedRunning()
      // Someone else's hosted world on the owner's scene goes with the scene.
      const guest = await createUser()
      await db.insert(subscriptions).values({ userId: guest.id, tier: 'creator' })
      const hosting = await vi.importActual<typeof import('../src/hyperfy/hosting.js')>('../src/hyperfy/hosting.js')
      const theirs = (await hosting.createHostedWorld({ ownerId: guest.id, sceneId, name: 'Guest World', endsAt: null }, fake.deps)).world
      await settled(theirs.id)
      const theirSlug = (await row(theirs.id)).slug!

      installFakes({ failDeleteApp: true })
      const blocked = await call(owner, 'DELETE', '/api/auth/account', { password: 'pw-1234' })
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json().error).toBe('hosted_world_destroy_failed')
      expect(await userRow(owner.id)).toBeDefined()
      expect(await row(mine.id)).toBeDefined()

      const { destroyed } = installFakes()
      expect((await call(owner, 'DELETE', '/api/auth/account', { password: 'pw-1234' })).statusCode).toBe(204)
      expect([...destroyed].sort()).toEqual([...destroyedAll(mine.slug!), ...destroyedAll(theirSlug)].sort())
      expect(await userRow(owner.id)).toBeUndefined()
      expect(await db.select().from(hyperfyWorlds)).toHaveLength(0)
    })

    it("an admin deleting a user destroys the user's hosted worlds first; a failing destroy is 409", async () => {
      const admin = await createUser({ role: 'admin' })
      const w = await hostedRunning()
      installFakes({ failDeleteApp: true })
      const blocked = await call(admin, 'DELETE', `/api/admin/users/${owner.id}`)
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json().error).toBe('hosted_world_destroy_failed')
      expect(await userRow(owner.id)).toBeDefined()
      const { destroyed } = installFakes()
      expect((await call(admin, 'DELETE', `/api/admin/users/${owner.id}`)).statusCode).toBe(204)
      expect(destroyed).toEqual(destroyedAll(w.slug!))
      expect(await userRow(owner.id)).toBeUndefined()
    })

    it("an admin deleting an organization destroys hosted worlds on the org's scenes first; a failing destroy is 409", async () => {
      const admin = await createUser({ role: 'admin' })
      const [org] = await db.insert(organizations).values({ name: 'Org', slug: `org-${Date.now()}`, billingOwnerId: owner.id }).returning()
      await db.update(scenes).set({ orgId: org.id }).where(eq(scenes.id, sceneId))
      const w = await hostedRunning()
      installFakes({ failDeleteApp: true })
      expect((await call(admin, 'DELETE', `/api/admin/orgs/${org.id}`)).statusCode).toBe(409)
      expect(await sceneRow(sceneId)).toBeDefined()
      const { destroyed } = installFakes()
      expect((await call(admin, 'DELETE', `/api/admin/orgs/${org.id}`)).statusCode).toBe(204)
      expect(destroyed).toEqual(destroyedAll(w.slug!))
      expect(await sceneRow(sceneId)).toBeUndefined()
    })
  })
})
