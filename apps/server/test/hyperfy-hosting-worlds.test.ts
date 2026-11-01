import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { hyperfyWorlds, subscriptions } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { FlyError, type WorldMachineSpec } from '../src/hyperfy/fly.js'
import { worldDbName, WorldDbJobFailed } from '../src/hyperfy/worlds-db.js'
import { createHash } from 'node:crypto'
import { findWorldByKey, findWorldBySecret } from '../src/hyperfy/worlds.js'
import {
  createHostedWorld,
  destroyHostedWorld,
  rotateHostedWorldKey,
  revealAdminCode,
  switchHostedWorldScene,
  hostedWorldSettled,
  type HostingDeps,
} from '../src/hyperfy/hosting.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, type TestUser } from './helpers/factories.js'

/** The custom-endpoint (R2) branch of Hyperfy b4081eb's AssetsS3.parseURI: s3://key:secret@host/bucket/prefix. */
function hyperfyS3Prefix(uri: string): { bucket: string; prefix: string } {
  const [, , , rest] = uri.slice(5).match(/^([^:]+):([^@]+)@(.+)$/)!
  const pathParts = rest.split('/').slice(1)
  return { bucket: pathParts[0], prefix: pathParts.slice(1).join('/') + (pathParts.length > 1 ? '/' : '') }
}

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
  allFeaturesUnlocked: false,
}

type Deferred = { promise: Promise<void>; resolve: () => void }
const deferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

function fakes(opts: { failDb?: Error; failMachine?: Error; failApp?: Error; failUpdate?: Error; healthy?: () => boolean; dbGate?: Promise<void>; onMachine?: () => void | Promise<void> } = {}) {
  const calls: string[] = []
  const apps = new Set<string>()
  const machines = new Map<string, { id: string; image: string; env: Record<string, string> }>()
  const schemas = new Set<string>()
  const filesDeleted: string[] = []
  const healthUrls: string[] = []
  const logs: string[] = []
  let t = 0
  const fly: HostingDeps['fly'] = {
    async createApp(name: string) {
      calls.push(`createApp ${name}`)
      if (opts.failApp) throw opts.failApp
      apps.add(name)
    },
    async deleteApp(name: string) { calls.push(`deleteApp ${name}`); apps.delete(name); machines.delete(name) },
    async allocatePublicIps(app: string) { calls.push(`allocatePublicIps ${app}`) },
    async allocatePrivateIp(app: string) { calls.push(`allocatePrivateIp ${app}`) },
    async createMachine(app: string, m: WorldMachineSpec) {
      calls.push(`createMachine ${app}`)
      await opts.onMachine?.()
      if (opts.failMachine) throw opts.failMachine
      if (!apps.has(app)) throw new Error(`no app ${app}`)
      machines.set(app, { id: `m-${app}`, image: m.image, env: { ...m.env } })
      return { id: `m-${app}` }
    },
    async updateMachine(app: string, id: string, m: WorldMachineSpec) {
      calls.push(`updateMachine ${app} ${id}`)
      if (opts.failUpdate) throw opts.failUpdate
      machines.set(app, { id, image: m.image, env: { ...m.env } })
    },
    async listMachines(app: string) {
      const m = machines.get(app)
      return m ? [{ id: m.id, state: 'started' }] : []
    },
    async getMachineEnv(app: string) { return { ...machines.get(app)!.env } },
    async startMachine() {},
    async stopMachine() {},
  }
  const deps: Partial<HostingDeps> = {
    fly,
    async createWorldDatabase(slug: string) {
      if (opts.dbGate) await opts.dbGate
      const schema = worldDbName(slug)
      // A job that timed out or whose machine call failed may still have committed.
      if (opts.failDb) {
        if (!(opts.failDb instanceof WorldDbJobFailed)) schemas.add(schema)
        throw opts.failDb
      }
      schemas.add(schema)
      return { dbUri: `postgres://${schema}:dbpw_${slug}_s3cr3t@worlds-db.flycast:5432/worlds`, schema }
    },
    async dropWorldDatabase(slug: string) { calls.push(`dropWorldDatabase ${slug}`); schemas.delete(worldDbName(slug)) },
    async deleteWorldFiles(slug: string) { filesDeleted.push(slug); return 0 },
    fetch: (async (url: string) => {
      healthUrls.push(String(url))
      return new Response('', { status: (opts.healthy ?? (() => healthUrls.length >= 2))() ? 200 : 503 })
    }) as unknown as typeof fetch,
    now: () => t,
    sleep: async (ms: number) => { t += ms; await new Promise((r) => setImmediate(r)) },
    log: {
      info: (...a: unknown[]) => { logs.push(JSON.stringify(a)) },
      warn: (...a: unknown[]) => { logs.push(JSON.stringify(a)) },
      error: (...a: unknown[]) => { logs.push(JSON.stringify(a, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v))) },
    },
  }
  return { deps, calls, apps, machines, schemas, filesDeleted, healthUrls, logs }
}

