/**
 * Paying a MANA quote from a browser wallet: a plain ERC-20 `transfer` of the quoted wei to the recipient, through the
 * MANA token on Polygon PoS. The server makes the quote and checks the transaction itself; nothing here decides a rate,
 * an amount or a recipient. Kept free of React so it tests in node.
 */
import type { Eip1193Provider } from './auth'
import type { ManaQuote } from './studio'

const POLYGON = '0x89' // chain id 137

/** What `wallet_addEthereumChain` needs for a wallet that has never seen Polygon (MetaMask answers 4902). */
const POLYGON_PARAMS = {
  chainId: POLYGON,
  chainName: 'Polygon Mainnet',
  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  rpcUrls: ['https://polygon-rpc.com'],
  blockExplorerUrls: ['https://polygonscan.com'],
}

const word = (hex: string) => hex.padStart(64, '0')
// BigInt() rather than literals: the web build targets ES2017
const ZERO = BigInt(0)
const CENT_OF_MANA = BigInt(10) ** BigInt(16) // 0.01 MANA in wei

/** Calldata for `transfer(address,uint256)`: `0xa9059cbb`, the 32-byte padded address, the 32-byte padded amount. */
export function encodeTransfer(to: string, amountWei: bigint): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('not an address')
  if (amountWei < ZERO) throw new Error('not an amount')
  return `0xa9059cbb${word(to.slice(2).toLowerCase())}${word(amountWei.toString(16))}`
}

/** Wei as MANA with 2 decimals, rounded up: `116000000000000000007` → `116.01 MANA`. */
export function formatMana(wei: string): string {
  const hundredths = (BigInt(wei) + CENT_OF_MANA - BigInt(1)) / CENT_OF_MANA
  const hundred = BigInt(100)
  return `${hundredths / hundred}.${(hundredths % hundred).toString().padStart(2, '0')} MANA`
}

/** A wallet's error code, also where some wallets nest it (MetaMask mobile: `data.originalError.code`). */
const codeOf = (err: unknown): unknown => {
  const e = err as { code?: unknown; data?: { originalError?: { code?: unknown } } } | null
  return e?.data?.originalError?.code ?? e?.code
}

/** Puts the wallet on Polygon, adding the network first when the wallet doesn't know it. */
export async function ensurePolygon(w: Eip1193Provider): Promise<void> {
  const switchChain = () => w.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: POLYGON }] })
  try {
    await switchChain()
  } catch (err) {
    if (codeOf(err) !== 4902) throw err
    await w.request({ method: 'wallet_addEthereumChain', params: [POLYGON_PARAMS] })
    await switchChain()
  }
}

/** Sends the quote's MANA from the wallet's first account and returns the transaction hash. */
export async function sendMana(w: Eip1193Provider, q: Pick<ManaQuote, 'token' | 'recipient' | 'amountWei'>): Promise<string> {
  const accounts = (await w.request({ method: 'eth_requestAccounts' })) as string[] | null
  const from = accounts?.[0]
  if (!from) throw new Error('No wallet account selected')
  await ensurePolygon(w)
  // Some wallets accept the switch and stay put: never send MANA on another chain
  const chainId = await w.request({ method: 'eth_chainId' })
  if (typeof chainId !== 'string' || chainId.toLowerCase() !== POLYGON) throw new Error('Your wallet isn’t on Polygon. Switch it to Polygon and try again.')
  const hash = await w.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: q.token, data: encodeTransfer(q.recipient, BigInt(q.amountWei)) }],
  })
  if (typeof hash !== 'string') throw new Error('The wallet did not return a transaction')
  return hash
}

/** The person said no in their wallet (EIP-1193 4001). */
export const walletRejected = (err: unknown) => codeOf(err) === 4001
