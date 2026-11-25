import { DCL_HUD_LATEST } from '@virvixr/shared'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { count } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { locationSetups, sceneRoles, scenes, users } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { clearRegistryCache } from '../src/analytics/registry.js'
import { setSetupLimiter } from '../src/routes/setup.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { resetDb } from './helpers/db.js'
import { testApp } from './helpers/factories.js'
import { config } from '../src/config.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:')) return { walletAddress: v.slice(6), metadata: {} }
    throw new Error('bad signature')
  },
}))

const OWNER = '0x00000000000000000000000000000000000000aa'
const OP = '0x00000000000000000000000000000000000000bb'
const VISITOR = '0x00000000000000000000000000000000000000cc'
const signed = (w: string) => ({ 'x-identity-auth-chain-0': `valid:${w}` })
const rights = (o: Record<string, unknown> = {}) => ({ owner: null, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [], ...o })
const REF = { realm: 'main', isWorld: false, isPreview: false, baseParcel: '1,1', parcels: ['1,1'], entityId: 'bafyA', title: 'Venue' }

describe('setup routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let dir: FakeDclDirectory
  beforeEach(async () => {
    ref = REF
    await resetDb()
    clearRegistryCache()
    app = await testApp()
    dir = new FakeDclDirectory()
    dir.addScene({ entityId: 'bafyA', base: '1,1', parcels: ['1,1'], title: 'Venue' }, OWNER)
    dir.rights.set('1,1', rights({ owner: OWNER, operator: OP }))
    setDclDirectory(dir)
    setSetupLimiter(new TokenBucketLimiter())
  })
  afterEach(async () => {
    setDclDirectory(null)
    await app.close()
  })
  let ref: typeof REF = REF
  const status = (w: string | null) =>
    app.inject({ method: 'POST', url: '/api/setup/status', payload: { scene: ref }, headers: w ? signed(w) : {} })
  const setup = (w: string | null) => app.inject({ method: 'POST', url: '/api/setup', payload: { scene: ref }, headers: w ? signed(w) : {} })

  it('controller sees eligible; visitor sees none; unsigned sees none', async () => {
    expect((await status(OWNER)).json()).toEqual({ state: 'eligible' })
    expect((await status(VISITOR)).json()).toEqual({ state: 'none' })
    expect((await status(null)).json()).toEqual({ state: 'none' })
  })

  it('a visitor calling setup directly is rejected and nothing is created', async () => {
    const res = await setup(VISITOR)
    expect(res.statusCode).toBe(403)
    expect((await db.select({ n: count() }).from(scenes))[0].n).toBe(0)
    expect((await db.select({ n: count() }).from(users))[0].n).toBe(0)
    expect((await setup(null)).statusCode).toBe(401)
  })

  it('operator presses setup → becomes host; owner then sees taken; host sees member/host', async () => {
    const res = await setup(OP)
    expect(res.statusCode).toBe(200)
    const { sceneId } = res.json()
    expect((await status(OP)).json()).toEqual({ state: 'member', sceneId, role: 'host', hudLatest: DCL_HUD_LATEST, virviDeploys: false })
    expect((await status(OWNER)).json()).toEqual({ state: 'taken', host: '0x0000…00bb', sceneId })
    expect((await setup(OWNER)).statusCode).toBe(409)
  })

  it('a role-less visitor at a set-up location gets the sceneId (content-only connect)', async () => {
    expect((await status(VISITOR)).json()).toEqual({ state: 'none' })
    const { sceneId } = (await setup(OP)).json()
    expect((await status(VISITOR)).json()).toEqual({ state: 'none', sceneId })
  })

  it('a wallet with a scene role sees member with that role', async () => {
    const { sceneId } = (await setup(OWNER)).json()
    await db.insert(sceneRoles).values({ sceneId, walletAddress: VISITOR, role: 'editor' })
    expect((await status(VISITOR)).json()).toEqual({ state: 'member', sceneId, role: 'editor', hudLatest: DCL_HUD_LATEST, virviDeploys: false })
  })

  it('two controllers pressing at once → exactly one setup', async () => {
    const [a, b] = await Promise.all([setup(OWNER), setup(OP)])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    expect(await db.select().from(locationSetups)).toHaveLength(1)
  })

  it('Decentraland down → 503 and nothing created', async () => {
    dir.down = true
    const res = await setup(OWNER)
    expect(res.statusCode).toBe(503)
    expect((await status(OWNER)).json()).toEqual({ state: 'unavailable' })
    expect(await db.select().from(locationSetups)).toHaveLength(0)
  })

  it('after a foreign redeploy the location is offered again', async () => {
    await setup(OP)
    dir.addScene({ entityId: 'bafyNEW', base: '1,1', parcels: ['1,1'], title: 'Venue' }, OWNER)
    clearRegistryCache()
    ref = { ...REF, entityId: 'bafyNEW' }
    expect((await status(OWNER)).json()).toEqual({ state: 'eligible' })
    expect((await setup(OWNER)).statusCode).toBe(200)
  })
  it('preview realms: set up allowed off-cloud (local dev), refused in cloud mode', async () => {
    ref = { ...REF, realm: 'LocalPreview', isPreview: true }
    const prev = config.mode
    try {
      ;(config as any).mode = 'cloud'
      expect((await status(OWNER)).json()).toEqual({ state: 'none' })
      const res = await setup(OWNER)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ error: 'not_eligible' })
      expect(await db.select().from(locationSetups)).toHaveLength(0)

      ;(config as any).mode = 'single'
      expect((await status(OWNER)).json()).toEqual({ state: 'eligible' })
      expect((await setup(OWNER)).statusCode).toBe(200)
      expect(await db.select().from(locationSetups)).toHaveLength(1)
    } finally {
      ;(config as any).mode = prev
    }
  })
  it('member status with an unchanged live entity makes no directory calls', async () => {
    await setup(OP)
    dir.calls = 0
    expect((await status(OP)).json()).toMatchObject({ state: 'member', role: 'host' })
    expect(dir.calls).toBe(0)
  })
})
