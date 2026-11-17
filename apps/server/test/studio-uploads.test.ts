import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioUploads } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore, uploadKey } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { UPLOAD_LIMITS } from '../src/studio/uploads.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, fakeFly, issueWorker } from './helpers/studio.js'

const S = '/api/studio'
// Real images: an image is decoded on upload, so signature bytes alone are refused
const pixels = sharp(Buffer.alloc(4 * 4 * 3, 120), { raw: { width: 4, height: 4, channels: 3 } })
const PNG = await pixels.clone().png().toBuffer()
const JPEG = await pixels.clone().jpeg().toBuffer()
const WEBP = await pixels.clone().webp().toBuffer()
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0]), Buffer.alloc(64, 4)])
// Sounds: judged by their headers, stored as they are
const MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64, 1)])
const MP3_SYNC = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x44]), Buffer.alloc(64, 1)])
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 1)])
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(64, 1)])
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(64, 1)])

describe('studio uploads', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryStudioStore>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    store = memoryStudioStore()
    setStudioStore(store)
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const upload = (u: TestUser, designId: string, name: string, body: Buffer, type = 'application/octet-stream') =>
    app.inject({ method: 'POST', url: `${S}/designs/${designId}/uploads?name=${encodeURIComponent(name)}`, headers: { ...as(u), 'content-type': type }, payload: body })
  const detail = async (u: TestUser, id: string) => (await app.inject({ method: 'GET', url: `${S}/designs/${id}`, headers: as(u) })).json()

  it('stores an image and a model, lists them in the detail, and serves them only to the owner', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const img = await upload(u, d.id, 'logo.png', PNG, 'image/png')
    expect(img.statusCode).toBe(201)
    expect(img.json()).toMatchObject({ name: 'logo.png', kind: 'image', contentType: 'image/png', size: PNG.length })
    const glb = await upload(u, d.id, 'base cap.glb', GLB)
    expect(glb.json()).toMatchObject({ name: 'base-cap.glb', kind: 'model', contentType: 'model/gltf-binary' })
    expect((await upload(u, d.id, 'photo.jpg', JPEG)).json()).toMatchObject({ kind: 'image', contentType: 'image/jpeg' })
    expect((await upload(u, d.id, 'swatch.webp', WEBP)).json()).toMatchObject({ kind: 'image', contentType: 'image/webp' })

    const body = await detail(u, d.id)
    expect(body.uploads.map((x: any) => x.name)).toEqual(['logo.png', 'base-cap.glb', 'photo.jpg', 'swatch.webp'])
    expect(JSON.stringify(body.uploads)).not.toMatch(/designs\//)

    const id = img.json().id
    expect((await store.get(uploadKey(d.id, id)))?.body).toEqual(PNG)
    const got = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/uploads/${id}`, headers: as(u) })
    expect(got.statusCode).toBe(200)
    expect(got.headers['content-type']).toBe('image/png')
    expect(got.rawPayload).toEqual(PNG)
    const other = await createUser()
    expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/uploads/${id}`, headers: as(other) })).statusCode).toBe(404)
    expect((await upload(other, d.id, 'x.png', PNG)).statusCode).toBe(404)
  })

  it('turns other image formats into PNG the agent and the page can open', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const raw = { raw: { width: 4, height: 2, channels: 3 as const } }
    const pixels = Buffer.alloc(4 * 2 * 3, 200)
    const gif = await sharp(pixels, raw).gif().toBuffer()
    const tiff = await sharp(pixels, raw).tiff().toBuffer()
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#0ff"/></svg>')
    for (const [name, body] of [['anim.gif', gif], ['scan.tiff', tiff], ['logo.svg', svg]] as const) {
      const res = await upload(u, d.id, name, body)
      expect(res.statusCode, name).toBe(201)
      expect(res.json()).toMatchObject({ kind: 'image', contentType: 'image/png', name: name.replace(/\.[a-z]+$/, '.png') })
      const stored = await store.get(uploadKey(d.id, res.json().id))
      expect((await sharp(stored!.body).metadata()).format).toBe('png')
    }
    // a vector logo becomes a texture-sized picture
    const logo = (await upload(u, d.id, 'logo2.svg', svg)).json()
    expect((await sharp((await store.get(uploadKey(d.id, logo.id)))!.body).metadata()).width).toBe(2048)
  })

  it('takes the 3D formats Blender opens, judged by their contents', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const fbx = Buffer.concat([Buffer.from('Kaydara FBX Binary  \0'), Buffer.alloc(64, 5)])
    const obj = Buffer.from('# cap\nmtllib cap.mtl\no Cap\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nf 1 2 3\n')
    const stl = Buffer.alloc(84 + 50)
    stl.writeUInt32LE(1, 80)
    const blend = Buffer.concat([Buffer.from('BLENDER-v404'), Buffer.alloc(64, 6)])
    const cases = [['avatar.vrm', GLB, 'avatar.vrm'], ['shoe.fbx', fbx, 'shoe.fbx'], ['cap.obj', obj, 'cap.obj'], ['ring.stl', stl, 'ring.stl'], ['hat.blend', blend, 'hat.blend']] as const
    for (const [name, body, stored] of cases) {
      const res = await upload(u, d.id, name, body)
      expect(res.statusCode, name).toBe(201)
      expect(res.json()).toMatchObject({ kind: 'model', name: stored })
    }
    // a text file is not an OBJ for being named one
    expect((await upload(u, d.id, 'notes.obj', Buffer.from('hello there\nthis is not a mesh\n'))).statusCode).toBe(400)
  })

  it('shrinks big images to texture size, keeps the stored file under the limit, and refuses absurd ones', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const big = await sharp({ create: { width: 6000, height: 3000, channels: 3, background: '#808080' } }).tiff({ compression: 'jpeg' }).toBuffer()
    const res = await upload(u, d.id, 'scan.tiff', big)
    expect(res.statusCode).toBe(201)
    const stored = (await store.get(uploadKey(d.id, res.json().id)))!.body
    const meta = await sharp(stored).metadata()
    expect([meta.width, meta.height]).toEqual([4096, 2048])
    expect(res.json().size).toBe(stored.length)
    // a kept format that is too big on its long side is shrunk too, in its own format
    const wide = await sharp({ create: { width: 5000, height: 100, channels: 3, background: '#fff' } }).jpeg().toBuffer()
    const kept = await upload(u, d.id, 'wide.jpg', wide)
    expect(kept.json()).toMatchObject({ contentType: 'image/jpeg' })
    expect((await sharp((await store.get(uploadKey(d.id, kept.json().id)))!.body).metadata()).width).toBe(4096)
    // more pixels than any texture needs (a decompression bomb) is refused without decoding it
    const bomb = await sharp({ create: { width: 12000, height: 12000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer()
    const refused = await upload(u, d.id, 'bomb.png', bomb)
    expect(refused.statusCode).toBe(413)
    expect(refused.json().code).toBe('image_too_large')
  })

  it('draws a small vector logo at full texture size', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const icon = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#f0f"/></svg>')
    const res = await upload(u, d.id, 'icon.svg', icon)
    expect(res.statusCode).toBe(201)
    expect((await sharp((await store.get(uploadKey(d.id, res.json().id)))!.body).metadata()).width).toBe(2048)
  })

  it('keeps no row when storing the file fails', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const put = store.put
    store.put = async () => { throw new Error('bucket down') }
    try {
      const res = await upload(u, d.id, 'logo.png', PNG)
      expect(res.statusCode).toBe(500)
    } finally {
      store.put = put
    }
    expect(await db.select().from(studioUploads)).toHaveLength(0)
    expect((await upload(u, d.id, 'logo.png', PNG)).json().name).toBe('logo.png')
  })

  it('takes the sound formats, judged by their contents', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const cases: [string, Buffer, string, string][] = [
      ['fart.mp3', MP3_ID3, 'audio/mpeg', 'fart.mp3'], ['pop.mp3', MP3_SYNC, 'audio/mpeg', 'pop.mp3'],
      ['a.ogg', OGG, 'audio/ogg', 'a.ogg'], ['b.wav', WAV, 'audio/wav', 'b.wav'], ['c.m4a', M4A, 'audio/mp4', 'c.m4a'],
    ]
    for (const [name, body, contentType, stored] of cases) {
      const res = await upload(u, d.id, name, body)
      expect(res.statusCode, name).toBe(201)
      expect(res.json()).toMatchObject({ name: stored, kind: 'audio', contentType, size: body.length })
      expect((await store.get(uploadKey(d.id, res.json().id)))!.body).toEqual(body)
    }
  })

  it('refuses files that only look like audio by name', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    for (const [name, body] of [['notes.mp3', Buffer.from('hello')], ['clip.mp4', M4A]] as const) {
      const res = await upload(u, d.id, name, body)
      expect(res.statusCode, name).toBe(400)
      expect(res.json().code).toBe('unsupported_file')
    }
  })

  it('takes sounds up to 15 MB', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    expect(UPLOAD_LIMITS.audioBytes).toBe(15 * 1024 * 1024)
    const memo = (size: number) => Buffer.concat([WAV, Buffer.alloc(size - WAV.length)])
    expect((await upload(u, d.id, 'memo.wav', memo(UPLOAD_LIMITS.audioBytes - 1024))).statusCode).toBe(201)
    const over = await upload(u, d.id, 'memo2.wav', memo(UPLOAD_LIMITS.audioBytes + 1))
    expect(over.statusCode).toBe(413)
    expect(over.json().code).toBe('file_too_large')
  })

  it('names a nameless sound', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    expect((await upload(u, d.id, '.ogg', OGG)).json().name).toBe('sound.ogg')
  })

  it('judges a file by its bytes, not its name', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const fake = await upload(u, d.id, 'logo.png', Buffer.from('just some text, not a picture'), 'image/png')
    expect(fake.statusCode).toBe(400)
    expect(fake.json().code).toBe('unsupported_file')
    // a real PNG named .glb keeps its own kind and gets a matching extension
    expect((await upload(u, d.id, 'cap.glb', PNG)).json()).toMatchObject({ name: 'cap.png', kind: 'image' })
    expect((await upload(u, d.id, 'empty.png', Buffer.alloc(0))).statusCode).toBe(400)
  })

  it('refuses files over the size limits and past the per-design count', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const big = Buffer.concat([PNG, Buffer.alloc(UPLOAD_LIMITS.imageBytes)])
    const tooBig = await upload(u, d.id, 'big.png', big)
    expect(tooBig.statusCode).toBe(413)
    expect(tooBig.json().code).toBe('file_too_large')
    expect((await upload(u, d.id, 'big.glb', Buffer.concat([GLB, Buffer.alloc(UPLOAD_LIMITS.modelBytes)]))).json().code).toBe('file_too_large')
    for (let i = 0; i < UPLOAD_LIMITS.perDesign; i++) expect((await upload(u, d.id, `l${i}.png`, PNG)).statusCode).toBe(201)
    const more = await upload(u, d.id, 'one-more.png', PNG)
    expect(more.statusCode).toBe(409)
    expect(more.json().code).toBe('too_many_uploads')
  })

  it('cleans names and keeps them unique within a design', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    expect((await upload(u, d.id, '../../My Logo (final).PNG', PNG)).json().name).toBe('My-Logo-final.png')
    expect((await upload(u, d.id, 'My Logo final.png', PNG)).json().name).toBe('My-Logo-final-2.png')
    expect((await upload(u, d.id, '', PNG)).json().name).toBe('image.png')
    // names the worker would refuse never get stored: a camera's leading underscore, doubled dots
    expect((await upload(u, d.id, '_DSC0042.JPG', JPEG)).json().name).toBe('DSC0042.jpg')
    expect((await upload(u, d.id, 'logo..final.png', PNG)).json().name).toBe('logo.final.png')
    expect((await upload(u, d.id, '...', PNG)).json().name).toBe('image-2.png')
  })

  it('takes no uploads on an archived design', async () => {
    const u = await createUser()
    const d = await createDesign(u, { archivedAt: new Date() })
    const res = await upload(u, d.id, 'logo.png', PNG)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('archived')
  })

  it('deletes an upload and its file', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const id = (await upload(u, d.id, 'logo.png', PNG)).json().id
    const other = await createUser()
    expect((await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/uploads/${id}`, headers: as(other) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/uploads/${id}`, headers: as(u) })).statusCode).toBe(204)
    expect(await db.select().from(studioUploads)).toHaveLength(0)
    expect(await store.get(uploadKey(d.id, id))).toBeNull()
  })

  it('a prompt job lists the uploads, and its worker reads exactly those', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const logo = (await upload(u, d.id, 'logo.png', PNG)).json()
    await upload(u, d.id, 'base.glb', GLB)
    await upload(u, d.id, 'fart.mp3', MP3_ID3)
    const jobId = (await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompts`, headers: as(u), payload: { text: 'a tee with my logo on the chest' } })).json().jobId
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    expect((job.payload as any).uploads).toEqual([
      { path: `uploads/${logo.id}/logo.png`, name: 'logo.png', kind: 'image' },
      { path: expect.stringMatching(/^uploads\/[0-9a-f-]{36}\/base\.glb$/), name: 'base.glb', kind: 'model' },
      { path: expect.stringMatching(/^uploads\/[0-9a-f-]{36}\/fart\.mp3$/), name: 'fart.mp3', kind: 'audio' },
    ])

    const [design] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id))
    const token = await issueWorker(design, design.machineId ?? 'm-test')
    const read = (path: string) => app.inject({ method: 'GET', url: `/api/studio/worker/jobs/${jobId}/inputs/${path}`, headers: { authorization: `Bearer ${token}` } })
    expect((await read(`uploads/${logo.id}/logo.png`)).statusCode).toBe(404) // not taken yet
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
    const ok = await read(`uploads/${logo.id}/logo.png`)
    expect(ok.statusCode).toBe(200)
    expect(ok.rawPayload).toEqual(PNG)
    expect((await read(`uploads/${logo.id}/other.png`)).statusCode).toBe(404)
    expect((await read('uploads/00000000-0000-4000-8000-000000000000/logo.png')).statusCode).toBe(404)
  })

  it('a design with no uploads sends an empty list', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const jobId = (await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompts`, headers: as(u), payload: { text: 'a cap' } })).json().jobId
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    expect((job.payload as any).uploads).toEqual([])
    expect((await detail(u, d.id)).uploads).toEqual([])
  })
})
