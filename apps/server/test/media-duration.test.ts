import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { eq } from 'drizzle-orm'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'
import { db } from '../src/db/connection.js'
import { mediaAssets } from '../src/db/schema.js'
import { parseDuration, probeDuration } from '../src/media/probe.js'
import { backfillVideoDurations } from '../src/media/durations.js'

const fixture = (name: string) => join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'video', name)
const mp4 = readFileSync(fixture('red.mp4'))
const webm = readFileSync(fixture('blue.webm'))

describe('parseDuration', () => {
  it('reads seconds, rounded to the millisecond', () => {
    expect(parseDuration('2.700000\n')).toBe(2.7)
    expect(parseDuration('8100.123456')).toBe(8100.123)
  })
  it('refuses anything that is not a positive length', () => {
    expect(parseDuration('N/A')).toBeNull()
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('0.000000')).toBeNull()
    expect(parseDuration('-3')).toBeNull()
  })
})

describe('probeDuration', () => {
  it('measures MP4 and WebM bytes, and a file path', async () => {
    expect(await probeDuration(mp4)).toEqual({ ok: true, seconds: expect.closeTo(2.5, 0) })
    expect(await probeDuration(webm)).toEqual({ ok: true, seconds: expect.closeTo(3, 0) })
    expect(await probeDuration(fixture('red.mp4'))).toEqual({ ok: true, seconds: expect.closeTo(2.5, 0) })
  })
  it('calls bytes that are not a video unreadable', async () => {
    expect(await probeDuration(Buffer.alloc(500, 1))).toEqual({ ok: false, reason: 'unreadable' })
  })
  it('calls a missing ffprobe unavailable', async () => {
    const was = process.env.FFPROBE_PATH
    process.env.FFPROBE_PATH = '/nonexistent/ffprobe'
    try {
      expect(await probeDuration(mp4)).toEqual({ ok: false, reason: 'unavailable' })
    } finally {
      if (was === undefined) delete process.env.FFPROBE_PATH
      else process.env.FFPROBE_PATH = was
    }
  })
})

describe('upload stores a video length', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function upload(filename: string, contentType: string, data: Buffer) {
    const user = await createUser()
    const res = await app.inject({
      method: 'POST',
      url: '/api/media/upload',
      headers: { authorization: `Bearer ${tokenFor(user)}` },
      payload: { filename, contentType, data: data.toString('base64') },
    })
    expect(res.statusCode).toBe(201)
    return res.json().asset
  }

  it('puts the length of an MP4 in metadata.duration', async () => {
    const asset = await upload('red.mp4', 'video/mp4', mp4)
    expect(asset.metadata.duration).toBeCloseTo(2.5, 0)
    const row = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, asset.id) })
    expect((row!.metadata as any).duration).toBe(asset.metadata.duration)
  })

  it('a video ffprobe cannot read still uploads, marked so the backfill skips it', async () => {
    const asset = await upload('noise.mp4', 'video/mp4', Buffer.alloc(800, 7))
    expect(asset.status).toBe('ready')
    expect(asset.metadata).toEqual({ durationProbe: 'failed' })
  })

  it('leaves images alone', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const asset = await upload('dot.png', 'image/png', png)
    expect(asset.metadata).toBeNull()
  })
})

describe('backfillVideoDurations', () => {
  beforeEach(() => resetDb())

  async function insertVideo(fields: Partial<typeof mediaAssets.$inferInsert> = {}) {
    const user = await createUser()
    const [row] = await db.insert(mediaAssets).values({
      ownerId: user.id, filename: 'old.mp4', contentType: 'video/mp4', sizeBytes: mp4.length,
      storageKey: 'k', publicUrl: fixture('red.mp4'), status: 'ready', ...fields,
    }).returning()
    return row
  }
  const get = async (id: string) => (await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, id) }))!.metadata as any

  it('fills in the length of older videos, keeping their other metadata', async () => {
    const a = await insertVideo({ metadata: { width: 16 } })
    const b = await insertVideo({ contentType: 'video/webm', publicUrl: fixture('blue.webm') })
    expect(await backfillVideoDurations()).toEqual({ measured: 2, failed: 0, stopped: false })
    expect(await get(a.id)).toEqual({ width: 16, duration: expect.closeTo(2.5, 0) })
    expect((await get(b.id)).duration).toBeCloseTo(3, 0)
  })

  it('skips videos that have a length, failed before, are not ready, and non-videos', async () => {
    await insertVideo({ metadata: { duration: 99 } })
    await insertVideo({ metadata: { durationProbe: 'failed' } })
    await insertVideo({ status: 'uploading', publicUrl: null })
    await insertVideo({ contentType: 'image/png', filename: 'a.png' })
    const calls: string[] = []
    const res = await backfillVideoDurations({ probe: async (u) => { calls.push(String(u)); return { ok: true, seconds: 1 } } })
    expect(res).toEqual({ measured: 0, failed: 0, stopped: false })
    expect(calls).toEqual([])
  })

  it('marks an unreadable video failed so it is not retried', async () => {
    const a = await insertVideo({ publicUrl: '/nonexistent/video.mp4' })
    expect(await backfillVideoDurations()).toEqual({ measured: 0, failed: 1, stopped: false })
    expect(await get(a.id)).toEqual({ durationProbe: 'failed' })
    expect(await backfillVideoDurations()).toEqual({ measured: 0, failed: 0, stopped: false })
  })

  it('stops without marking anything when ffprobe is unavailable', async () => {
    const a = await insertVideo()
    await insertVideo()
    let calls = 0
    const res = await backfillVideoDurations({ probe: async () => { calls++; return { ok: false, reason: 'unavailable' } } })
    expect(res).toEqual({ measured: 0, failed: 0, stopped: true })
    expect(calls).toBe(1)
    expect(await get(a.id)).toBeNull()
  })

  it('works through more videos than one batch', async () => {
    for (let i = 0; i < 5; i++) await insertVideo()
    const res = await backfillVideoDurations({ batch: 2, probe: async () => ({ ok: true, seconds: 4 }) })
    expect(res).toEqual({ measured: 5, failed: 0, stopped: false })
  })
})
