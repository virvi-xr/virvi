import { getDclDirectory, type DclDirectory, type ParcelRights } from '../../analytics/dcl-directory.js'

/** Owners whose land is the Aetheria estate (the operators lambda reports an estate's parcels under its owner). */
export const AETHERIA_OWNERS: ReadonlySet<string> = new Set(['0x2981aa7d75eaa42b248e304e378c7139868d4776'])
export const AETHERIA_ESTATES = new Set(['2092'])

export interface ParcelControl {
  /** First of `wallets` that may deploy to every parcel. */
  wallet: string | null
  /** Every one of `wallets` that may deploy to every parcel, in order. */
  wallets: string[]
  /** First parcel none of the wallets may deploy to. */
  missing: string | null
  /** First of `wallets` that is owner/operator/approvedForAll of every parcel (an update operator can't grant). */
  granter: string | null
  /** There is a `granter`. */
  canGrant: boolean
  /** Any parcel's owner is in AETHERIA_OWNERS. */
  aetheria: boolean
  rightsOf: Map<string, ParcelRights>
}

const canDeploy = (r: ParcelRights | undefined, w: string) =>
  !!r && [r.owner, r.operator, r.updateOperator, ...r.updateManagers, ...r.approvedForAll].includes(w)
const canGrantOn = (r: ParcelRights | undefined, w: string) => !!r && (r.owner === w || r.operator === w || r.approvedForAll.includes(w))

/** Parcels whose rights are read at once. */
const READ_CONCURRENCY = 4

export interface RightsReadOptions {
  /** Bypass the directory's cache (default): what authorising anything needs. False is for display only. */
  fresh?: boolean
}

/**
 * Each parcel's rights, a few at a time, read fresh unless `fresh: false` (a parcel Decentraland knows nothing of is
 * left out). Throws DirectoryUnavailableError.
 */
export async function readParcelRights(parcels: string[], dir: DclDirectory = getDclDirectory(), opts: RightsReadOptions = {}): Promise<Map<string, ParcelRights>> {
  const fresh = opts.fresh ?? true
  const found = new Array<ParcelRights | null>(parcels.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < parcels.length) {
      const i = next++
      found[i] = await dir.getParcelRights(parcels[i], { fresh })
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, parcels.length) }, worker))
  const rightsOf = new Map<string, ParcelRights>()
  parcels.forEach((p, i) => { if (found[i]) rightsOf.set(p, found[i]!) })
  return rightsOf
}

/** Who may deploy to (and grant on) this set of parcels. Throws DirectoryUnavailableError if Decentraland can't answer. */
export async function parcelControl(
  wallets: string[], parcels: string[], dir: DclDirectory = getDclDirectory(), opts: RightsReadOptions = {},
): Promise<ParcelControl> {
  const ws = wallets.map((w) => w.toLowerCase())
  const rightsOf = await readParcelRights(parcels, dir, opts)
  const all = parcels.length ? ws.filter((w) => parcels.every((p) => canDeploy(rightsOf.get(p), w))) : []
  const wallet = all[0] ?? null
  const missing = parcels.find((p) => !ws.some((w) => canDeploy(rightsOf.get(p), w))) ?? null
  const granter = all.find((w) => parcels.every((p) => canGrantOn(rightsOf.get(p), w))) ?? null
  return {
    wallet,
    wallets: all,
    missing,
    granter,
    canGrant: !!granter,
    aetheria: [...rightsOf.values()].some((r) => !!r.owner && AETHERIA_OWNERS.has(r.owner)),
    rightsOf,
  }
}

/** `address` holds a deploy right (update operator/manager, operator or approved-for-all) on every parcel. */
export function grantedTo(address: string, rightsOf: Map<string, ParcelRights>): boolean {
  const a = address.toLowerCase()
  if (!rightsOf.size) return false
  return [...rightsOf.values()].every((r) => r.updateOperator === a || r.updateManagers.includes(a) || r.operator === a || r.approvedForAll.includes(a))
}
