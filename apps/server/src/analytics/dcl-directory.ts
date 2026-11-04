import { config } from '../config.js'

export interface ActiveScene {
  entityId: string
  base: string
  parcels: string[]
  title?: string
}

export interface ParcelRights {
  owner: string | null
  operator: string | null
  updateOperator: string | null
  updateManagers: string[]
  approvedForAll: string[]
}

export interface DclDirectory {
  getActiveSceneAt(parcel: string): Promise<ActiveScene | null>
  /** With `entityId`, a cached answer is used only if it belongs to that deployment. */
  getActiveDeployer(parcel: string, entityId?: string): Promise<string | null>
  getWorldScene(name: string): Promise<{ sceneUrns: string[]; title?: string } | null>
  /** `fresh` bypasses the TTL cache (use before authorising a deploy). */
  getParcelRights(parcel: string, opts?: { fresh?: boolean }): Promise<ParcelRights | null>
  /** Land-manager subgraph: parcel -> estate id, or null when the parcel is in no estate. Uncached. */
  getParcelEstates(parcels: string[]): Promise<Map<string, string | null>>
  getWorldOwner(name: string): Promise<string | null>
  getWorldDeployers(name: string): Promise<string[]>
  /** Lowercased hostnames of the DAO catalyst list. Throws DirectoryUnavailableError when it can't be fetched. */
  getCatalystHosts(): Promise<string[]>
  /** The wallet's DCL NAMEs as World names (`<name>.dcl.eth`, lowercased). */
  getOwnedNames(address: string): Promise<string[]>
}

export class DirectoryUnavailableError extends Error {}

const TIMEOUT_MS = 3_000
const lower = (v: unknown) => (typeof v === 'string' && v ? v.toLowerCase() : null)
const lowerList = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x: string) => x.toLowerCase()) : [])

