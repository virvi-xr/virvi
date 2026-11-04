// Genesis City parcels: making Virvi an operator on-chain (optional), and the owner's transactions that do it.
import type { Eip1193Provider } from './auth'

export interface GrantTransaction {
  to: string
  data: string
  label: string
}

/** GET /api/dcl/destinations/:id/parcel-grant. `transactions` is left out when the caller can't grant. */
export interface ParcelGrant {
  available: boolean
  aetheria: boolean
  canGrant: boolean
  granted: boolean
  /** Virvi's Genesis City address: the operator the transactions set. */
  operator: string | null
  transactions?: GrantTransaction[]
  costNote: string
}

/** GET …/parcel-grant/revoke. `message` when Virvi holds a right only the owner can remove in Decentraland's Builder. */
export interface ParcelRevoke {
  canGrant: boolean
  transactions: GrantTransaction[]
  costNote: string
  message?: string
}

export const OPERATOR_REPLACES_NOTE =
  'Making Virvi the operator replaces any update operator already set on these parcels: whoever held that right loses it until you set it again.'

/** Whether the grant card shows, and the reason it offers no button. */
export function grantView(g: Pick<ParcelGrant, 'available' | 'aetheria' | 'canGrant'>): { show: boolean; reason: string | null } {
  if (!g.available) return { show: false, reason: null }
  if (g.aetheria) return { show: true, reason: "Aetheria parcels are managed by their deed. Sign each deploy with the deed holder's wallet." }
  if (!g.canGrant) return { show: true, reason: "Only the parcels' owner can make Virvi an operator." }
  return { show: true, reason: null }
}

const MAINNET = '0x1'

/**
 * Sends the transactions from the connected account, one at a time, on Ethereum mainnet; the first rejection ends it
 * (the error is the wallet's own, so `wizardErrorMessage` words a refusal). Resolves with the transaction hashes.
 */
export async function sendTransactions(wallet: Eip1193Provider, txs: GrantTransaction[]): Promise<string[]> {
  const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[]
  const from = accounts?.[0]
  if (!from) throw new Error('No wallet account selected')
  const chain = (await wallet.request({ method: 'eth_chainId' })) as string
  if (chain?.toLowerCase() !== MAINNET) await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MAINNET }] })
  const hashes: string[] = []
  for (const tx of txs) {
    hashes.push((await wallet.request({ method: 'eth_sendTransaction', params: [{ from, to: tx.to, data: tx.data }] })) as string)
  }
  return hashes
}
