import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { appAttestFrom, config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { appAttestChallenges, appAttestKeys } from '../src/db/schema.js'
import { decodeCbor, requireAssertion } from '../src/app-attest/verify.js'
import { resetDb } from './helpers/db.js'
import { createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { AAGUID, cbor, makeAttestation, makeDevice, makeTestCa, type TestCa, type TestDevice } from './helpers/app-attest.js'

const APP_ID = 'P22YGT64VU.io.virvi.app'

describe('App Attest', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let ca: TestCa
  let user: TestUser
  const prev = config.appAttest

  beforeEach(async () => {
    await resetDb()
    ca = makeTestCa()
    ;(config as any).appAttest = { ...config.appAttest, rootCa: ca.rootPem, appId: APP_ID, env: 'production' }
    app = await testApp()
    user = await createUser()
  })
  afterEach(async () => {
    ;(config as any).appAttest = prev
    await app.close()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const challenge = async (u = user): Promise<string> => {
    const res = await app.inject({ method: 'GET', url: '/api/app/attest/challenge', headers: as(u) })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().challenge
  }
  const register = (device: TestDevice, ch: string, attestation: string, u = user) =>
    app.inject({ method: 'POST', url: '/api/app/attest/register', headers: as(u), payload: { keyId: device.keyId, attestation, challenge: ch } })
  /** A request as requireAssertion sees it. */
  const req = (header: string | undefined, u = user) => ({ headers: header ? { 'x-virvi-attest': header } : {}, user: { id: u.id } }) as unknown as FastifyRequest

  it('ships Apple\'s App Attestation Root CA by default (its SHA-256 fingerprint)', () => {
    expect(new X509Certificate(prev.rootCa).fingerprint256).toBe('1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32')
    expect(prev.appId).toBe(APP_ID)
  })

  it('a challenge is 32 random bytes and needs a signed-in caller', async () => {
    const ch = await challenge()
    expect(Buffer.from(ch, 'base64url')).toHaveLength(32)
    expect(await challenge()).not.toBe(ch)
    expect((await app.inject({ method: 'GET', url: '/api/app/attest/challenge' })).statusCode).toBe(401)
  })

  it('registers a key whose attestation chains to the root, with the nonce, app id and production aaguid', async () => {
    const device = makeDevice(APP_ID)
    const ch = await challenge()
    const res = await register(device, ch, makeAttestation(ca, device, ch, { appId: APP_ID }))
    expect(res.statusCode, res.body).toBe(201)
    const [row] = await db.select().from(appAttestKeys).where(eq(appAttestKeys.keyId, device.keyId))
    expect(row).toMatchObject({ counter: 0, userId: user.id })
    expect(row.publicKey).toContain('BEGIN PUBLIC KEY')
  })

  it('refuses a wrong nonce, a wrong rpIdHash, a wrong aaguid, another CA and a counter that is not 0 (400)', async () => {
    const bad: Array<[string, (d: TestDevice, ch: string) => string]> = [
      ['nonce', (d, ch) => makeAttestation(ca, d, ch, { appId: APP_ID, nonce: Buffer.alloc(32, 7) })],
      ['rpIdHash', (d, ch) => makeAttestation(ca, d, ch, { appId: APP_ID, rpId: 'P22YGT64VU.io.virvi.ar' })],
      ['aaguid', (d, ch) => makeAttestation(ca, d, ch, { appId: APP_ID, aaguid: AAGUID.development })],
      ['another CA', (d, ch) => makeAttestation(makeTestCa(), d, ch, { appId: APP_ID })],
      ['counter', (d, ch) => makeAttestation(ca, d, ch, { appId: APP_ID, counter: 1 })],
      ['fmt', (d, ch) => makeAttestation(ca, d, ch, { appId: APP_ID, fmt: 'packed' })],
      ['not CBOR', () => Buffer.from('nope').toString('base64')],
    ]
    for (const [what, make] of bad) {
      const device = makeDevice(APP_ID)
      const ch = await challenge()
      const res = await register(device, ch, make(device, ch))
      expect([what, res.statusCode, res.json().error]).toEqual([what, 400, 'bad_attestation'])
    }
    expect(await db.select().from(appAttestKeys)).toHaveLength(0)
  })

  it('takes the development aaguid when APP_ATTEST_ENV is development', async () => {
    ;(config as any).appAttest = { ...config.appAttest, env: 'development' }
    const device = makeDevice(APP_ID)
    const ch = await challenge()
    expect((await register(device, ch, makeAttestation(ca, device, ch, { appId: APP_ID, aaguid: AAGUID.development }))).statusCode).toBe(201)
    const other = makeDevice(APP_ID)
    const ch2 = await challenge()
    expect((await register(other, ch2, makeAttestation(ca, other, ch2, { appId: APP_ID }))).statusCode).toBe(400)
  })

  it('takes the development aaguid in a production server only when APP_ATTEST_ALLOW_DEVELOPMENT is on, and still the production one', async () => {
    const dev = makeDevice(APP_ID)
    const ch = await challenge()
    const refused = await register(dev, ch, makeAttestation(ca, dev, ch, { appId: APP_ID, aaguid: AAGUID.development }))
    expect([refused.statusCode, refused.json().error]).toEqual([400, 'bad_attestation'])

    ;(config as any).appAttest = { ...config.appAttest, allowDevelopment: true }
    const ch2 = await challenge()
    expect((await register(dev, ch2, makeAttestation(ca, dev, ch2, { appId: APP_ID, aaguid: AAGUID.development }))).statusCode).toBe(201)
    const prod = makeDevice(APP_ID)
    const ch3 = await challenge()
    expect((await register(prod, ch3, makeAttestation(ca, prod, ch3, { appId: APP_ID }))).statusCode).toBe(201)
    expect(appAttestFrom({}).allowDevelopment).toBe(false)
    expect(appAttestFrom({ APP_ATTEST_ALLOW_DEVELOPMENT: 'true' }).allowDevelopment).toBe(true)
  })

  it('a challenge is single use, its own caller\'s, and refused once expired (400)', async () => {
    const ch = await challenge()
    const first = makeDevice(APP_ID)
    expect((await register(first, ch, makeAttestation(ca, first, ch, { appId: APP_ID }))).statusCode).toBe(201)
    const replay = makeDevice(APP_ID)
    const again = await register(replay, ch, makeAttestation(ca, replay, ch, { appId: APP_ID }))
    expect([again.statusCode, again.json().error]).toEqual([400, 'bad_challenge'])

    const someoneElse = await createUser()
    const theirs = await challenge(someoneElse)
    const d = makeDevice(APP_ID)
    expect((await register(d, theirs, makeAttestation(ca, d, theirs, { appId: APP_ID }))).json().error).toBe('bad_challenge')

    const never = 'A'.repeat(43)
    expect((await register(d, never, makeAttestation(ca, d, never, { appId: APP_ID }))).json().error).toBe('bad_challenge')

    const old = await challenge()
    await db.update(appAttestChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appAttestChallenges.challenge, old))
    expect((await register(d, old, makeAttestation(ca, d, old, { appId: APP_ID }))).json().error).toBe('bad_challenge')
    expect(await db.select().from(appAttestKeys)).toHaveLength(1)
  })

  describe('assertions', () => {
    let device: TestDevice
    beforeEach(async () => {
      device = makeDevice(APP_ID)
      const ch = await challenge()
      expect((await register(device, ch, makeAttestation(ca, device, ch, { appId: APP_ID }))).statusCode).toBe(201)
    })

    it('a valid assertion over the raw body returns the key id and stores the counter', async () => {
      const body = '{"consentVersion":1}'
      expect(await requireAssertion(req(device.assert(body, 5)), body)).toBe(device.keyId)
      expect((await db.select().from(appAttestKeys))[0].counter).toBe(5)
    })

    it('a counter that does not increase is 401, and so is a replay', async () => {
      const body = '{}'
      const header = device.assert(body, 3)
      await requireAssertion(req(header), body)
      await expect(requireAssertion(req(header), body)).rejects.toMatchObject({ status: 401 })
      await expect(requireAssertion(req(device.assert(body, 2)), body)).rejects.toMatchObject({ status: 401 })
      await expect(requireAssertion(req(device.assert(body, 4)), body)).resolves.toBe(device.keyId)
    })

    it('another body, another key, a wrong app id, no header or an unknown key is 401', async () => {
      await expect(requireAssertion(req(device.assert('{"a":1}', 1)), '{"a":2}')).rejects.toMatchObject({ status: 401, code: 'bad_assertion' })
      const stranger = makeDevice(APP_ID)
      await expect(requireAssertion(req(stranger.assert('{}')), '{}')).rejects.toMatchObject({ status: 401 })
      const forged = `${device.keyId}.${stranger.assert('{}').split('.')[1]}`
      await expect(requireAssertion(req(forged), '{}')).rejects.toMatchObject({ status: 401 })
      await expect(requireAssertion(req(device.assert('{}', 1, 'P22YGT64VU.io.virvi.ar')), '{}')).rejects.toMatchObject({ status: 401 })
      await expect(requireAssertion(req(undefined), '{}')).rejects.toMatchObject({ status: 401, code: 'attest_required' })
      await expect(requireAssertion(req('garbage'), '{}')).rejects.toMatchObject({ status: 401 })
      // Nothing above moved the counter
      expect((await db.select().from(appAttestKeys))[0].counter).toBe(0)
    })

    it('an empty body (a DELETE) is signed as the empty string', async () => {
      await expect(requireAssertion(req(device.assert('', 1)), undefined)).resolves.toBe(device.keyId)
    })
  })

  describe('the CBOR decoder', () => {
    it('reads maps, byte and text strings, arrays and integers', () => {
      expect(decodeCbor(cbor({ a: Buffer.from([1, 2]), b: 'x', c: [0, 23, 24, 255, 65536, -1, -500] }))).toEqual({ a: Buffer.from([1, 2]), b: 'x', c: [0, 23, 24, 255, 65536, -1, -500] })
    })

    it('refuses floats, tags, simple values, indefinite lengths, truncation, trailing bytes and repeated keys', () => {
      for (const hex of ['f93c00', 'c000', 'f5', '5f4101ff', '4401', '0000', 'a16161', 'a2616101616102']) {
        expect(() => decodeCbor(Buffer.from(hex, 'hex')), hex).toThrow()
      }
    })
  })
})
