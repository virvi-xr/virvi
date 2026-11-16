import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { count, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { userAuthMethods, users, walletBlocks } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { clearRegistryCache } from '../src/analytics/registry.js'
import { setSetupLimiter } from '../src/routes/setup.js'
import { setSignedClaimLimiter } from '../src/routes/analytics-claims.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { resetDb } from './helpers/db.js'
import { createUser, testApp } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:')) return { walletAddress: v.slice(6), metadata: {} }
    throw new Error('bad signature')
  },
}))

/**
 * A blocked wallet (LIV-11 reissue) on the Decentraland signed-fetch routes: while it is still on the account that
 * blocked it, no setup, no new account, no eligibility. Once off that account it is an ordinary new wallet (the block
 * stays on BEATs only).
 */
const OP = '0x00000000000000000000000000000000000000bb'
const signed = (w: string) => ({ 'x-identity-auth-chain-0': `valid:${w}` })
const rights = (o: Record<string, unknown> = {}) => ({ owner: null, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [], ...o })
const REF = { realm: 'main', isWorld: false, isPreview: false, baseParcel: '1,1', parcels: ['1,1'], entityId: 'bafyA', title: 'Venue' }

describe('blocked wallets on signed-fetch routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    clearRegistryCache()
    app = await testApp()
    dir = new FakeDclDirectory()
    dir.addScene({ entityId: 'bafyA', base: '1,1', parcels: ['1,1'], title: 'Venue' }, OP)
    dir.rights.set('1,1', rights({ owner: OP }))
    setDclDirectory(dir)
    setSetupLimiter(new TokenBucketLimiter())
    setSignedClaimLimiter(new TokenBucketLimiter())
  })
  afterEach(async () => {
    setDclDirectory(null)
    await app.close()
  })

  it('setup refuses a wallet still on the account that blocked it and creates no account; status shows nothing; once unlinked it sets up as a new account', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/setup/status', payload: { scene: REF }, headers: signed(OP) })).json()).toEqual({ state: 'eligible' })
    const owner = await createUser({ wallet: OP })
    await db.insert(walletBlocks).values({ wallet: OP, userId: owner.id, reason: 'reissue' })
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { scene: REF }, headers: signed(OP) })
    expect([res.statusCode, res.json().error]).toEqual([403, 'wallet_blocked'])
    expect((await db.select({ n: count() }).from(users))[0].n).toBe(1)
    const st = await app.inject({ method: 'POST', url: '/api/setup/status', payload: { scene: REF }, headers: signed(OP) })
    expect([st.statusCode, st.json().error]).toEqual([403, 'wallet_blocked'])

    await db.delete(userAuthMethods).where(eq(userAuthMethods.identifier, OP))
    const again = await app.inject({ method: 'POST', url: '/api/setup', payload: { scene: REF }, headers: signed(OP) })
    expect(again.statusCode, again.body).toBe(200)
    const [link] = await db.select().from(userAuthMethods).where(eq(userAuthMethods.identifier, OP))
    expect(link.userId).not.toBe(owner.id)
  })

  it('the signed eligibility check says a wallet still on the account that blocked it is not eligible, and an unlinked one is', async () => {
    const scene = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'] })
    const post = () => app.inject({ method: 'POST', url: '/api/analytics/claims/check-signed', payload: { locationKey: scene.locationKey }, headers: signed(OP) })
    expect((await post()).json()).toMatchObject({ eligible: true })
    const owner = await createUser({ wallet: OP })
    await db.insert(walletBlocks).values({ wallet: OP, userId: owner.id, reason: 'reissue' })
    expect((await post()).json()).toEqual({ eligible: false, known: false })
    await db.delete(userAuthMethods).where(eq(userAuthMethods.identifier, OP))
    expect((await post()).json()).toMatchObject({ eligible: true })
  })
})
