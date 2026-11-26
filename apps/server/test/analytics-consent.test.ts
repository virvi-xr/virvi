import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ANALYTICS_CONSENT_VERSION } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { analyticsConsents, analyticsEvents, analyticsScenes, analyticsSessions } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { clearRegistryCache } from '../src/analytics/registry.js'
import { consentSubject } from '../src/analytics/consent.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { setIngestLimiter } from '../src/routes/ingest.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:')) return { walletAddress: v.slice(6), metadata: {} }
    throw new Error('bad signature')
  },
}))

const WALLET = '0x00000000000000000000000000000000000000aa'
const GUEST = 'guest-visitor-1'
const SID = '22222222-2222-4222-8222-222222222222'
const signed = (w = WALLET) => ({ 'x-identity-auth-chain-0': `valid:${w}` })
const SCENE = { realm: 'main', isWorld: false, isPreview: false, baseParcel: '10,10', parcels: ['10,10'], entityId: 'bafyA' }

function batch(o: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    v: 1, sessionId: SID, visitorId: WALLET, isGuest: false, noticeShown: true, displayName: 'Ana', scene: SCENE,
    events: [
      { t: now - 2000, type: 'session.start', seq: 0, data: { platform: 'decentraland', realm: 'main', isGuest: false } },
      { t: now - 1000, type: 'interact', seq: 1, data: { kind: 'click', target: 'door' } },
    ],
    ...o,
  }
}

