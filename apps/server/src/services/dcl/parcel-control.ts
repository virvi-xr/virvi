import { getDclDirectory, type DclDirectory, type ParcelRights } from '../../analytics/dcl-directory.js'

/** Owners whose land is the Aetheria estate (the operators lambda reports an estate's parcels under its owner). */
export const AETHERIA_OWNERS: ReadonlySet<string> = new Set(['0x2981aa7d75eaa42b248e304e378c7139868d4776'])
export const AETHERIA_ESTATES = new Set(['2092'])

export interface ParcelControl {
  /** First of `wallets` that may deploy to every parcel. */
  wallet: string | null
  /** First parcel none of the wallets may deploy to. */
  missing: string | null
  /** `wallet` is owner/operator/approvedForAll of every parcel (an update operator can't grant). */
  canGrant: boolean
  /** Any parcel's owner is in AETHERIA_OWNERS. */
  aetheria: boolean
  rightsOf: Map<string, ParcelRights>
}

const canDeploy = (r: ParcelRights | undefined, w: string) =>
  !!r && [r.owner, r.operator, r.updateOperator, ...r.updateManagers, ...r.approvedForAll].includes(w)
const canGrantOn = (r: ParcelRights | undefined, w: string) => !!r && (r.owner === w || r.operator === w || r.approvedForAll.includes(w))

/** Who may deploy to (and grant on) this set of parcels. Throws DirectoryUnavailableError if Decentraland can't answer. */
export async function parcelControl(wallets: string[], parcels: string[], dir: DclDirectory = getDclDirectory()): Promise<ParcelControl> {
  const ws = wallets.map((w) => w.toLowerCase())
  const rightsOf = new Map<string, ParcelRights>()
  for (const p of parcels) {
    const r = await dir.getParcelRights(p, { fresh: true })
    if (r) rightsOf.set(p, r)
  }
  const wallet = parcels.length ? (ws.find((w) => parcels.every((p) => canDeploy(rightsOf.get(p), w))) ?? null) : null
  const missing = parcels.find((p) => !ws.some((w) => canDeploy(rightsOf.get(p), w))) ?? null
  return {
    wallet,
    missing,
    canGrant: !!wallet && parcels.every((p) => canGrantOn(rightsOf.get(p), wallet)),
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
