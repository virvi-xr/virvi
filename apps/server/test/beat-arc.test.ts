import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { ringCodeOf, ringPlaqueSizeMm } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatArcs, beats, beatScenes, mediaAssets } from '../src/db/schema.js'
import { paperPdf } from '../src/ar/printfiles.js'
import { BeatError } from '../src/beats/errors.js'
import { ensureBeatArc } from '../src/beats/arc.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const H = 3_600_000
const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

describe('event ARCs and their print files', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let sceneId: string
  let imageId: string
  const prev = config.beats

  beforeEach(async () => {
    await resetDb()
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon' }
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    sceneId = (await createScene(host)).scene.id
    const [m] = await db.insert(mediaAssets).values({ ownerId: host.id, filename: 'b.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'k', publicUrl: 'https://cdn.example/b.png' }).returning()
    imageId = m.id
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    await app.close()
  })

  async function seed(over: Partial<typeof beats.$inferInsert> = {}) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon', ownerUserId: host.id, name: 'Opening night', description: '', imageMediaId: imageId, status: 'paid',
      locationType: 'in_person', locationVenue: 'The Foundry', locationCity: 'Lisbon', locationCountry: 'Portugal',
      startsAt: new Date(Date.now() + H), endsAt: new Date(Date.now() + 3 * H), ...over,
    }).returning()
    await db.insert(beatScenes).values({ beatId: b.id, sceneId })
    return b
  }
  const get = (url: string, user = host) => app.inject({ method: 'GET', url, headers: as(user) })

  it('gives an in-person BEAT one printed ARC, the same on every call', async () => {
    const b = await seed()
    const a = await ensureBeatArc(b.id)
    const again = await ensureBeatArc(b.id)
    expect(again).toEqual(a)
    expect(a.code).toBe(ringCodeOf(a.ringId))
    const rows = await db.select().from(beatArcs)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ beatId: b.id, kind: 'printed', code: a.code })
  })

  it('refuses a scene BEAT, an online BEAT and an unpaid one with 409 no_arc', async () => {
    for (const over of [{ locationType: 'scene' as const }, { locationType: 'online' as const }, { status: 'draft' as const }]) {
      const b = await seed(over)
      const err = await ensureBeatArc(b.id).catch((e) => e)
      expect(err).toBeInstanceOf(BeatError)
      expect([err.status, err.code, err.message]).toEqual([409, 'no_arc', 'Only in-person BEATs have an ARC.'])
      const res = await get(`/api/beats/${b.id}/arc`)
      expect([res.statusCode, res.json().error]).toEqual([409, 'no_arc'])
    }
    expect(await db.select().from(beatArcs)).toHaveLength(0)
  })

  it('GET /arc answers the code to the host and 403 to someone who cannot run events there', async () => {
    const b = await seed()
    const res = await get(`/api/beats/${b.id}/arc`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().code).toBe((await ensureBeatArc(b.id)).code)
    const stranger = await createUser({ wallet: randomWallet() })
    expect((await get(`/api/beats/${b.id}/arc`, stranger)).statusCode).toBe(403)
    expect((await get(`/api/beats/${b.id}/arc/files`, stranger)).statusCode).toBe(403)
    expect((await get('/api/beats/not-a-uuid/arc')).statusCode).toBe(404)
  })

  it('the PDF carries the event-ARC copy with the venue, named virvi-arc-<code>-beat.pdf', async () => {
    const b = await seed()
    const res = await get(`/api/beats/${b.id}/arc/files`)
    expect(res.statusCode, res.body).toBe(200)
    const { code } = await ensureBeatArc(b.id)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toBe(`attachment; filename="virvi-arc-${code}-beat.pdf"`)
    const text = res.rawPayload.toString('latin1')
    expect(text.startsWith('%PDF')).toBe(true)
    expect(text.replace(/\) Tj ET\nBT \/F1 [\d.]+ Tf [\d. -]+ Td \(/g, ' ')).toContain('Print this ARC and put it up at The Foundry. Visitors scan it with the Virvi app to earn this BEAT.')
    expect(text).not.toContain('1 g')
  })

  it('style=inverted fills the plaque black and adds -inverted to the name; a bad style is 400', async () => {
    const b = await seed()
    const res = await get(`/api/beats/${b.id}/arc/files?style=inverted`)
    expect(res.statusCode, res.body).toBe(200)
    const { code, ringId } = await ensureBeatArc(b.id)
    expect(res.headers['content-disposition']).toBe(`attachment; filename="virvi-arc-${code}-beat-inverted.pdf"`)
    const side = ringPlaqueSizeMm(140)
    const k = 72 / 25.4
    const n = (v: number) => String(Math.round(v * 1000) / 1000)
    const fill = `0 g\n${n(((215.9 - side) / 2) * k)} ${n(279.4 * k - (25 + side) * k)} ${n(side * k)} ${n(side * k)} re f\n1 g`
    expect(res.rawPayload.toString('latin1')).toContain(fill)
    expect(ringId).toBeGreaterThan(0)
    expect((await get(`/api/beats/${b.id}/arc/files?style=bogus`)).statusCode).toBe(400)
  })

  it('paperPdf without a caption is byte-for-byte what it was', () => {
    expect(sha(paperPdf(123456, 140))).toBe('45ff74bd8501a3ae63109fea0065a4da73b152189d198b224577182ccedd7b24')
    expect(sha(paperPdf(123456, 140, 'inverted'))).toBe('2a62b11f33de288669e3f2913c1f4102f929628e4f0d5bd7ffb61dc96db66974')
    expect(paperPdf(123456, 140, 'normal', 'Hello there').equals(paperPdf(123456, 140))).toBe(false)
  })
})
