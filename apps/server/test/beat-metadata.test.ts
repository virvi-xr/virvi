import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beats, beatScenes, mediaAssets } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const H = 3_600_000
const ONE_HEX = '0'.repeat(63) + '1'

describe('BEAT public metadata (LIV-11)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let sceneId: string
  let imageId: string
  const prev = config.beats

  beforeEach(async () => {
    await resetDb()
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon-amoy' }
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    sceneId = (await createScene(host)).scene.id
    const [m] = await db.insert(mediaAssets).values({ ownerId: host.id, filename: 'b.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'k', publicUrl: 'https://cdn.example/live.png' }).returning()
    imageId = m.id
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    await app.close()
  })

  async function seed(over: Partial<typeof beats.$inferInsert> = {}) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon-amoy', ownerUserId: host.id, name: 'Opening night', description: 'Thanks for coming', imageMediaId: imageId,
      imageUrl: 'https://cdn.example/beats/polygon-amoy/1-x.png', tokenId: 1, status: 'live', tradeable: false,
      startsAt: new Date('2026-12-01T20:00:00Z'), endsAt: new Date('2026-12-01T22:00:00Z'), ...over,
    }).returning()
    await db.insert(beatScenes).values({ beatId: b.id, sceneId })
    return b
  }
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers })
  const meta = (chain: string, file: string) => get(`/api/beats/metadata/${chain}/${file}`)

  it('decimal and 64-hex file names return the same JSON, public, CORS *, cached 5 minutes', async () => {
    await seed()
    const dec = await meta('polygon-amoy', '1.json')
    expect(dec.statusCode, dec.body).toBe(200)
    expect(dec.headers['access-control-allow-origin']).toBe('*')
    expect(String(dec.headers['content-type'])).toMatch(/^application\/json/)
    expect(dec.headers['cache-control']).toBe('public, max-age=300')
    expect(dec.json()).toEqual({
      name: 'Opening night',
      description: 'Thanks for coming',
      image: 'https://cdn.example/beats/polygon-amoy/1-x.png',
      external_url: 'https://virvi.io/beats',
      attributes: [
        { trait_type: 'Starts', display_type: 'date', value: Date.parse('2026-12-01T20:00:00Z') / 1000 },
        { trait_type: 'Ends', display_type: 'date', value: Date.parse('2026-12-01T22:00:00Z') / 1000 },
        { trait_type: 'Tradeable', value: 'No' },
      ],
    })
    const hex = await meta('polygon-amoy', `${ONE_HEX}.json`)
    expect(hex.statusCode).toBe(200)
    expect(hex.body).toBe(dec.body)
    // CORS * even when a browser sends an Origin
    expect((await get('/api/beats/metadata/polygon-amoy/1.json', { origin: 'https://opensea.io' })).headers['access-control-allow-origin']).toBe('*')
  })

  it('matches on the chain: the same id on the other chain is a different BEAT', async () => {
    await seed()
    await seed({ chain: 'polygon', name: 'Mainnet one', tradeable: true })
    expect((await meta('polygon', '1.json')).json()).toMatchObject({ name: 'Mainnet one', attributes: expect.arrayContaining([{ trait_type: 'Tradeable', value: 'Yes' }]) })
    expect((await meta('polygon-amoy', '1.json')).json().name).toBe('Opening night')
  })

  it('standards M5, M7: a cancelled BEAT already on chain keeps its metadata; an early end keeps the scheduled Ends and adds Ended early', async () => {
    await seed({ tokenId: 20, status: 'cancelled', createdOnChainTx: '0xc' })
    expect((await meta('polygon-amoy', '20.json')).statusCode).toBe(200)
    await seed({
      tokenId: 21, status: 'ended', endsAt: new Date('2026-12-01T21:00:00Z'), scheduledEndsAt: new Date('2026-12-01T22:00:00Z'),
    })
    expect((await meta('polygon-amoy', '21.json')).json().attributes).toEqual([
      { trait_type: 'Starts', display_type: 'date', value: Date.parse('2026-12-01T20:00:00Z') / 1000 },
      { trait_type: 'Ends', display_type: 'date', value: Date.parse('2026-12-01T22:00:00Z') / 1000 },
      { trait_type: 'Ended early', display_type: 'date', value: Date.parse('2026-12-01T21:00:00Z') / 1000 },
      { trait_type: 'Tradeable', value: 'No' },
    ])
  })

  it('end early records the scheduled end', async () => {
    const b = await seed({ tokenId: 22, startsAt: new Date(Date.now() - H), endsAt: new Date(Date.now() + H) })
    const res = await app.inject({ method: 'POST', url: `/api/beats/${b.id}/end-early`, headers: { authorization: `Bearer ${tokenFor(host)}` } })
    expect(res.statusCode, res.body).toBe(200)
    const row = (await db.query.beats.findFirst({ where: eq(beats.id, b.id) }))!
    expect(row.scheduledEndsAt).toEqual(b.endsAt)
    expect(row.endsAt.getTime()).toBeLessThan(b.endsAt.getTime())
    expect(res.json().scheduledEndsAt).toBe(b.endsAt.toISOString())
  })

  it('unknown, draft, paid (not yet live, so not on chain) and cancelled ids get 404', async () => {
    await seed({ tokenId: 2, status: 'draft' })
    await seed({ tokenId: 3, status: 'cancelled' })
    await seed({ tokenId: 10, status: 'paid' })
    expect((await meta('polygon-amoy', '10.json')).statusCode).toBe(404)
    await seed({ tokenId: 4, status: 'live' })
    await seed({ tokenId: 5, status: 'ended' })
    expect((await meta('polygon-amoy', '1.json')).statusCode).toBe(404)
    expect((await meta('polygon-amoy', '2.json')).statusCode).toBe(404)
    expect((await meta('polygon-amoy', '3.json')).statusCode).toBe(404)
    expect((await meta('polygon-amoy', '4.json')).statusCode).toBe(200)
    expect((await meta('polygon-amoy', '5.json')).statusCode).toBe(200)
    expect((await meta('ethereum', '4.json')).statusCode).toBe(404)
  })

  it('a bad file name gets 404', async () => {
    await seed()
    for (const file of ['1', '1.JSON', '01.json', '-1.json', '1.5.json', 'abc.json', `${'0'.repeat(62)}1.json`, `${ONE_HEX.toUpperCase().replace('1', 'A')}.json`,
      `${'0'.repeat(63)}G.json`, '9223372036854775808.json', `${'f'.repeat(64)}.json`, '.json', '1.json.json']) {
      expect([file, (await meta('polygon-amoy', encodeURIComponent(file))).statusCode]).toEqual([file, 404])
    }
  })

  it('falls back to the live media URL, then the Virvi logo, so the image is always absolute', async () => {
    await seed({ tokenId: 6, imageUrl: null })
    expect((await meta('polygon-amoy', '6.json')).json().image).toBe('https://cdn.example/live.png')
    await seed({ tokenId: 7, imageUrl: null, imageMediaId: null })
    const logo = (await meta('polygon-amoy', '7.json')).json().image
    expect(logo).toMatch(/^https?:\/\/[^/]+\/.+\.(png|svg)$/)
    const [rel] = await db.insert(mediaAssets).values({ ownerId: host.id, filename: 'r.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'k2', publicUrl: '/uploads/r.png' }).returning()
    await seed({ tokenId: 8, imageUrl: null, imageMediaId: rel.id })
    expect((await meta('polygon-amoy', '8.json')).json().image).toMatch(/^https?:\/\/[^/]+\/uploads\/r\.png$/)
  })

  it('a frozen BEAT refuses a PATCH of its name (locked) and its metadata is unchanged', async () => {
    const b = await seed({ tokenId: 9, frozenAt: new Date(), startsAt: new Date(Date.now() + 10 * H), endsAt: new Date(Date.now() + 12 * H) })
    const before = (await meta('polygon-amoy', '9.json')).body
    const res = await app.inject({ method: 'PATCH', url: `/api/beats/${b.id}`, headers: { authorization: `Bearer ${tokenFor(host)}` }, payload: { name: 'Renamed' } })
    expect([res.statusCode, res.json().error]).toEqual([409, 'locked'])
    expect((await meta('polygon-amoy', '9.json')).body).toBe(before)
    expect((await db.query.beats.findFirst({ where: eq(beats.id, b.id) }))!.name).toBe('Opening night')
  })

  it('serves the ERC-7572 collection metadata as contract.json', async () => {
    const res = await meta('polygon', 'contract.json')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['cache-control']).toBe('public, max-age=300')
    const body = res.json()
    expect(body).toMatchObject({ name: 'Virvi BEAT', external_link: 'https://virvi.io' })
    expect(body.description).toBe('BEATs are free tokens that show you were at a Virvi event.')
    expect(body.image).toMatch(/^https?:\/\/[^/]+\/.+\.(png|svg)$/)
    expect((await meta('ethereum', 'contract.json')).statusCode).toBe(404)
  })

  it('answers 404 while BEATs are off', async () => {
    await seed()
    ;(config as any).beats = { ...config.beats, enabled: false }
    expect((await meta('polygon-amoy', '1.json')).statusCode).toBe(404)
    expect((await meta('polygon-amoy', 'contract.json')).statusCode).toBe(404)
  })
})
