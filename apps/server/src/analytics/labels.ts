import { config } from '../config.js'

/** Interaction targets recorded before scenes named their objects look like `entity:539`; they are folded into one row. */
export const LEGACY_ENTITY_LABEL = 'Unnamed objects (older data)'
const LEGACY_ENTITY_RE = /^entity:\d+$/

export function mergeLegacyEntityTargets(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(counts)) {
    const key = LEGACY_ENTITY_RE.test(k) ? LEGACY_ENTITY_LABEL : k
    out[key] = (out[key] ?? 0) + v
  }
  return out
}

const TIMEOUT_MS = 3_000
const OK_TTL_MS = 24 * 3_600_000
// A failed lookup is remembered briefly so a catalyst outage doesn't add a 3 s wait to every dashboard load.
const FAIL_TTL_MS = 5 * 60_000
const MAX_ENTRIES = 5_000
// The dashboard shows 8 emotes; only the most used URNs are looked up, since the list comes from clients.
const MAX_LOOKUPS = 50
const CHUNK = 100
const BASE_EMOTE_RE = /^[a-z0-9_-]+$/i

const cache = new Map<string, { label: string; expires: number }>()
/** Lookups on their way, so concurrent dashboard loads share one request per URN. */
const inflight = new Map<string, Promise<string | null | undefined>>()

/** Test hook. */
export function resetEmoteLabelCache(): void {
  cache.clear()
  inflight.clear()
}

function titleCase(id: string): string {
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/** The last two URN segments, with a long address cut to `0x1234…abcd`. */
function shortUrn(urn: string): string {
  const shorten = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s)
  return urn.split(':').slice(-2).map(shorten).join(':')
}

async function fetchNames(urns: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const res = await fetch(`${config.catalystUrl}/content/entities/active`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pointers: urns }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`catalyst HTTP ${res.status}`)
  const entities = await res.json()
  if (!Array.isArray(entities)) throw new Error('unexpected catalyst response')
  for (const e of entities) {
    const name = e?.metadata?.name
    if (typeof name !== 'string' || !name || !Array.isArray(e.pointers)) continue
    for (const p of e.pointers) if (typeof p === 'string') names.set(p.toLowerCase(), name)
  }
  return names
}

/** Look up one chunk; each URN's promise resolves to its name, undefined when unknown, or null when the lookup failed. */
function lookup(urns: string[]): void {
  const done = fetchNames(urns)
  for (const urn of urns) {
    const k = urn.toLowerCase()
    const p = done.then(
      (names) => names.get(k),
      () => null,
    )
    inflight.set(k, p)
    void p.then(() => inflight.delete(k))
  }
}

/**
 * A readable label for each emote key: base emotes (`wave`) are title-cased; collection URNs are looked up on the
 * catalyst and cached. `keys` should be ordered most used first: only the first `limit` URNs are looked up (in chunks
 * of 100), the rest get a short form of the URN. Any failure falls back the same way; this never throws.
 */
export async function resolveEmoteLabels(
  keys: string[],
  opts: { now?: () => number; maxEntries?: number; limit?: number } = {},
): Promise<Record<string, string>> {
  const now = (opts.now ?? Date.now)()
  const out: Record<string, string> = {}
  const unknown: string[] = []
  let urns = 0
  for (const key of keys) {
    if (BASE_EMOTE_RE.test(key)) {
      out[key] = titleCase(key)
      continue
    }
    if (urns++ >= (opts.limit ?? MAX_LOOKUPS)) {
      out[key] = shortUrn(key)
      continue
    }
    const hit = cache.get(key.toLowerCase())
    if (hit && hit.expires > now) out[key] = hit.label
    else unknown.push(key)
  }
  const fresh = unknown.filter((k) => !inflight.has(k.toLowerCase()))
  for (let i = 0; i < fresh.length; i += CHUNK) lookup(fresh.slice(i, i + CHUNK))
  const results = await Promise.all(unknown.map((k) => inflight.get(k.toLowerCase())))
  unknown.forEach((key, i) => {
    const name = results[i]
    out[key] = name ?? shortUrn(key)
    cache.delete(key.toLowerCase())
    cache.set(key.toLowerCase(), { label: out[key], expires: now + (name ? OK_TTL_MS : FAIL_TTL_MS) })
  })
  const max = opts.maxEntries ?? MAX_ENTRIES
  while (cache.size > max) cache.delete(cache.keys().next().value as string)
  return out
}
