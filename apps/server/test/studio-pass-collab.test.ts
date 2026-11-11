import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { config } from '../src/config.js'
import { initBus } from '../src/realtime/bus.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { testApp } from './helpers/factories.js'
import { fakeFly } from './helpers/studio.js'

// Signed-fetch fixture as in studio-pass.test.ts: the wallet comes from the test header.
vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async () => { throw new Error('bad signature') },
  verifyDclSceneRequest: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    const scene = {
      sceneId: 'bafyStudio',
      parcel: h['x-test-parcel'] ?? '0,0',
      realm: { hostname: 'peer.decentraland.org', serverName: 'main' },
      isGuest: false,
    }
    if (typeof v === 'string' && v.startsWith('valid:')) return { wallet: v.slice(6), scene, bodySigned: true }
    throw new Error('bad signature')
  },
}))

const S = '/api/studio'
const PARCEL = '-12,34'
const A = '0x00000000000000000000000000000000000000a1'
const B = '0x00000000000000000000000000000000000000b2'
const C = '0x00000000000000000000000000000000000000c3'

describe('the studio pass on the collaboration routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = { enabled: config.studioEnabled, parcel: config.studioSceneParcel, image: config.studioWorkerImage }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioSceneParcel = PARCEL
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    initBus({ publish: () => {}, subscribe: () => {}, unsubscribe: () => {} })
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioSceneParcel = prev.parcel
    ;(config as any).studioWorkerImage = prev.image
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
  })
  afterEach(async () => { await app.close() })

  /** Signs `wallet` in through the studio parcel; returns the studio pass and the user id. */
  const pass = async (wallet: string, displayName: string) => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${wallet}`, 'x-test-parcel': PARCEL },
      payload: { user: { displayName } },
    })
    expect(res.statusCode).toBe(200)
    const token = res.json().accessToken as string
    expect(verifySessionToken(token)).toMatchObject({ kind: 'scene', via: 'studio' })
    return { token, id: res.json().user.id as string, h: { authorization: `Bearer ${token}` } }
  }
  const get = (u: { h: object }, url: string) => app.inject({ method: 'GET', url: `${S}${url}`, headers: u.h as any })
  const post = (u: { h: object }, url: string, payload: any = {}) => app.inject({ method: 'POST', url: `${S}${url}`, headers: u.h as any, payload })

  const setup = async () => {
    const a = await pass(A, 'Alice')
    const b = await pass(B, 'Bob')
    const c = await pass(C, 'Cleo')
    const created = await post(a, '/designs', { kind: 'wearable', agent: 'claude' })
    expect(created.statusCode).toBe(201)
    const designId = created.json().id
    expect(typeof designId).toBe('string')
    return { a, b, c, designId: designId as string }
  }
  const invite = async (a: any, designId: string, wallet: string, role: string) => {
    const res = await post(a, `/designs/${designId}/invites`, { wallet, role })
    expect(res.statusCode).toBe(201)
    return res.json().invite.id as string
  }

  it('invite, list, accept, list designs, people, prompt, leave, all with studio passes', async () => {
    const { a, b, designId } = await setup()
    const inviteId = await invite(a, designId, B, 'collaborator')

    const mine = await get(b, '/invites')
    expect(mine.statusCode).toBe(200)
    expect(mine.json()).toMatchObject([{ id: inviteId, designId, role: 'collaborator', inviterName: 'Alice' }])

    const accepted = await post(b, `/invites/${inviteId}/accept`)
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toEqual({ designId, role: 'collaborator' })

    const list = await get(b, '/designs')
    expect(list.statusCode).toBe(200)
    expect(Array.isArray(list.json())).toBe(true)
    const row = list.json().find((d: any) => d.id === designId)
    expect(row).toMatchObject({ role: 'collaborator', ownerName: 'Alice' })

    const pa = await get(a, `/designs/${designId}/people`)
    expect(pa.statusCode).toBe(200)
    expect(pa.json().invites).toBeDefined()
    const pb = await get(b, `/designs/${designId}/people`)
    expect(pb.statusCode).toBe(200)
    expect(pb.json().invites).toBeUndefined()

    const prompt = await post(b, `/designs/${designId}/prompts`, { text: 'a neon cap', selectedSlots: ['hat'] })
    expect(prompt.statusCode).toBe(202)
    const detail = (await get(a, `/designs/${designId}`)).json()
    expect(detail.activeJob.senderName).toBe('Bob')

    const left = await app.inject({ method: 'DELETE', url: `${S}/designs/${designId}/members/${b.id}`, headers: b.h })
    expect(left.statusCode).toBe(204)
    expect((await get(b, `/designs/${designId}`)).statusCode).toBe(404)
  })

  it('the wall choice stays the owner\'s: a collaborator gets 404', async () => {
    const { a, b, designId } = await setup()
    const inviteId = await invite(a, designId, B, 'collaborator')
    expect((await post(b, `/invites/${inviteId}/accept`)).statusCode).toBe(200)
    const res = await app.inject({ method: 'PUT', url: `${S}/designs/${designId}/wall`, headers: b.h as any, payload: { shown: true } })
    expect(res.statusCode).toBe(404)
    // The route is there for the owner (an unfinalized design is refused, but not as missing)
    const own = await app.inject({ method: 'PUT', url: `${S}/designs/${designId}/wall`, headers: a.h as any, payload: { shown: true } })
    expect(own.statusCode).not.toBe(404)
  })

  it('a viewer is refused a prompt with 403 viewer', async () => {
    const { a, c, designId } = await setup()
    const inviteId = await invite(a, designId, C, 'viewer')
    expect((await post(c, `/invites/${inviteId}/accept`)).json()).toEqual({ designId, role: 'viewer' })
    const res = await post(c, `/designs/${designId}/prompts`, { text: 'hi', selectedSlots: ['hat'] })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('viewer')
  })

  it('declining an invite returns 204', async () => {
    const { a, b, designId } = await setup()
    const inviteId = await invite(a, designId, B, 'collaborator')
    expect((await post(b, `/invites/${inviteId}/decline`)).statusCode).toBe(204)
    expect((await get(b, '/invites')).json()).toEqual([])
  })

  it('notifications stay closed to the studio pass', async () => {
    const { a } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/notifications', headers: a.h })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('studio_pass_not_allowed')
  })
})
