import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { arDevices, arSpaces, roomScans, users } from '../src/db/schema.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { issueArPass } from '../src/auth/scene-pass.js'
import { config } from '../src/config.js'
import { saveRoomScan } from '../src/routes/room-scans.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const SECRET = 'trial-headset-secret'
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

function layout(): any {
  return {
    version: 1,
    rooms: [{
      label: 'Living room',
      floor: [[0, 0], [4, 0], [4, 3], [0, 3]],
      floorY: 0,
      ceilingHeight: 2.5,
      walls: [
        { a: [0, 0], b: [4, 0], openings: [] },
        { a: [4, 0], b: [4, 3], openings: [] },
        { a: [4, 3], b: [0, 3], openings: [] },
        { a: [0, 3], b: [0, 0], openings: [] },
      ],
      objects: [],
      anchor: { source: 'quest-mruk', roomId: 'room-1', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } },
    }],
  }
}

describe('trial headsets and secret-auth scan upload', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  async function makeTrial() {
    const u = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
    const s = issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() })
    return { u, token: s.accessToken }
  }

  const start = (secret = SECRET) => app.inject({ method: 'POST', url: '/api/ar/pair', payload: { secretHash: sha256(secret), deviceName: 'Quest 3' } })
  const approve = (code: string, token: string, kind: 'personal' | 'shared') =>
    app.inject({ method: 'POST', url: `/api/ar/pair/${code}/approve`, headers: bearer(token), payload: { kind } })
  const claim = (code: string, secret = SECRET) => app.inject({ method: 'POST', url: `/api/ar/pair/${code}/claim`, payload: { secret } })
  const upload = (deviceId: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/room-scans`, payload: body })

  async function pairWith(token: string, kind: 'personal' | 'shared' = 'personal', secret = SECRET) {
    const { code } = (await start(secret)).json()
    const res = await approve(code, token, kind)
    expect(res.statusCode).toBe(200)
    const claimed = (await claim(code, secret)).json()
    expect(claimed.status).toBe('approved')
    return claimed.deviceId as string
  }

  /** A claimed headset row approved by `userId`, straight into the table. */
  async function deviceRow(userId: string, kind: 'personal' | 'shared' = 'personal', secret = SECRET) {
    const [d] = await db.insert(arDevices).values({
      userId, secretHash: sha256(secret), kind, status: 'claimed', codeExpiresAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
    }).returning()
    return d
  }

  it('a trial sees the approval page, approves its own headset as personal, lists and revokes it', async () => {
    const t = await makeTrial()
    const { code } = (await start()).json()
    const info = await app.inject({ method: 'GET', url: `/api/ar/pair/${code}`, headers: bearer(t.token) })
    expect(info.statusCode).toBe(200)
    expect(info.json().deviceName).toBe('Quest 3')
    const res = await approve(code, t.token, 'personal')
    expect([res.statusCode, res.json()]).toEqual([200, { result: 'approved' }])
    const [row] = await db.select().from(arDevices)
    expect(row.userId).toBe(t.u.id)
    expect(row.kind).toBe('personal')
    const list = await app.inject({ method: 'GET', url: '/api/ar/devices', headers: bearer(t.token) })
    expect(list.statusCode).toBe(200)
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([row.id])
    const del = await app.inject({ method: 'DELETE', url: `/api/ar/devices/${row.id}`, headers: bearer(t.token) })
    expect(del.statusCode).toBe(204)
  })

  it("a trial can't approve a shared headset", async () => {
    const t = await makeTrial()
    const { code } = (await start()).json()
    const res = await approve(code, t.token, 'shared')
    expect([res.statusCode, res.json()]).toEqual([403, { error: 'account_required', action: 'shared_headset' }])
    const [row] = await db.select().from(arDevices)
    expect(row.status).toBe('pending')
    expect(row.userId).toBeNull()
  })

  it("a trial's headset mints no pass and lists nothing, even for the trial's own scene and space", async () => {
    const t = await makeTrial()
    const { scene } = await createScene(t.u, 'Imported')
    const [space] = await db.insert(arSpaces).values({ sceneId: scene.id, name: 'Lounge' }).returning()
    const deviceId = await pairWith(t.token)
    const forScene = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/pass`, payload: { secret: SECRET, sceneId: scene.id } })
    expect([forScene.statusCode, forScene.json()]).toEqual([403, { error: 'no_access' }])
    const forSpace = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/pass`, payload: { secret: SECRET, spaceId: space.id } })
    expect([forSpace.statusCode, forSpace.json()]).toEqual([403, { error: 'no_access' }])
    const spaces = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/spaces`, payload: { secret: SECRET } })
    expect([spaces.statusCode, spaces.json()]).toEqual([200, []])
    const scenes = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/scenes`, payload: { secret: SECRET } })
    expect([scenes.statusCode, scenes.json()]).toEqual([200, []])
    // No pass means no AR feed either: every scene-pass route (feeds, drafts, adjustments) needs one this headset can't get.
    const [row] = await db.select().from(arDevices).where(eq(arDevices.id, deviceId))
    expect(row.lastUsedAt).toBeNull()
  })

  it('the same headset gets passes once its approver is no longer a trial (converted)', async () => {
    const t = await makeTrial()
    const { scene } = await createScene(t.u, 'Imported')
    const deviceId = await pairWith(t.token)
    await db.update(users).set({ isTrial: false }).where(eq(users.id, t.u.id))
    const res = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/pass`, payload: { secret: SECRET, sceneId: scene.id } })
    expect(res.statusCode).toBe(200)
  })

  it('a headset uploads a scan with its secret, to its approver only', async () => {
    const t = await makeTrial()
    const deviceId = await pairWith(t.token)
    const res = await upload(deviceId, { secret: SECRET, name: 'Lounge', layout: layout() })
    expect(res.statusCode).toBe(201)
    const [row] = await db.select().from(roomScans).where(eq(roomScans.id, res.json().scan.id))
    expect(row.userId).toBe(t.u.id)
    expect(row.name).toBe('Lounge')
    // The trial reads it back with its own token
    const list = await app.inject({ method: 'GET', url: '/api/room-scans', headers: bearer(t.token) })
    expect(list.json().scans.map((s: { id: string }) => s.id)).toEqual([row.id])

    const wrong = await upload(deviceId, { secret: 'guess', name: 'Lounge', layout: layout() })
    expect([wrong.statusCode, wrong.json()]).toEqual([401, { error: 'bad_secret' }])
    const missing = await upload(deviceId, { name: 'Lounge', layout: layout() })
    expect(missing.statusCode).toBe(400)
    const badName = await upload(deviceId, { secret: SECRET, name: '', layout: layout() })
    expect(badName.statusCode).toBe(400)
    const badLayout = await upload(deviceId, { secret: SECRET, name: 'x', layout: { version: 1, rooms: [] } })
    expect(badLayout.statusCode).toBe(400)
    expect(await db.select().from(roomScans)).toHaveLength(1)
  })

  it('a shared, revoked, expired or unknown headset uploads nothing', async () => {
    const owner = await createUser({ wallet: randomWallet() })
    const shared = await deviceRow(owner.id, 'shared')
    const s = await upload(shared.id, { secret: SECRET, name: 'Lounge', layout: layout() })
    expect([s.statusCode, s.json()]).toEqual([403, { error: 'personal_only' }])
    const revoked = await deviceRow(owner.id)
    await db.update(arDevices).set({ status: 'revoked' }).where(eq(arDevices.id, revoked.id))
    const r = await upload(revoked.id, { secret: SECRET, name: 'Lounge', layout: layout() })
    expect([r.statusCode, r.json()]).toEqual([401, { error: 'device_revoked' }])
    const expired = await deviceRow(owner.id)
    await db.update(arDevices).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(arDevices.id, expired.id))
    const e = await upload(expired.id, { secret: SECRET, name: 'Lounge', layout: layout() })
    expect([e.statusCode, e.json()]).toEqual([401, { error: 'device_revoked' }])
    const u = await upload('00000000-0000-4000-8000-000000000009', { secret: SECRET, name: 'Lounge', layout: layout() })
    expect(u.statusCode).toBe(401)
    expect(await db.select().from(roomScans)).toHaveLength(0)
  })

  it("a trial idle past its expiry (not yet swept) is a revoked headset's approver: nothing is saved", async () => {
    const t = await makeTrial()
    const d = await deviceRow(t.u.id)
    await db.update(users).set({ trialLastActiveAt: new Date(Date.now() - (config.trialIdleDays + 1) * 86400_000) }).where(eq(users.id, t.u.id))
    const res = await upload(d.id, { secret: SECRET, name: 'Lounge', layout: layout() })
    expect([res.statusCode, res.json()]).toEqual([401, { error: 'device_revoked' }])
    expect(await db.select().from(roomScans)).toHaveLength(0)
  })

  it('a scan for an approver whose row is gone (the sweep won the race) is refused, not a 500', async () => {
    const saved = await saveRoomScan('00000000-0000-4000-8000-00000000000a', 'Lounge', layout())
    expect(saved).toEqual({ status: 401, body: { error: 'device_revoked' } })
    expect(await db.select().from(roomScans)).toHaveLength(0)
  })

  it("an account's personal headset uploads with its secret too, to the account", async () => {
    const owner = await createUser({ wallet: randomWallet() })
    const d = await deviceRow(owner.id)
    const res = await upload(d.id, { secret: SECRET, name: 'Den', layout: layout() })
    expect(res.statusCode).toBe(201)
    const [row] = await db.select().from(roomScans)
    expect(row.userId).toBe(owner.id)
  })

  it('an oversized upload body is refused before it is read', async () => {
    const t = await makeTrial()
    const d = await deviceRow(t.u.id)
    const res = await upload(d.id, { secret: SECRET, name: 'Big', layout: layout(), pad: 'x'.repeat(1_100_000) })
    expect(res.statusCode).toBe(413)
    expect(await db.select().from(roomScans)).toHaveLength(0)
  })

  it(`a trial holds ${config.trialRoomScans} scans; deleting one makes room`, async () => {
    expect(config.trialRoomScans).toBe(5)
    const t = await makeTrial()
    const d = await deviceRow(t.u.id)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const res = await upload(d.id, { secret: SECRET, name: `Room ${i}`, layout: layout() })
      expect(res.statusCode).toBe(201)
      ids.push(res.json().scan.id)
    }
    const sixth = await upload(d.id, { secret: SECRET, name: 'Room 6', layout: layout() })
    expect([sixth.statusCode, sixth.json()]).toEqual([403, { error: 'account_required', action: 'more_scans' }])
    expect(await db.select().from(roomScans)).toHaveLength(5)
    const del = await app.inject({ method: 'DELETE', url: `/api/room-scans/${ids[0]}`, headers: bearer(t.token) })
    expect(del.statusCode).toBe(204)
    const next = await upload(d.id, { secret: SECRET, name: 'Room 7', layout: layout() })
    expect(next.statusCode).toBe(201)
  })

  it('uploads at once with one scan slot left: exactly one is saved', async () => {
    const t = await makeTrial()
    const d = await deviceRow(t.u.id)
    await db.insert(roomScans).values(Array.from({ length: 4 }, (_, i) => ({ userId: t.u.id, name: `Old ${i}`, source: 'quest-mruk', layout: layout() })))
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => upload(d.id, { secret: SECRET, name: `New ${i}`, layout: layout() })))
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403, 403, 403])
    expect(await db.select().from(roomScans).where(eq(roomScans.userId, t.u.id))).toHaveLength(5)
  })

  it('saveRoomScan at once with one slot left: exactly one is saved', async () => {
    const t = await makeTrial()
    await db.insert(roomScans).values(Array.from({ length: 4 }, (_, i) => ({ userId: t.u.id, name: `Old ${i}`, source: 'quest-mruk', layout: layout() })))
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => saveRoomScan(t.u.id, `New ${i}`, layout())))
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(await db.select().from(roomScans).where(eq(roomScans.userId, t.u.id))).toHaveLength(5)
  })

  it('an account has no scan cap', async () => {
    const owner = await createUser({ wallet: randomWallet() })
    const d = await deviceRow(owner.id)
    await db.insert(roomScans).values(Array.from({ length: 6 }, (_, i) => ({ userId: owner.id, name: `Old ${i}`, source: 'quest-mruk', layout: layout() })))
    const res = await upload(d.id, { secret: SECRET, name: 'Seventh', layout: layout() })
    expect(res.statusCode).toBe(201)
  })

  it("an account's headset still uploads through a pass", async () => {
    const owner = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(owner)
    const d = await deviceRow(owner.id)
    const { pass } = issueArPass(app, owner, owner.wallet ?? null, { deviceId: d.id, sceneId: scene.id })
    const res = await app.inject({ method: 'POST', url: '/api/ar/room-scans', headers: bearer(pass), payload: { name: 'Lounge', layout: layout() } })
    expect(res.statusCode).toBe(201)
    const [row] = await db.select().from(roomScans)
    expect(row.userId).toBe(owner.id)
  })

  it('an account approving still needs a verified account, and can approve shared', async () => {
    const owner: TestUser = await createUser({ wallet: randomWallet() })
    const { code } = (await start()).json()
    const res = await approve(code, tokenFor(owner), 'shared')
    expect(res.statusCode).toBe(200)
  })
})