async function getJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    // Only 404/400 mean "not found"; every other non-2xx is an upstream problem, not an answer.
    if (res.status === 404 || res.status === 400) return null
    if (!res.ok) throw new DirectoryUnavailableError(`${url}: HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) throw err
    throw new DirectoryUnavailableError(`${url}: ${(err as Error).message}`)
  }
}

const CACHE_TTL_MS = 60_000
const CACHE_MAX = 10_000
const ACTIVE_TTL_MS = 30_000
const CATALYSTS_TTL_MS = 60 * 60_000
const CATALYSTS_RETRY_MS = 60_000
const OWNED_NAMES_MAX_PAGES = 10

/** Small TTL cache (insertion-ordered, bounded) for upstream answers. Errors are never cached. */
export class TtlCache<V> {
  private m = new Map<string, { at: number; value: V }>()
  constructor(private ttlMs = CACHE_TTL_MS, private max = CACHE_MAX, private clock: () => number = Date.now) {}

  get(key: string): { value: V } | undefined {
    const hit = this.m.get(key)
    if (!hit) return undefined
    if (this.clock() - hit.at >= this.ttlMs) {
      this.m.delete(key)
      return undefined
    }
    return { value: hit.value }
  }

  set(key: string, value: V): void {
    this.m.delete(key)
    this.m.set(key, { at: this.clock(), value })
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string)
  }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key)
    if (hit) return hit.value
    const value = await load()
    this.set(key, value)
    return value
  }

  get size() {
    return this.m.size
  }
}

type WorldPermissions = { owner?: string; permissions?: { deployment?: { type?: string; wallets?: unknown } } } | null

export class HttpDclDirectory implements DclDirectory {
  // Status polls, setup presses and analytics reads ask the same questions repeatedly; cache them briefly.
  private rights = new TtlCache<ParcelRights | null>()
  private deployers = new TtlCache<{ entityId: string | null; deployer: string | null }>()
  private permissions = new TtlCache<WorldPermissions>()
  // Scene sign-in checks the live deployment on every mismatched entity; keep that bounded per location.
  private activeScenes = new TtlCache<ActiveScene | null>(ACTIVE_TTL_MS)
  private worldScenes = new TtlCache<{ sceneUrns: string[]; title?: string } | null>(ACTIVE_TTL_MS)
  private catalysts = new TtlCache<string[]>(CATALYSTS_TTL_MS)
  private catalystsFailedAt = -Infinity
  private ownedNames = new TtlCache<string[]>()

  constructor(private catalyst = config.catalystUrl, private worlds = config.worldsUrl, private subgraph = config.dclLandSubgraphUrl) {}

  async getActiveSceneAt(parcel: string): Promise<ActiveScene | null> {
    return this.activeScenes.getOrLoad(parcel, () => this.fetchActiveSceneAt(parcel))
  }

  private async fetchActiveSceneAt(parcel: string): Promise<ActiveScene | null> {
    const body = (await getJson(`${this.catalyst}/content/entities/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointers: [parcel] }),
    })) as Array<{ id: string; metadata?: { scene?: { base?: string; parcels?: string[] }; display?: { title?: string } } }> | null
    const e = body?.[0]
    if (!e?.metadata?.scene?.base) return null
    return { entityId: e.id, base: e.metadata.scene.base, parcels: e.metadata.scene.parcels ?? [], title: e.metadata.display?.title }
  }

  async getActiveDeployer(parcel: string, entityId?: string): Promise<string | null> {
    const hit = this.deployers.get(parcel)
    // A cached deployer of an older deployment must never be attributed to a newer one.
    if (hit && (!entityId || hit.value.entityId === entityId)) return hit.value.deployer
    const q = new URLSearchParams({ pointer: parcel, onlyCurrentlyPointed: 'true', limit: '1' })
    const body = (await getJson(`${this.catalyst}/content/deployments?${q}`)) as {
      deployments?: Array<{ deployedBy?: string; entityId?: string }>
    } | null
    const d = body?.deployments?.[0]
    const value = { entityId: typeof d?.entityId === 'string' ? d.entityId : null, deployer: lower(d?.deployedBy) }
    if (!entityId || value.entityId === entityId) this.deployers.set(parcel, value)
    return value.deployer
  }

  async getWorldScene(name: string) {
    const n = name.toLowerCase()
    return this.worldScenes.getOrLoad(n, async () => {
      const body = (await getJson(`${this.worlds}/world/${encodeURIComponent(n)}/about`)) as {
        configurations?: { scenesUrn?: string[] }
      } | null
      const urns = body?.configurations?.scenesUrn ?? []
      return urns.length ? { sceneUrns: urns } : null
    })
  }

  /** DAO catalyst list (`/lambdas/contracts/servers`), cached for an hour; a failure is remembered for a minute. */
  async getCatalystHosts(): Promise<string[]> {
    const hit = this.catalysts.get('dao')
    if (hit) return hit.value
    if (Date.now() - this.catalystsFailedAt < CATALYSTS_RETRY_MS) throw new DirectoryUnavailableError('catalyst list recently unavailable')
    try {
      const body = await getJson(`${this.catalyst}/lambdas/contracts/servers`)
      if (!Array.isArray(body)) throw new DirectoryUnavailableError('catalyst list: unexpected body')
      const hosts = body.flatMap((s: { baseUrl?: unknown }) => {
        if (typeof s?.baseUrl !== 'string') return []
        try {
          const u = new URL(s.baseUrl)
          return u.protocol === 'https:' && !u.port ? [u.hostname.toLowerCase()] : []
        } catch {
          return []
        }
      })
      if (!hosts.length) throw new DirectoryUnavailableError('catalyst list empty')
      this.catalysts.set('dao', hosts)
      return hosts
    } catch (err) {
      this.catalystsFailedAt = Date.now()
      throw err
    }
  }

  /**
   * `GET /lambdas/users/{address}/names` -> `{ elements: [{ name, contractAddress, tokenId, price }], totalAmount, pageNum, pageSize }`
   * (name has no `.dcl.eth` suffix); paged, so follow pageNum until totalAmount is covered.
   */
  async getOwnedNames(address: string): Promise<string[]> {
    const a = address.toLowerCase()
    return this.ownedNames.getOrLoad(a, async () => {
      const names: string[] = []
      for (let page = 1; page <= OWNED_NAMES_MAX_PAGES; page++) {
        const body = (await getJson(`${this.catalyst}/lambdas/users/${encodeURIComponent(a)}/names?pageNum=${page}`)) as {
          elements?: Array<{ name?: unknown }>
          totalAmount?: number
        } | null
        const els = body?.elements ?? []
        for (const e of els) if (typeof e?.name === 'string' && e.name) names.push(`${e.name.toLowerCase()}.dcl.eth`)
        if (!els.length || names.length >= (body?.totalAmount ?? 0)) break
      }
      return [...new Set(names)]
    })
  }

  async getParcelRights(parcel: string, opts?: { fresh?: boolean }): Promise<ParcelRights | null> {
    if (opts?.fresh) {
      const value = await this.fetchParcelRights(parcel)
      this.rights.set(parcel, value)
      return value
    }
    return this.rights.getOrLoad(parcel, () => this.fetchParcelRights(parcel))
  }

  /** One subgraph request for all parcels, using a GraphQL alias per parcel. */
  async getParcelEstates(parcels: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>()
    if (!parcels.length) return out
    const fields = parcels.map((p, i) => {
      const m = /^(-?\d{1,4}),(-?\d{1,4})$/.exec(p)
      if (!m) throw new Error(`bad parcel coordinate: ${p}`)
      return `p${i}: parcels(where:{x:"${m[1]}",y:"${m[2]}"}) { estate { id } }`
    })
    const url = this.subgraph
    let body: { data?: Record<string, Array<{ estate?: { id?: unknown } | null }>>; errors?: unknown } | null
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `{ ${fields.join(' ')} }` }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new DirectoryUnavailableError(`${url}: HTTP ${res.status}`)
      body = (await res.json()) as typeof body
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) throw err
      throw new DirectoryUnavailableError(`${url}: ${(err as Error).message}`)
    }
    if (!body?.data || body.errors) throw new DirectoryUnavailableError(`${url}: subgraph error`)
    parcels.forEach((p, i) => {
      const id = body!.data![`p${i}`]?.[0]?.estate?.id
      out.set(p, typeof id === 'string' && id ? id : null)
    })
    return out
  }

  private async fetchParcelRights(parcel: string): Promise<ParcelRights | null> {
    const [x, y] = parcel.split(',')
    const body = (await getJson(`${this.catalyst}/lambdas/parcels/${x}/${y}/operators`)) as Record<string, unknown> | null
    if (!body) return null
    return {
      owner: lower(body.owner),
      operator: lower(body.operator),
      updateOperator: lower(body.updateOperator),
      updateManagers: lowerList(body.updateManagers),
      approvedForAll: lowerList(body.approvedForAll),
    }
  }

  /** One cached /permissions fetch serves both the owner and the deployment allow-list. */
  private worldPermissions(name: string): Promise<WorldPermissions> {
    const n = name.toLowerCase()
    return this.permissions.getOrLoad(n, async () => (await getJson(`${this.worlds}/world/${encodeURIComponent(n)}/permissions`)) as WorldPermissions)
  }

  async getWorldOwner(name: string): Promise<string | null> {
    return lower((await this.worldPermissions(name))?.owner)
  }

  async getWorldDeployers(name: string): Promise<string[]> {
    const d = (await this.worldPermissions(name))?.permissions?.deployment
    return d?.type === 'allow-list' ? lowerList(d.wallets) : []
  }
}

let current: DclDirectory | null = null

export function getDclDirectory(): DclDirectory {
  if (!current) current = new HttpDclDirectory()
  return current
}

/** Tests inject a fake; pass null to restore the HTTP implementation. */
export function setDclDirectory(d: DclDirectory | null): void {
  current = d
}
