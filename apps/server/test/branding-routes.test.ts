import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import sharp from 'sharp'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { setBrandingStorage } from '../src/branding/store.js'
import type { StorageProvider } from '../src/storage/index.js'

function memoryStorage() {
  const files = new Map<string, { data: Buffer; contentType: string }>()
  const s: StorageProvider & { files: typeof files } = {
    files,
    async upload(key, data, contentType) { files.set(key, { data, contentType }); return s.getPublicUrl(key) },
    async delete(key) { files.delete(key) },
    getPublicUrl: (key) => `https://cdn.test/${key}`,
  }
  return s
}

const b64 = (b: Buffer) => b.toString('base64')
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: '#123456' } }).png().toBuffer()

describe('instance branding', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let admin: TestUser
  let creator: TestUser
  let storage: ReturnType<typeof memoryStorage>
  const original = config.mode

  beforeEach(async () => {
    await resetDb()
    ;(config as any).mode = 'single'
    storage = memoryStorage()
    setBrandingStorage(storage)
    app = await testApp()
    admin = await createUser({ role: 'admin' })
    creator = await createUser({ role: 'creator' })
  })
  afterEach(async () => {
    ;(config as any).mode = original
    setBrandingStorage(null)
    await app.close()
  })

  const put = (user: TestUser, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/api/instance/branding', headers: { authorization: `Bearer ${tokenFor(user)}` }, payload })
  const instance = async () => (await app.inject({ method: 'GET', url: '/api/instance' })).json()

  it('starts with no branding, publicly', async () => {
    expect(await instance()).toMatchObject({ mode: 'single', name: null, logoUrl: null, faviconUrl: null })
  })

  it('lets an admin set a name, logo and favicon, and shows them to anyone', async () => {
    const res = await put(admin, { name: ' Acme Events ', logo: b64(await png(400, 100)), favicon: b64(await png(128, 128)) })
    expect(res.statusCode).toBe(200)
    const body = await instance()
    expect(body.name).toBe('Acme Events')
    expect(body.logoUrl).toMatch(/^https:\/\/cdn\.test\/branding\/logo-[\w-]+\.png$/)
    expect(body.faviconUrl).toMatch(/^https:\/\/cdn\.test\/branding\/favicon-[\w-]+\.png$/)
    expect([...storage.files.values()].every((f) => f.contentType === 'image/png')).toBe(true)
    expect(storage.files.size).toBe(2)
  })

  it('keeps fields that are left out, and removes the old file when a logo is replaced or cleared', async () => {
    await put(admin, { name: 'Acme', logo: b64(await png(100, 25)) })
    const first = (await instance()).logoUrl
    await put(admin, { logo: b64(await png(120, 30)) })
    const second = await instance()
    expect(second.name).toBe('Acme')
    expect(second.logoUrl).not.toBe(first)
    expect(storage.files.size).toBe(1)
    await put(admin, { logo: null })
    expect((await instance()).logoUrl).toBeNull()
    expect(storage.files.size).toBe(0)
  })

  it('resets everything back to Virvi', async () => {
    await put(admin, { name: 'Acme', logo: b64(await png(100, 25)), favicon: b64(await png(64, 64)) })
    const res = await app.inject({ method: 'DELETE', url: '/api/instance/branding', headers: { authorization: `Bearer ${tokenFor(admin)}` } })
    expect(res.statusCode).toBe(204)
    expect(await instance()).toMatchObject({ name: null, logoUrl: null, faviconUrl: null })
    expect(storage.files.size).toBe(0)
  })

  it('refuses non-admins and signed-out callers', async () => {
    expect((await put(creator, { name: 'Nope' })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: '/api/instance/branding', headers: { authorization: `Bearer ${tokenFor(creator)}` } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/api/instance/branding', payload: { name: 'x' } })).statusCode).toBe(401)
    expect((await instance()).name).toBeNull()
  })

  it('rejects bad files with a clear message and changes nothing', async () => {
    await put(admin, { name: 'Acme' })
    const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>')
    const res = await put(admin, { name: 'Changed', logo: b64(evil) })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'svg_external', message: expect.stringContaining('SVG') })
    const big = await put(admin, { logo: b64(Buffer.alloc(600 * 1024, 1)) })
    expect(big.statusCode).toBe(413)
    expect(big.json().message).toMatch(/512 KB/)
    const wrong = await put(admin, { favicon: b64(Buffer.from('hello')) })
    expect(wrong.statusCode).toBe(415)
    expect((await put(admin, { name: 'x'.repeat(40) })).statusCode).toBe(400)
    expect((await instance()).name).toBe('Acme')
    expect(storage.files.size).toBe(0)
  })

  it('ignores branding in cloud mode: nothing returned, and the routes are not there', async () => {
    await put(admin, { name: 'Acme', logo: b64(await png(100, 25)) })
    ;(config as any).mode = 'cloud'
    expect(await instance()).toMatchObject({ mode: 'cloud', name: null, logoUrl: null, faviconUrl: null })
    expect((await put(admin, { name: 'x' })).statusCode).toBe(404)
  })
})

describe('uploaded files', () => {
  it('are served with nosniff, so a browser never guesses another type', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { resolve, join } = await import('node:path')
    const dir = join(resolve(process.env.LOCAL_STORAGE_PATH || './uploads'), 'branding-test')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'logo.png'), await png(4, 4))
    const app = await testApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/uploads/branding-test/logo.png' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('image/png')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    } finally {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
