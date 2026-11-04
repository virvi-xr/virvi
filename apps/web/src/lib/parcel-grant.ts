// Genesis City parcels: making Virvi an operator on-chain (optional), and the owner's transactions that do it.
import type { Eip1193Provider } from './auth'
import { WrongWalletError } from './wrong-wallet'

export interface GrantTransaction {
  to: string
  data: string
  label: string
}

/** GET /api/dcl/destinations/:id/parcel-grant. `transactions` is left out when the caller can't grant. */
export interface ParcelGrant {
  available: boolean
  /** Null when Decentraland couldn't say (nothing is offered then). */
  aetheria: boolean | null
  canGrant: boolean
  /** Virvi holds the rights on-chain. */
  granted: boolean
  /** Virvi deploys for the owner (confirmed with Check): granted alone isn't enough. */
  active: boolean
  /** The caller's wallet that may send the transactions. */
  from: string | null
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

/**
 * Whether the grant card shows, and the reason it offers no button. A caller who can't send the transactions (an
 * update operator) may still let Virvi deploy once the owner made it an operator: that costs nothing.
 */
export function grantView(g: Pick<ParcelGrant, 'available' | 'aetheria' | 'canGrant'> & Partial<Pick<ParcelGrant, 'granted' | 'active'>>): { show: boolean; reason: string | null } {
  if (!g.available) return { show: false, reason: null }
  if (g.aetheria === null) return { show: true, reason: "Virvi couldn't check these parcels with Decentraland just now. Reload the page in a minute to set Virvi up." }
  if (g.aetheria) return { show: true, reason: "Aetheria parcels are managed by their deed. Sign each deploy with the deed holder's wallet." }
  if (!g.canGrant && !(g.granted && !g.active)) return { show: true, reason: "Only the parcels' owner can make Virvi an operator." }
  return { show: true, reason: null }
}

/**
 * The card's main button: make Virvi an operator; let Virvi deploy (free: it holds the rights on-chain but this
 * destination isn't using them yet, say the owner left before confirming); or remove it.
 */
export function grantAction(g: Pick<ParcelGrant, 'granted' | 'active'>): 'make' | 'activate' | 'remove' {
  if (!g.granted) return 'make'
  return g.active ? 'remove' : 'activate'
}

const MAINNET = '0x1'

/**
 * Sends the transactions from the connected account, one at a time, on Ethereum mainnet; the first rejection ends it
 * (the error is the wallet's own, so `wizardErrorMessage` words a refusal). `expected`: the wallet that may send them
 * (WrongWalletError, before anything is sent, for any other). Resolves with the transaction hashes.
 */
export async function sendTransactions(
  wallet: Eip1193Provider, txs: GrantTransaction[], opts: { expected?: string | null; onSent?: (hash: string) => void } = {},
): Promise<string[]> {
  const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[]
  const from = accounts?.[0]
  if (!from) throw new Error('No wallet account selected')
  if (opts.expected && from.toLowerCase() !== opts.expected.toLowerCase()) throw new WrongWalletError(opts.expected)
  const chain = (await wallet.request({ method: 'eth_chainId' })) as string
  if (chain?.toLowerCase() !== MAINNET) await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MAINNET }] })
  const hashes: string[] = []
  for (const tx of txs) {
    const hash = (await wallet.request({ method: 'eth_sendTransaction', params: [{ from, to: tx.to, data: tx.data }] })) as string
    hashes.push(hash)
    opts.onSent?.(hash)
  }
  return hashes
}
