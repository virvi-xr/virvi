import { describe, it, expect } from 'vitest'
import { colyseusPublicAddress } from '../src/config.js'

/** LIV-156: each of several servers behind one proxy tells Colyseus clients its own path, so they join the right one. */
describe('colyseusPublicAddress', () => {
  it('is unset for a single server', () => {
    expect(colyseusPublicAddress(undefined, undefined, 'https://virvi.example.com')).toBeUndefined()
    expect(colyseusPublicAddress('  ', '', 'https://virvi.example.com')).toBeUndefined()
  })
  it("is PUBLIC_URL's host plus ROOM_SERVER_PATH, without the protocol", () => {
    expect(colyseusPublicAddress(undefined, '/n1', 'https://virvi.example.com')).toBe('virvi.example.com/n1')
    expect(colyseusPublicAddress(undefined, 'n2/', 'http://localhost:3010/')).toBe('localhost:3010/n2')
  })
  it('takes COLYSEUS_PUBLIC_ADDRESS as given, minus a protocol or trailing slash', () => {
    expect(colyseusPublicAddress('wss://rooms-1.example.com/', '/n1', 'https://x')).toBe('rooms-1.example.com')
  })
  it('refuses a path that is not one segment', () => {
    expect(() => colyseusPublicAddress(undefined, '/a/b', 'https://x.example')).toThrow(/one path segment/)
    expect(() => colyseusPublicAddress(undefined, '/n1', 'not a url')).toThrow(/PUBLIC_URL/)
  })
})

describe('Colyseus Redis driver (LIV-156)', () => {
  it("matches Colyseus's release line, or every room fails to open with Redis on", async () => {
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const minor = (v: string) => v.split('.').slice(0, 2).join('.')
    const colyseus = req('colyseus/package.json').version as string
    const driver = req('@colyseus/redis-driver/package.json').version as string
    expect(minor(driver)).toBe(minor(colyseus))
    const { RedisDriver } = req('@colyseus/redis-driver')
    expect(typeof RedisDriver.prototype.createInstance).toBe('function') // what colyseus 0.15's matchmaker calls
  })
})