describe('hosted Hyperfy worlds', () => {
  let owner: TestUser
  let sceneId: string
  const saved: Record<string, unknown> = {}

  const setTier = (userId: string, tier: string) => db.insert(subscriptions).values({ userId, tier })
  const row = async (id: string) => (await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, id)))[0]
  const hostedRows = (ownerId: string) =>
    db.select().from(hyperfyWorlds).where(and(eq(hyperfyWorlds.ownerId, ownerId), eq(hyperfyWorlds.kind, 'hosted')))

  beforeEach(async () => {
    await resetDb()
    for (const [k, v] of Object.entries(HOSTING_CONFIG)) {
      saved[k] = (config as any)[k]
      ;(config as any)[k] = v
    }
    owner = await createUser()
    sceneId = (await createScene(owner, 'World')).scene.id
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) (config as any)[k] = v
  })

  it('create inserts provisioning, then running after health, with the exact env (no secrets in logs)', async () => {
    ;(config as any).publicUrl = 'https://api.staging.virvi.io'
    await setTier(owner.id, 'pro')
    const gate = deferred()
    const f = fakes({ dbGate: gate.promise })
    const { world, adminCode } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Moon Base!', endsAt: null }, f.deps)
    expect(world).toMatchObject({ kind: 'hosted', status: 'provisioning', address: 'moon-base.worlds.virvi.io', sceneId, name: 'Moon Base!' })
    expect((await row(world.id)).status).toBe('provisioning')
    expect((await row(world.id)).flyApp).toBe('vlm-w-moon-base')
    gate.resolve()
    await hostedWorldSettled(world.id)

    expect((await row(world.id)).status).toBe('running')
    expect(f.healthUrls.length).toBeGreaterThanOrEqual(2)
    expect(new Set(f.healthUrls)).toEqual(new Set(['https://moon-base.worlds.virvi.io/']))
    const machine = f.machines.get('vlm-w-moon-base')!
    expect(machine.image).toBe('registry.fly.io/vlm-hyperfy-image:abc123')
    expect(machine.env).toEqual({
      PORT: '3000',
      WORLD: 'world',
      PUBLIC_WS_URL: 'wss://moon-base.worlds.virvi.io/ws',
      PUBLIC_API_URL: 'https://moon-base.worlds.virvi.io/api',
      ASSETS: 's3',
      ASSETS_S3_URI: 's3://r2key:r2s3cr3t@acct.r2.cloudflarestorage.com/virvi-hyperfy/moon-base',
      ASSETS_BASE_URL: 'https://worlds-cdn.virvi.io/moon-base',
      DB_URI: 'postgres://world_moon_base:dbpw_moon-base_s3cr3t@worlds-db.flycast:5432/worlds',
      DB_SCHEMA: 'world_moon_base',
      JWT_SECRET: expect.stringMatching(/^[0-9a-f]{64}$/),
      ADMIN_CODE: adminCode,
      SAVE_INTERVAL: '60',
      CLEAN: 'true',
      PUBLIC_SCRIPT_WEBSOCKET_ORIGINS: 'wss://api.staging.virvi.io',
      PUBLIC_MAX_UPLOAD_SIZE: '12',
      VIRVI_FEED_URL: 'https://api.staging.virvi.io',
      VIRVI_WORLD_KEY: expect.stringMatching(/^virviw_[0-9a-f]{64}$/),
      VIRVI_WORLD_SECRET: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect((await findWorldByKey(machine.env.VIRVI_WORLD_KEY))?.id).toBe(world.id)
    // Hyperfy keys files under the URI's prefix; the CDN serves them at ASSETS_BASE_URL/<file>.
    expect(hyperfyS3Prefix(machine.env.ASSETS_S3_URI)).toEqual({ bucket: 'virvi-hyperfy', prefix: 'moon-base/' })

    expect(f.logs.length).toBeGreaterThan(0)
    const logText = f.logs.join('\n')
    for (const secret of [machine.env.JWT_SECRET, adminCode, machine.env.VIRVI_WORLD_KEY, machine.env.VIRVI_WORLD_SECRET, 'dbpw_moon-base_s3cr3t', 'r2s3cr3t', 'fm2_token_s3cr3t', 'adminpw']) {
      expect(logText).not.toContain(secret)
    }
  })

  it('world secret is stored only as a hash, and create sets VIRVI_WORLD_SECRET in the machine env', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Secret World', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const secret = f.machines.get('vlm-w-secret-world')!.env.VIRVI_WORLD_SECRET
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    const stored = await row(world.id)
    expect(stored.worldSecretHash).toBe(createHash('sha256').update(secret).digest('hex'))
    expect(JSON.stringify(stored)).not.toContain(secret)
    const key = f.machines.get('vlm-w-secret-world')!.env.VIRVI_WORLD_KEY
    expect((await findWorldBySecret(key, secret))?.id).toBe(world.id)
    expect(await findWorldBySecret(key, 'wrong')).toBeNull()
    expect(await findWorldBySecret('virviw_other', secret)).toBeNull()
    // rotating the key leaves the secret alone
    await rotateHostedWorldKey(world.id, f.deps)
    expect(f.machines.get('vlm-w-secret-world')!.env.VIRVI_WORLD_SECRET).toBe(secret)
    expect((await row(world.id)).worldSecretHash).toBe(stored.worldSecretHash)
  })

  it('rotating the key moves a pre-rename machine onto Virvi settings and hosts, keeping its secret', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Old World', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const m = f.machines.get('vlm-w-old-world')!
    const old = ['vlm', 'gg'].join('.') // virvi-rename: keep
    const { VIRVI_WORLD_KEY, VIRVI_WORLD_SECRET, VIRVI_FEED_URL, ...rest } = m.env
    m.env = {
      ...rest,
      PUBLIC_WS_URL: `wss://old-world.worlds.${old}/ws`,
      PUBLIC_API_URL: `https://old-world.worlds.${old}/api`,
      ASSETS_BASE_URL: `https://worlds-cdn.${old}/old-world`,
      PUBLIC_SCRIPT_WEBSOCKET_ORIGINS: `wss://api.${old}`,
      ['VLM_FEED_URL']: `https://api.${old}`, // virvi-rename: keep
      ['VLM_WORLD_KEY']: VIRVI_WORLD_KEY, // virvi-rename: keep
      ['VLM_WORLD_SECRET']: VIRVI_WORLD_SECRET, // virvi-rename: keep
    }
    await rotateHostedWorldKey(world.id, f.deps)
    const env = f.machines.get('vlm-w-old-world')!.env
    expect(Object.keys(env).filter((k) => k.startsWith('VLM_'))).toEqual([]) // virvi-rename: keep
    expect(env.VIRVI_WORLD_SECRET).toBe(VIRVI_WORLD_SECRET)
    expect(env.VIRVI_FEED_URL).toBe('https://api.virvi.io')
    expect(env.VIRVI_WORLD_KEY).toMatch(/^virviw_/)
    expect(env.PUBLIC_WS_URL).toBe('wss://old-world.worlds.virvi.io/ws')
    expect(env.PUBLIC_API_URL).toBe('https://old-world.worlds.virvi.io/api')
    expect(env.ASSETS_BASE_URL).toBe('https://worlds-cdn.virvi.io/old-world')
    expect(env.PUBLIC_SCRIPT_WEBSOCKET_ORIGINS).toBe('wss://api.virvi.io')
    void VIRVI_FEED_URL
  })

  it('creator gets a fly.dev address and public IPs; pro gets a worlds.virvi.io address and no IPs', async () => {
    await setTier(owner.id, 'creator')
    const c = fakes()
    const { world: small } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Small World', endsAt: null }, c.deps)
    await hostedWorldSettled(small.id)
    expect(small.address).toBe('vlm-w-small-world.fly.dev')
    expect(c.calls).toContain('allocatePublicIps vlm-w-small-world')
    expect(c.calls.some((x) => x.startsWith('allocatePrivateIp'))).toBe(false)
    expect(c.machines.get('vlm-w-small-world')!.env.PUBLIC_WS_URL).toBe('wss://vlm-w-small-world.fly.dev/ws')
    expect((await row(small.id)).status).toBe('running')

    const pro = await createUser()
    const proScene = (await createScene(pro, 'P')).scene.id
    await setTier(pro.id, 'pro')
    const p = fakes()
    const { world: big } = await createHostedWorld({ ownerId: pro.id, sceneId: proScene, name: 'Big World', endsAt: null }, p.deps)
    await hostedWorldSettled(big.id)
    expect(big.address).toBe('big-world.worlds.virvi.io')
    expect(p.calls.some((x) => x.startsWith('allocatePublicIps'))).toBe(false)
    // Router-addressed worlds get one private Flycast address, for the router's large-body proxying.
    expect(p.calls.filter((x) => x.startsWith('allocatePrivateIp'))).toEqual(['allocatePrivateIp vlm-w-big-world'])
    expect((await row(big.id)).status).toBe('running')
  })

  it('create past the slot limit throws world_limit_reached and creates nothing', async () => {
    await setTier(owner.id, 'creator')
    await db.insert(hyperfyWorlds).values({
      sceneId, ownerId: owner.id, name: 'Existing', kind: 'hosted', slug: 'existing', status: 'running', keyHash: 'h1', keyPrefix: 'virviw_x',
    })
    const f = fakes()
    await expect(createHostedWorld({ ownerId: owner.id, sceneId, name: 'Second', endsAt: null }, f.deps))
      .rejects.toMatchObject({ code: 'world_limit_reached' })
    // The free plan hosts one world too; a second is past its limit.
    const free = await createUser()
    await db.insert(hyperfyWorlds).values({
      sceneId, ownerId: free.id, name: 'Free one', kind: 'hosted', slug: 'free-one', status: 'running', keyHash: 'h2', keyPrefix: 'virviw_y',
    })
    await expect(createHostedWorld({ ownerId: free.id, sceneId, name: 'Free', endsAt: null }, f.deps))
      .rejects.toMatchObject({ code: 'world_limit_reached', message: "You've used all 1 of your hosted worlds" })
    expect(await hostedRows(owner.id)).toHaveLength(1)
    expect(await hostedRows(free.id)).toHaveLength(1)
    expect(f.calls).toEqual([])
    expect(f.schemas.size).toBe(0)
  })

  it('two concurrent creates for the last slot: one succeeds, one gets world_limit_reached', async () => {
    await setTier(owner.id, 'creator')
    const f = fakes()
    const results = await Promise.allSettled([
      createHostedWorld({ ownerId: owner.id, sceneId, name: 'Race', endsAt: null }, f.deps),
      createHostedWorld({ ownerId: owner.id, sceneId, name: 'Race', endsAt: null }, f.deps),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(bad).toHaveLength(1)
    expect(bad[0].reason).toMatchObject({ code: 'world_limit_reached' })
    await hostedWorldSettled((ok[0] as PromiseFulfilledResult<{ world: { id: string } }>).value.world.id)
    expect(await hostedRows(owner.id)).toHaveLength(1)
    expect(f.calls.filter((x) => x.startsWith('createApp'))).toEqual(['createApp vlm-w-race'])
  })

  it('slug clash gets a -2 suffix', async () => {
    await setTier(owner.id, 'pro')
    const other = await createUser()
    const otherScene = (await createScene(other, 'O')).scene.id
    await setTier(other.id, 'pro')
    const f = fakes()
    const a = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Moon', endsAt: null }, f.deps)
    const b = await createHostedWorld({ ownerId: other.id, sceneId: otherScene, name: 'moon', endsAt: null }, f.deps)
    const c = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'MOON', endsAt: null }, f.deps)
    await Promise.all([a, b, c].map((r) => hostedWorldSettled(r.world.id)))
    expect((await row(a.world.id)).slug).toBe('moon')
    expect((await row(b.world.id)).slug).toBe('moon-2')
    expect((await row(c.world.id)).slug).toBe('moon-3')
    expect(b.world.address).toBe('moon-2.worlds.virvi.io')

    // Names that slug to too little, or too much, still give a slug the router accepts.
    const d = await createHostedWorld({ ownerId: other.id, sceneId: otherScene, name: '!!', endsAt: null }, f.deps)
    const e = await createHostedWorld({ ownerId: other.id, sceneId: otherScene, name: `${'x'.repeat(29)}-y and more`, endsAt: null }, f.deps)
    await Promise.all([d, e].map((r) => hostedWorldSettled(r.world.id)))
    for (const r of [d, e]) expect((await row(r.world.id)).slug).toMatch(/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/)
  })

  it('a failure after the app exists cleans up the app, schema and files and marks the world failed', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes({ failMachine: new FlyError('Fly POST /apps/vlm-w-doomed/machines returned 422: no capacity in iad', 422, '') })
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Doomed', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const r = await row(world.id)
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toContain('no capacity in iad')
    expect(f.calls).toContain('createApp vlm-w-doomed')
    expect(f.calls).toContain('deleteApp vlm-w-doomed')
    expect(f.apps.size).toBe(0)
    expect(f.schemas.size).toBe(0)
    expect(f.filesDeleted).toEqual(['doomed'])
  })

  it('a world database create with an unknown outcome (Fly error or job timeout) is dropped, and the world fails', async () => {
    await setTier(owner.id, 'pro')
    for (const [name, failDb] of [
      ['Lost Job', new FlyError('Fly GET /apps/vlm-worlds-db-jobs/machines/j1/wait?state=stopped&timeout=60 returned 500: boom', 500, '')],
      ['Slow Job', new FlyError('Fly job machine j2 in vlm-worlds-db-jobs did not finish within 120 s', 0, '')],
    ] as const) {
      const f = fakes({ failDb })
      const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name, endsAt: null }, f.deps)
      await hostedWorldSettled(world.id)
      const r = await row(world.id)
      expect(r.status).toBe('failed')
      expect(f.calls).toContain(`dropWorldDatabase ${r.slug}`)
      expect(f.schemas.size).toBe(0)
      expect(f.calls.some((x) => x.startsWith('createApp'))).toBe(false)
      await destroyHostedWorld(world.id, f.deps)
    }
  })

  it('a world database job that failed and rolled back is not dropped (it may be another world\'s)', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes({ failDb: new WorldDbJobFailed('creating the world database failed: worlds database job failed with exit code 1') })
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Rolled Back', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const r = await row(world.id)
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toContain('exit code 1')
    expect(f.calls.some((x) => x.startsWith('dropWorldDatabase'))).toBe(false)
  })

  it("a createApp failure (the app name already exists) deletes nothing it didn't make", async () => {
    await setTier(owner.id, 'pro')
    const f = fakes({ failApp: new FlyError('Fly POST /apps returned 422: app already exists', 422, '') })
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Taken', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const r = await row(world.id)
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toContain('already exists')
    expect(f.calls.some((x) => x.startsWith('deleteApp'))).toBe(false)
    expect(f.filesDeleted).toEqual([])
    expect(f.schemas.size).toBe(0)
  })

  it('a failed create leaves the slot free for the next create', async () => {
    await setTier(owner.id, 'creator')
    const bad = fakes({ failMachine: new FlyError('boom', 500, '') })
    const first = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'First Try', endsAt: null }, bad.deps)
    await hostedWorldSettled(first.world.id)
    expect((await row(first.world.id)).status).toBe('failed')
    const good = fakes()
    const second = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Second Try', endsAt: null }, good.deps)
    await hostedWorldSettled(second.world.id)
    expect((await row(second.world.id)).status).toBe('running')
  })

  it('a row deleted elsewhere mid-create leaves no Fly app, schema or files behind', async () => {
    await setTier(owner.id, 'pro')
    let worldId = ''
    const f = fakes({ onMachine: async () => { await db.delete(hyperfyWorlds).where(eq(hyperfyWorlds.id, worldId)) } })
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Orphan', endsAt: null }, f.deps)
    worldId = world.id
    await hostedWorldSettled(world.id)
    expect(await row(world.id)).toBeUndefined()
    expect(f.calls).toContain('deleteApp vlm-w-orphan')
    expect(f.apps.size).toBe(0)
    expect(f.schemas.size).toBe(0)
    expect(f.filesDeleted).toEqual(['orphan'])
  })

  it('a world that never answers health within 180 s is cleaned up and marked failed', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes({ healthy: () => false })
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Silent', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const r = await row(world.id)
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toMatch(/180 s/)
    expect(f.apps.size).toBe(0)
    expect(f.schemas.size).toBe(0)
    expect(f.filesDeleted).toEqual(['silent'])
  })

  it('destroy during provisioning leaves no Fly app, schema or row', async () => {
    await setTier(owner.id, 'pro')
    const machineCreated = deferred()
    const f = fakes({ healthy: () => false, onMachine: () => machineCreated.resolve() })
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Brief', endsAt: null }, f.deps)
    await machineCreated.promise
    expect(f.apps.has('vlm-w-brief')).toBe(true)
    await destroyHostedWorld(world.id, f.deps)
    await hostedWorldSettled(world.id)
    expect(await row(world.id)).toBeUndefined()
    expect(f.apps.size).toBe(0)
    expect(f.machines.size).toBe(0)
    expect(f.schemas.size).toBe(0)
    expect(f.filesDeleted).toContain('brief')
    expect(f.calls.filter((x) => x.startsWith('createApp'))).toHaveLength(1)
  })

  it('destroy of a running world deletes app, schema, files and row', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Done', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    await destroyHostedWorld(world.id, f.deps)
    expect(await row(world.id)).toBeUndefined()
    expect(f.apps.size).toBe(0)
    expect(f.schemas.size).toBe(0)
    expect(f.filesDeleted).toEqual(['done'])
  })

  it('script WebSocket origins follow the server URL: http becomes ws', async () => {
    ;(config as any).publicUrl = 'http://localhost:3010'
    await setTier(owner.id, 'creator')
    const f = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Local', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    expect(f.machines.get('vlm-w-local')!.env.PUBLIC_SCRIPT_WEBSOCKET_ORIGINS).toBe('ws://localhost:3010')
  })

  it('rotate-key on a world with no secret yet sets a hash and VIRVI_WORLD_SECRET; with a secret it leaves both alone', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Legacy', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    // make it a pre-secret world
    await db.update(hyperfyWorlds).set({ worldSecretHash: null }).where(eq(hyperfyWorlds.id, world.id))
    delete f.machines.get('vlm-w-legacy')!.env.VIRVI_WORLD_SECRET
    await rotateHostedWorldKey(world.id, f.deps)
    const secret = f.machines.get('vlm-w-legacy')!.env.VIRVI_WORLD_SECRET
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    const hash = (await row(world.id)).worldSecretHash
    expect(hash).toBe(createHash('sha256').update(secret).digest('hex'))
    await rotateHostedWorldKey(world.id, f.deps)
    expect(f.machines.get('vlm-w-legacy')!.env.VIRVI_WORLD_SECRET).toBe(secret)
    expect((await row(world.id)).worldSecretHash).toBe(hash)
  })

  it('rotate-key whose machine update fails does not leave a secret hash the env lacks', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Flaky', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    await db.update(hyperfyWorlds).set({ worldSecretHash: null }).where(eq(hyperfyWorlds.id, world.id))
    delete f.machines.get('vlm-w-flaky')!.env.VIRVI_WORLD_SECRET
    const real = f.deps.fly!.updateMachine
    f.deps.fly!.updateMachine = async () => { throw new Error('fly down') }
    await expect(rotateHostedWorldKey(world.id, f.deps)).rejects.toThrow()
    expect((await row(world.id)).worldSecretHash).toBeNull()
    f.deps.fly!.updateMachine = real
    await rotateHostedWorldKey(world.id, f.deps)
    expect((await row(world.id)).worldSecretHash).not.toBeNull()
  })

  it('rotate updates the machine env and old key stops working', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Keys', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const before = { ...f.machines.get('vlm-w-keys')!.env }
    const { key } = await rotateHostedWorldKey(world.id, f.deps)
    expect(key).toMatch(/^virviw_[0-9a-f]{64}$/)
    expect(key).not.toBe(before.VIRVI_WORLD_KEY)
    expect(f.calls).toContain('updateMachine vlm-w-keys m-vlm-w-keys')
    expect(f.machines.get('vlm-w-keys')!.env).toEqual({ ...before, VIRVI_WORLD_KEY: key })
    expect(await findWorldByKey(before.VIRVI_WORLD_KEY)).toBeNull()
    expect((await findWorldByKey(key))?.id).toBe(world.id)
    expect((await row(world.id)).keyPrefix).toBe(key.slice(0, 12))
  })

  it('a rotate whose machine update fails says the key changed and to rotate again', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Flaky', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const failing = fakes({ failUpdate: new FlyError('Fly POST /apps/vlm-w-flaky/machines/m returned 503: busy', 503, '') })
    failing.machines.set('vlm-w-flaky', f.machines.get('vlm-w-flaky')!)
    const err = await rotateHostedWorldKey(world.id, failing.deps).catch((e) => e)
    expect(err).toMatchObject({ code: 'world_update_failed' })
    expect(err.message).toMatch(/key was changed/i)
    expect(err.message).toMatch(/rotate .*again/i)
    expect(err.message).not.toContain('virviw_')
  })

  it("a rotate's failed machine update is logged without the world's secrets", async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const { world, adminCode } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Leaky', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const env = { ...f.machines.get('vlm-w-leaky')!.env }
    let sentKey = ''
    // Fly can echo the machine config back in its error.
    f.deps.fly!.updateMachine = async (_app: string, _id: string, m: WorldMachineSpec) => {
      sentKey = m.env.VIRVI_WORLD_KEY
      throw new FlyError(`Fly POST returned 422: invalid config ${JSON.stringify(m.env)}`, 422, '')
    }
    f.logs.length = 0
    await expect(rotateHostedWorldKey(world.id, f.deps)).rejects.toMatchObject({ code: 'world_update_failed' })
    const logText = f.logs.join('\n')
    expect(logText).toContain('machine update failed')
    expect(logText).toContain('[redacted]')
    for (const secret of [sentKey, env.VIRVI_WORLD_KEY, env.DB_URI, 'dbpw_leaky_s3cr3t', env.JWT_SECRET, adminCode, 'r2s3cr3t']) {
      expect(secret.length).toBeGreaterThan(5)
      expect(logText).not.toContain(secret)
    }
  })

  it("a rotate doesn't turn autostart back on for a world that ended meanwhile", async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Racing', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const keyHash = (await row(world.id)).keyHash
    const realGetEnv = f.deps.fly!.getMachineEnv
    // The sweep ends and quiesces the world after rotate read it as running.
    f.deps.fly!.getMachineEnv = async (app: string, id: string) => {
      await db.update(hyperfyWorlds).set({ status: 'ended', endedAt: new Date(), quiescedAt: new Date() }).where(eq(hyperfyWorlds.id, world.id))
      return realGetEnv(app, id)
    }
    f.calls.length = 0
    await expect(rotateHostedWorldKey(world.id, f.deps)).rejects.toMatchObject({ code: 'world_not_running' })
    expect(f.calls.filter((c) => c.startsWith('updateMachine'))).toEqual([])
    expect((await row(world.id)).keyHash).toBe(keyHash)
  })

  it('switching scene updates the row only', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Switch', endsAt: null }, f.deps)
    await hostedWorldSettled(world.id)
    const callsBefore = f.calls.length
    const next = (await createScene(owner, 'Next')).scene.id
    await switchHostedWorldScene(world.id, next)
    expect((await row(world.id)).sceneId).toBe(next)
    expect(f.calls.length).toBe(callsBefore)
  })

  it('admin code is stored encrypted and revealed only by revealAdminCode', async () => {
    await setTier(owner.id, 'pro')
    const f = fakes()
    const endsAt = new Date('2027-01-01T00:00:00Z')
    const { world, adminCode } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'Admin', endsAt }, f.deps)
    await hostedWorldSettled(world.id)
    expect(adminCode).toMatch(/^[0-9a-f]{16,}$/)
    const r = await row(world.id)
    expect(r.endsAt?.toISOString()).toBe(endsAt.toISOString())
    expect(r.adminCodeEnc).toBeTruthy()
    expect(JSON.stringify(r)).not.toContain(adminCode)
    expect(JSON.stringify(world)).not.toContain(adminCode)
    expect(await revealAdminCode(world.id)).toBe(adminCode)
  })
})
