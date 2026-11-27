import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, bookings, catalogPacks, hyperfyWorlds, sceneElements, sceneLibrary } from '../src/db/schema.js'
import { createWorldKey } from '../src/hyperfy/worlds.js'
import { createVenue, createBooking } from '../src/venues/service.js'
import { sceneSnapshot } from '../src/hyperfy/snapshot.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor, randomWallet, type TestUser } from './helpers/factories.js'

const H = 3600_000
const SECRET = 'browser-secret-1'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

describe('Hyperfy HUD edit routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  /** A real Hyperfy pass: start, approve as `user`, claim. */
  async function hyperfyPass(user: TestUser, sceneId: string, ownerId: string) {
    const key = createWorldKey()
    await db.insert(hyperfyWorlds).values({ sceneId, ownerId, name: 'Arbor World', keyHash: key.hash, keyPrefix: key.prefix })
    const started = await app.inject({ method: 'POST', url: '/api/hyperfy/pair', payload: { worldKey: key.raw, secretHash: sha256(SECRET), playerName: 'Pip' } })
    const { code } = started.json()
    const approve = await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${code}/approve`, headers: bearer(tokenFor(user)) })
    expect(approve.json()).toEqual({ result: 'approved' })
    const claimed = (await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${code}/claim`, payload: { secret: SECRET } })).json()
    expect(claimed.status).toBe('approved')
    return claimed.pass as string
  }
  const live = (token: string, id: string, enabled: unknown) =>
    app.inject({ method: 'POST', url: `/api/elements/${id}/live`, headers: bearer(token), payload: { enabled } })

  it('a hyperfy pass toggles a stream on and off and the snapshot follows', async () => {
    const owner = await createUser({ wallet: randomWallet() })
    const { scene, preset } = await createScene(owner)
    const screen = await createElement(preset.id, { type: 'video', properties: { liveSrc: 'https://x/l.m3u8', enableLiveStream: false } })
    const pass = await hyperfyPass(owner, scene.id, owner.id)
    const before = await sceneSnapshot(scene.id)

    const on = await live(pass, screen.id, true)
    expect(on.statusCode).toBe(200)
    expect(on.json().element.id).toBe(screen.id)
    expect(on.json().element.properties.enableLiveStream).toBe(true)
    const after = await sceneSnapshot(scene.id)
    expect(after!.version).not.toBe(before!.version)
    expect(after!.scene!.videos[0].enableLiveStream).toBe(true)

    const off = await live(pass, screen.id, false)
    expect(off.statusCode).toBe(200)
    expect((await sceneSnapshot(scene.id))!.scene!.videos[0].enableLiveStream).toBe(false)
    expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, screen.id) }))!.properties).toMatchObject({ liveSrc: 'https://x/l.m3u8', enableLiveStream: false })
    expect((await live(pass, screen.id, 'yes')).statusCode).toBe(400)
  })

  it("a hyperfy pass sets an object's click action, the snapshot carries it, and a bad one is refused with a reason (LIV-126)", async () => {
    const owner = await createUser({ wallet: randomWallet() })
    const { scene, preset } = await createScene(owner)
    const poster = await createElement(preset.id, { type: 'image', name: 'Poster', properties: { textureSrc: 'https://x/a.png' } })
    const pass = await hyperfyPass(owner, scene.id, owner.id)
    const put = (clickEvent: unknown) => app.inject({ method: 'PUT', url: `/api/elements/${poster.id}`, headers: bearer(pass), payload: { clickEvent } })

    const move = { type: 4, moveTo: { position: { x: 8, y: 0, z: 4 } }, showFeedback: false }
    expect((await put(move)).statusCode).toBe(200)
    expect((await sceneSnapshot(scene.id))!.scene!.images[0].clickEvent).toEqual(move)
    const bad = await put({ type: 1, externalLink: 'javascript:alert(1)' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: 'bad_click', message: 'A link must start with https:// or http://.' })
    expect((await put(null)).statusCode).toBe(200)
    expect((await sceneSnapshot(scene.id))!.scene!.images[0].clickEvent ?? null).toBeNull()
    // The image's own properties are untouched
    expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, poster.id) }))!.properties).toMatchObject({ textureSrc: 'https://x/a.png' })
  })

  it('a booking host can toggle only during their booking and only rentable screens', async () => {
    const admin = await createUser({ role: 'admin' })
    const { scene, preset } = await createScene(admin)
    const screen = await createElement(preset.id)
    const side = await createElement(preset.id, { name: 'Side Screen' })
    const venue = await createVenue({ sceneId: scene.id, name: 'Aurora', slug: `aurora-${crypto.randomUUID()}`, rentableElementIds: [screen.id] })
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const startsAt = new Date(Date.now() + 24 * H)
    const { booking } = await createBooking({
      venueId: venue.id, renterWallet: hostWallet, title: 'Set', startsAt, endsAt: new Date(startsAt.getTime() + 2 * H), createdByUserId: admin.id,
    })
    const clones = await db.select().from(sceneElements).where(eq(sceneElements.presetId, booking.bookingPresetId!))
    const clone = clones.find((c) => c.clonedFromId === screen.id)!
    const sideClone = clones.find((c) => c.clonedFromId === side.id)!
    const pass = await hyperfyPass(host, scene.id, admin.id)

    // setup window: not live yet
    expect((await live(pass, clone.id, true)).statusCode).toBe(403)

    await db.update(bookings).set({ startsAt: new Date(Date.now() - 10 * 60_000), endsAt: new Date(Date.now() + 2 * H) }).where(eq(bookings.id, booking.id))
    const ok = await live(pass, clone.id, true)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().element.properties.enableLiveStream).toBe(true)
    expect((await live(pass, sideClone.id, true)).statusCode).toBe(403) // not rentable
    expect((await live(pass, screen.id, true)).statusCode).toBe(403) // the venue's own screen, outside the booking preset

    await db.update(bookings).set({ startsAt: new Date(Date.now() - 4 * H), endsAt: new Date(Date.now() - 2 * H) }).where(eq(bookings.id, booking.id))
    expect((await live(pass, clone.id, false)).statusCode).toBe(403)
  })

  it('a non-video element is 400', async () => {
    const owner = await createUser({ wallet: randomWallet() })
    const { scene, preset } = await createScene(owner)
    const img = await createElement(preset.id, { type: 'image', properties: {} })
    const pass = await hyperfyPass(owner, scene.id, owner.id)
    expect((await live(pass, img.id, true)).statusCode).toBe(400)
  })

  it('a hyperfy pass can add a catalog model to the scene library', async () => {
    const owner = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(owner)
    await db.insert(catalogPacks).values({ id: 'pack-1', name: 'Pack', source: 'dhingia', license: 'mit', attribution: 'x', sourceUrl: 'https://x' })
    const [item] = await db.insert(assetLibraryItems).values({ name: 'Tree', storageKey: 'catalog/tree.glb', cdnUrl: 'https://cdn/tree.glb', isPublic: true, packId: 'pack-1' }).returning()
    const pass = await hyperfyPass(owner, scene.id, owner.id)
    const res = await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/library`, headers: bearer(pass), payload: { assetItemId: item.id } })
    expect(res.statusCode).toBe(201)
    expect(await db.query.sceneLibrary.findFirst({ where: eq(sceneLibrary.id, res.json().id) })).toMatchObject({ sceneId: scene.id })
    // another scene's id is refused by the pass binding
    const other = await createScene(owner, 'Other')
    expect((await app.inject({ method: 'POST', url: `/api/scenes/${other.scene.id}/library`, headers: bearer(pass), payload: { assetItemId: item.id } })).statusCode).toBe(403)
  })
})
