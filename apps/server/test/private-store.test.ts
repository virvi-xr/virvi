import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { config } from '../src/config.js'
import { memoryPrivateStore, privateStoreFromUri, getImportStore, setImportStore, type PrivateStore } from '../src/storage/private-store.js'

async function read(body: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of body) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString()
}

describe.each<[string, () => PrivateStore]>([
  ['memory', () => memoryPrivateStore()],
  ['file', () => privateStoreFromUri(`file://${mkdtempSync(join(tmpdir(), 'private-store-'))}`)],
])('%s private store', (_name, make) => {
  it('round-trips put/get and putStream/getStream', async () => {
    const s = make()
    await s.put('imports/a/source.zip', Buffer.from('zip'), 'application/zip')
    expect(await s.get('imports/a/source.zip')).toEqual({ body: Buffer.from('zip'), contentType: 'application/zip' })
    expect(await s.get('imports/a/nope')).toBeNull()
    await s.putStream('imports/a/big', Readable.from([Buffer.from('he'), Buffer.from('llo')]), 5, 'text/plain')
    const st = await s.getStream('imports/a/big')
    expect(st!.contentType).toBe('text/plain')
    expect(await read(st!.body)).toBe('hello')
    expect(await s.getStream('imports/a/nope')).toBeNull()
  })

  it('deletePrefix removes only that prefix and counts', async () => {
    const s = make()
    await s.put('imports/a/one', Buffer.from('1'), 'text/plain')
    await s.put('imports/a/dir/two', Buffer.from('2'), 'text/plain')
    await s.put('imports/b/three', Buffer.from('3'), 'text/plain')
    expect(await s.deletePrefix('imports/a/')).toBe(2)
    expect(await s.get('imports/a/one')).toBeNull()
    expect(await s.get('imports/b/three')).not.toBeNull()
  })
})

describe('file private store', () => {
  it('refuses keys that escape the store', async () => {
    const s = privateStoreFromUri(`file://${mkdtempSync(join(tmpdir(), 'private-store-'))}`)
    for (const key of ['imports/../escape', '../escape', 'a/../b', '/etc/x']) {
      await expect(s.put(key, Buffer.from('x'), 'text/plain'), key).rejects.toThrow()
      await expect(s.get(key), key).rejects.toThrow()
    }
  })

  it('rejects an absolute key through the resolved-path guard, not only the .. check', async () => {
    const s = privateStoreFromUri(`file://${mkdtempSync(join(tmpdir(), 'private-store-'))}`)
    await expect(s.put('/etc/x', Buffer.from('x'), 'text/plain')).rejects.toThrow('escapes its folder')
  })
})

describe('import store', () => {
  const saved = { mode: config.mode, uri: config.sceneImportS3Uri }
  const restore = () => { (config as any).mode = saved.mode; (config as any).sceneImportS3Uri = saved.uri; setImportStore(null) }

  it('single mode falls back to local disk at privateStoragePath', async () => {
    const savedPath = config.privateStoragePath
    try {
      ;(config as any).mode = 'single'; (config as any).sceneImportS3Uri = undefined
      ;(config as any).privateStoragePath = mkdtempSync(join(tmpdir(), 'private-default-'))
      setImportStore(null)
      await getImportStore().put('imports/x/source.zip', Buffer.from('z'), 'application/zip')
      expect((await getImportStore().get('imports/x/source.zip'))?.body.toString()).toBe('z')
    } finally { (config as any).privateStoragePath = savedPath; restore() }
  })

  it('the default private path is never inside the served uploads root', () => {
    const root = resolve(config.localStoragePath)
    const priv = resolve(config.privateStoragePath)
    expect(priv === root || priv.startsWith(root + sep)).toBe(false)
  })

  it('refuses a private path that is the uploads root or inside it', () => {
    const savedPath = config.privateStoragePath
    try {
      ;(config as any).mode = 'single'; (config as any).sceneImportS3Uri = undefined
      for (const p of [config.localStoragePath, join(config.localStoragePath, 'private'), join(config.localStoragePath, 'a', '..', 'b')]) {
        ;(config as any).privateStoragePath = p
        setImportStore(null)
        expect(() => getImportStore(), p).toThrow(/PRIVATE_STORAGE_PATH.*LOCAL_STORAGE_PATH/)
      }
      ;(config as any).privateStoragePath = mkdtempSync(join(tmpdir(), 'private-ok-'))
      setImportStore(null)
      expect(() => getImportStore()).not.toThrow()
    } finally { (config as any).privateStoragePath = savedPath; restore() }
  })

  it('scalable and cloud modes need SCENE_IMPORT_S3_URI', () => {
    try {
      for (const mode of ['scalable', 'cloud']) {
        ;(config as any).mode = mode; (config as any).sceneImportS3Uri = undefined
        setImportStore(null)
        expect(() => getImportStore(), mode).toThrow('SCENE_IMPORT_S3_URI')
      }
    } finally { restore() }
  })
})
