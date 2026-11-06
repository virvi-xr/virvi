import { describe, it, expect } from 'vitest'
import { assertPublicHttpUrl, UnsafeUrlError } from '../src/net/public-url.js'

const pub = async () => ['93.184.216.34']

describe('assertPublicHttpUrl', () => {
  it.each([
    'http://10.0.0.5/x',
    'http://0.0.0.0/',
    'http://100.64.0.1/',
    'http://127.0.0.1:9999/',
    'http://169.254.169.254/latest',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
    'http://[::]/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a00:1]/',
    // LIV-133: benchmarking 198.18.0.0/15, IETF 192.0.0.0/24, TEST-NET-1/2/3
    'http://198.18.0.1/',
    'http://198.19.255.255/',
    'http://192.0.0.8/',
    'http://192.0.2.1/',
    'http://198.51.100.7/',
    'http://203.0.113.9/',
    // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embedding a private IPv4; local-use NAT64 (64:ff9b:1::/48)
    'http://[64:ff9b::10.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[64:ff9b::c000:201]/',
    'http://[64:ff9b:1::5db8:d822]/',
    'http://[2002:a00:1::1]/',
    'http://[2002:7f00:1::]/',
    'http://[2002:c0a8:101:1::1]/',
    'http://[2002:a9fe:a9fe::1]/',
    'http://localhost/',
    'http://app.localhost/',
    'http://foo.railway.internal/',
    'http://db.internal/',
    'ftp://example.com/',
    'not a url',
  ])('refuses %s', async (url) => {
    await expect(assertPublicHttpUrl(url, { lookup: pub })).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('refuses a host if any resolved address is private', async () => {
    await expect(
      assertPublicHttpUrl('https://example.com/cb', { lookup: async () => ['93.184.216.34', '10.0.0.1'] }),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('refuses a host that does not resolve', async () => {
    await expect(
      assertPublicHttpUrl('https://example.com/cb', { lookup: async () => { throw new Error('ENOTFOUND') } }),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('accepts a public host and public literals', async () => {
    const u = await assertPublicHttpUrl('https://example.com/cb', { lookup: pub })
    expect(u.href).toBe('https://example.com/cb')
    await expect(assertPublicHttpUrl('http://93.184.216.34/x', { lookup: async () => { throw new Error('no lookup') } })).resolves.toBeInstanceOf(URL)
  })

  it.each([
    'http://198.17.255.255/',
    'http://198.20.0.1/',
    'http://192.0.1.1/',
    'http://192.0.3.1/',
    'http://198.51.101.1/',
    'http://203.0.114.1/',
    'http://[64:ff9b::93.184.216.34]/',
    'http://[64:ff9b::5db8:d822]/',
    'http://[2002:5db8:d822::1]/',
    'http://[2606:4700::1111]/',
  ])('accepts %s (public, including a public IPv4 behind NAT64 or 6to4)', async (url) => {
    await expect(assertPublicHttpUrl(url, { lookup: async () => { throw new Error('no lookup') } })).resolves.toBeInstanceOf(URL)
  })

  it('refuses a host resolving to NAT64 or 6to4 of a private IPv4', async () => {
    for (const address of ['64:ff9b::a00:1', '2002:a9fe:a9fe::1', '198.18.0.1']) {
      await expect(assertPublicHttpUrl('https://example.com/', { lookup: async () => [address] })).rejects.toBeInstanceOf(UnsafeUrlError)
    }
  })

  it('allowPrivate accepts a local listener but still requires http(s)', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1:9999/', { allowPrivate: true })).resolves.toBeInstanceOf(URL)
    await expect(assertPublicHttpUrl('ftp://127.0.0.1/', { allowPrivate: true })).rejects.toBeInstanceOf(UnsafeUrlError)
  })
})