describe('scene visitor analytics notice', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    clearRegistryCache()
    setIngestLimiter(new TokenBucketLimiter())
    const dir = new FakeDclDirectory()
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10'], title: 'Caldera' })
    setDclDirectory(dir)
    app = await testApp()
  })
  afterEach(async () => {
    setDclDirectory(null)
    await app.close()
  })

  const status = (headers: Record<string, string> = signed(), visitorId?: string) =>
    app.inject({ method: 'GET', url: `/api/analytics/consent${visitorId ? `?visitorId=${encodeURIComponent(visitorId)}` : ''}`, headers })
  const decide = (decision: unknown, headers: Record<string, string> = signed(), extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/analytics/consent', headers, payload: { decision, version: ANALYTICS_CONSENT_VERSION, scene: SCENE, platform: 'decentraland', ...extra } })
  const ingest = (body: unknown, headers: Record<string, string> = signed()) =>
    app.inject({ method: 'POST', url: '/api/ingest', payload: body as any, headers })

  it('a visitor who never decided has no decision; an unsigned call must name its visitor', async () => {
    const res = await status()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ version: ANALYTICS_CONSENT_VERSION, decision: null })
    expect((await status({})).statusCode).toBe(400)
    expect((await status({}, GUEST)).json()).toEqual({ version: ANALYTICS_CONSENT_VERSION, decision: null })
  })

  it('records a decision under the cross-scene key, with no raw wallet anywhere, and returns it', async () => {
    await ingest(batch()) // the location is known once it has sent analytics
    const [scene] = await db.select().from(analyticsScenes)
    const res = await decide('accept')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ version: ANALYTICS_CONSENT_VERSION, decision: 'accept' })
    expect(res.body).not.toContain(WALLET)
    const rows = await db.select().from(analyticsConsents)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ subjectHash: consentSubject(WALLET, WALLET), decision: 'accept', version: ANALYTICS_CONSENT_VERSION, sceneId: scene.id, platform: 'decentraland' })
    expect(JSON.stringify(rows)).not.toContain(WALLET.slice(2))
    expect((await status()).json().decision).toBe('accept')
  })

  it('a location Virvi has never seen is recorded without a scene, and never created', async () => {
    await decide('decline')
    const [row] = await db.select().from(analyticsConsents)
    expect(row.sceneId).toBeNull()
    expect(await db.select().from(analyticsScenes)).toHaveLength(0)
  })

  it('is append-only: changing your mind adds a row, and the latest one counts', async () => {
    await decide('accept')
    await decide('decline')
    expect((await status()).json().decision).toBe('decline')
    await decide('accept')
    expect((await status()).json().decision).toBe('accept')
    expect((await db.select().from(analyticsConsents)).map((r) => r.decision)).toEqual(['accept', 'decline', 'accept'])
  })

  it('refuses a stale version (400) and a bad decision, recording nothing', async () => {
    for (const version of [0, ANALYTICS_CONSENT_VERSION + 1, '1', undefined]) {
      const res = await decide('accept', signed(), { version })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'stale_version', version: ANALYTICS_CONSENT_VERSION })
    }
    expect((await decide('maybe')).statusCode).toBe(400)
    expect((await decide('accept', {})).statusCode).toBe(400) // unsigned without a visitor id
    expect(await db.select().from(analyticsConsents)).toHaveLength(0)
  })

  it('asks again once the version goes up: a decision on an older version is no decision', async () => {
    await db.insert(analyticsConsents).values({ subjectHash: consentSubject(WALLET, WALLET), decision: 'accept', version: ANALYTICS_CONSENT_VERSION - 1, platform: 'decentraland' })
    expect((await status()).json().decision).toBeNull()
  })

  it("an unsigned call can't read or record a decision for a wallet-shaped id (401), and nothing is stored", async () => {
    for (const id of [WALLET, WALLET.toUpperCase().replace('0X', '0x')]) {
      const read = await status({}, id)
      expect(read.statusCode).toBe(401)
      expect(read.json()).toMatchObject({ error: 'signature_required' })
      const write = await decide('decline', {}, { visitorId: id })
      expect(write.statusCode).toBe(401)
    }
    expect(await db.select().from(analyticsConsents)).toHaveLength(0)
    expect((await ingest(batch())).json()).toMatchObject({ accepted: 2 }) // the wallet's own batches still flow
  })

  it('an unsigned guest id decides as a guest', async () => {
    await decide('decline', {}, { visitorId: GUEST })
    expect((await status({}, GUEST)).json().decision).toBe('decline')
    expect((await status()).json().decision).toBeNull()
  })

  describe('ingest', () => {
    it('stores events from a visitor with no decision (scenes on old runtimes never ask) or who accepted', async () => {
      expect((await ingest(batch())).json()).toMatchObject({ accepted: 2 })
      await decide('accept')
      expect((await ingest(batch({ events: [{ t: Date.now(), type: 'custom', seq: 5, data: { name: 'x' } }] }))).json()).toMatchObject({ accepted: 1 })
      expect(await db.select().from(analyticsEvents)).toHaveLength(3)
    })

    it('drops every event from a visitor who declined: nothing stored, no scene row, no wallet notice', async () => {
      await decide('decline')
      const res = await ingest(batch())
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true, accepted: 0, notice: false })
      expect(await db.select().from(analyticsSessions)).toHaveLength(0)
      expect(await db.select().from(analyticsEvents)).toHaveLength(0)
      expect(await db.select().from(analyticsScenes)).toHaveLength(0)
    })

    it('drops a guest who declined; keys never cross between signed and unsigned', async () => {
      await decide('decline', {}, { visitorId: GUEST })
      expect((await ingest(batch({ visitorId: GUEST, isGuest: true, noticeShown: false, displayName: undefined }), {})).json()).toMatchObject({ accepted: 0 })
      expect(await db.select().from(analyticsSessions)).toHaveLength(0)
      // A signed decline is enforced on signed batches only: an unsigned batch is checked under its own guest key
      await decide('decline')
      expect((await ingest(batch())).json()).toMatchObject({ accepted: 0 })
      expect((await ingest(batch(), {})).json()).toMatchObject({ accepted: 2 })
    })

    it('reads the same key the consent GET reads, for the same request', async () => {
      await decide('accept')
      expect((await status()).json().decision).toBe('accept')
      expect((await ingest(batch())).json()).toMatchObject({ accepted: 2 })
      await decide('decline')
      expect((await status()).json().decision).toBe('decline')
      expect((await ingest(batch({ sessionId: '33333333-3333-4333-8333-333333333333' }))).json()).toMatchObject({ accepted: 0 })
    })

    it('a decline on an older version is not enforced (the visitor is asked again)', async () => {
      await db.insert(analyticsConsents).values({ subjectHash: consentSubject(WALLET, WALLET), decision: 'decline', version: ANALYTICS_CONSENT_VERSION - 1, platform: 'decentraland' })
      expect((await ingest(batch())).json()).toMatchObject({ accepted: 2 })
    })

    it('accepting again after a decline lets events through', async () => {
      await decide('decline')
      await decide('accept')
      expect((await ingest(batch())).json()).toMatchObject({ accepted: 2 })
    })
  })

  describe('delete my data', () => {
    const del = async (wallet: string) => {
      const me = await createUser({ wallet })
      return app.inject({ method: 'POST', url: '/api/analytics/me/delete', headers: { authorization: `Bearer ${tokenFor(me)}` } })
    }

    it("removes the wallet's decisions, keeping one final decline so it's still honoured", async () => {
      await decide('accept')
      await decide('decline')
      await decide('decline', {}, { visitorId: GUEST }) // someone else's
      const res = await del(WALLET)
      expect(res.json().deleted.consents).toBe(1)
      const left = await db.select().from(analyticsConsents)
      expect(left.map((r) => r.decision).sort()).toEqual(['decline', 'decline'])
      expect((await status()).json().decision).toBe('decline')
      expect((await ingest(batch())).json()).toMatchObject({ accepted: 0 })
    })

    it("also removes guest-keyed rows under the wallet's address, keeping a final decline there too", async () => {
      const g = consentSubject(null, WALLET)
      await db.insert(analyticsConsents).values([
        { subjectHash: g, decision: 'accept', version: ANALYTICS_CONSENT_VERSION, platform: 'decentraland', createdAt: new Date(Date.now() - 2000) },
        { subjectHash: g, decision: 'decline', version: ANALYTICS_CONSENT_VERSION, platform: 'decentraland', createdAt: new Date(Date.now() - 1000) },
      ])
      await decide('accept')
      const res = await del(WALLET)
      expect(res.json().deleted.consents).toBe(2) // the wallet's accept and the old guest-keyed accept
      const left = await db.select().from(analyticsConsents)
      expect(left.map((r) => [r.subjectHash === g, r.decision])).toEqual([[true, 'decline']])
    })

    it('removes every row when the latest decision is an accept', async () => {
      await decide('decline')
      await decide('accept')
      expect((await del(WALLET)).json().deleted.consents).toBe(2)
      expect(await db.select().from(analyticsConsents)).toHaveLength(0)
    })
  })
})
