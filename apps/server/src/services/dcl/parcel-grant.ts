/**
 * The optional operator grant for Genesis City parcels: the owner makes Virvi's Genesis City wallet
 * (VIRVI_DCL_PARCEL_DEPLOY_KEY, never the World key) an update operator on-chain, from their own wallet, so Virvi can
 * deploy there itself. Virvi only builds the transactions (Ethereum mainnet, the owner pays gas) and reads the result
 * back from Decentraland; it never sends a transaction.
 *
 * Registries (checked 2026-11-04, see the Scene Import plan 2's "Facts checked"):
 * - LANDRegistry `setManyUpdateOperator(uint256[] assetIds, address operator)` for parcels outside an estate;
 * - EstateRegistry `setUpdateOperator(uint256 estateId, address operator)` for each estate;
 * - only the owner, an operator or an approved-for-all wallet may call them (an update operator can't);
 * - the zero address as operator removes it.
 */
import { Interface, ZeroAddress } from 'ethers'
import type { ParcelRights } from '../../analytics/dcl-directory.js'
import { CatalystError } from './catalyst-client.js'
import { grantedTo } from './parcel-control.js'

export const LAND_REGISTRY = '0xf87e31492faf9a91b02ee0deaad50d51d56d5d4d'
export const ESTATE_REGISTRY = '0x959e104e1a4db6317fa58f8295f586e1a978c297'

const LAND = new Interface(['function setManyUpdateOperator(uint256[] _assetIds, address _operator)'])
const ESTATE = new Interface(['function setUpdateOperator(uint256 estateId, address operator)'])

export const GRANT_COST_NOTE =
  'This is an Ethereum mainnet transaction: you pay its gas fee once. Undo it any time with a second transaction from here (also paid in gas).'

export const GRANT_REVOKED_MESSAGE =
  'Virvi is no longer an operator on these parcels. Sign this deploy in the browser, or set Virvi up again.'

export interface GrantTransaction {
  to: string
  data: string
  label: string
}

/** A parcel's LAND asset id: x and y as unsigned 128-bit halves (two's complement for negatives). */
export function landAssetId(parcel: string): bigint {
  const [x, y] = parcel.split(',').map((n) => BigInt(n.trim()))
  return (BigInt.asUintN(128, x) << 128n) | BigInt.asUintN(128, y)
}

const count = (n: number) => `${n} parcel${n === 1 ? '' : 's'}`

/**
 * The transactions that make `operator` the update operator of `parcels` (null: remove it): one LANDRegistry call for
 * the parcels in no estate, one EstateRegistry call per estate (`estates`: parcel -> estate id, or null).
 */
export function grantTransactions(parcels: string[], estates: Map<string, string | null>, operator: string | null): GrantTransaction[] {
  const to = operator ?? ZeroAddress
  const loose = parcels.filter((p) => !estates.get(p))
  const estateIds = [...new Set(parcels.map((p) => estates.get(p)).filter((e): e is string => !!e))]
  const verb = operator ? 'Let Virvi deploy to' : 'Remove the update operator from'
  return [
    ...(loose.length
      ? [{ to: LAND_REGISTRY, data: LAND.encodeFunctionData('setManyUpdateOperator', [loose.map(landAssetId), to]), label: `${verb} ${count(loose.length)}` }]
      : []),
    ...estateIds.map((id) => ({
      to: ESTATE_REGISTRY, data: ESTATE.encodeFunctionData('setUpdateOperator', [BigInt(id), to]), label: `${verb} estate ${id}`,
    })),
  ]
}

/** The first of `parcels` where `address` holds no deploy right (a parcel with no rights counts as one); null when it holds them all. */
export function grantMissing(address: string, parcels: string[], rightsOf: Map<string, ParcelRights>): string | null {
  return parcels.find((p) => {
    const r = rightsOf.get(p)
    return !r || !grantedTo(address, new Map([[p, r]]))
  }) ?? null
}

/** The parcels whose update operator is `address`: a revoke clears only those, never someone else's. */
export function heldAsUpdateOperator(address: string, parcels: string[], rightsOf: Map<string, ParcelRights>): string[] {
  const a = address.toLowerCase()
  return parcels.filter((p) => rightsOf.get(p)?.updateOperator === a)
}

/** The catalyst refused a deploy because the signer may not deploy there (content-validator's access check). */
export function isAccessRefusal(err: unknown): boolean {
  return err instanceof CatalystError && err.status >= 400 && err.status < 500
    && /does not have access|not authori[sz]ed|unauthori[sz]ed|permission/i.test(err.body)
}
