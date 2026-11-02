import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { memoryPrivateStore, privateStoreFromUri, type PrivateStore } from '../src/storage/private-store.js'

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
  it('refuses a key containing ..', async () => {
    const s = privateStoreFromUri(`file://${mkdtempSync(join(tmpdir(), 'private-store-'))}`)
    await expect(s.put('imports/../escape', Buffer.from('x'), 'text/plain')).rejects.toThrow()
    await expect(s.get('../escape')).rejects.toThrow()
  })
})
