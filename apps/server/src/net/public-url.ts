/**
 * Outbound URL guard — refuses callback targets that point inside our network.
 *
 * Every resolved address must be public; a hostname with one private record is refused.
 */

import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

export interface PublicUrlOptions {
  allowPrivate?: boolean
  lookup?: (host: string) => Promise<string[]>
}

export const defaultLookup = async (host: string) => (await dns.lookup(host, { all: true })).map((r) => r.address)

function isPrivateV4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24 (IETF protocol assignments), TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 (benchmarking)
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // 224/4, 240/4 and 255.255.255.255
  )
}

/** The IPv4 address in two 16-bit groups. */
const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

/** Expand an IPv6 literal to eight 16-bit groups (embedded dotted IPv4 becomes two groups). */
function expandV6(ip: string): number[] {
  let s = ip.split('%')[0].toLowerCase()
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number)
    s = s.slice(0, -dotted[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail === undefined ? [] : tail ? tail.split(':') : []
  const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill('0')
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16))
}

function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip)
  if (g.length !== 8 || g.some(Number.isNaN)) return true
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff
  const compat = g.slice(0, 6).every((x) => x === 0)
  if (mapped || compat) return isPrivateV4(v4Of(g[6], g[7]))
  // NAT64 (64:ff9b::/96, RFC 6052) and 6to4 (2002:a.b.c.d::/48) reach the IPv4 they carry: private if it is. A public
  // one stays allowed: DNS64 networks name every IPv4-only host this way, and it reaches nothing a plain IPv4 doesn't.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(v4Of(g[6], g[7]))
  if (g[0] === 0x2002) return isPrivateV4(v4Of(g[1], g[2]))
  // Local-use NAT64 (64:ff9b:1::/48, RFC 8215): a site's own translator, whatever IPv4 it carries
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true
  return false
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return isPrivateV4(ip)
  if (kind === 6) return isPrivateV6(ip)
  return true // not an address we can classify
}

export async function assertPublicHttpUrl(url: string, opts: PublicUrlOptions = {}): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UnsafeUrlError('Invalid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http and https URLs are allowed')
  }
  if (opts.allowPrivate) return parsed

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new UnsafeUrlError('Host is not public')
  }

  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = await (opts.lookup ?? defaultLookup)(host)
    } catch {
      throw new UnsafeUrlError('Host did not resolve')
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError('Host resolves to a non-public address')
  }
  return parsed
}
