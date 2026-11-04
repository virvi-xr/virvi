import { Authenticator, type AuthChain } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import type { Eip1193Provider } from './auth'

export type { AuthChain }

/** An authorised ephemeral key: signs Decentraland payloads without asking the wallet again. */
export interface SignSession {
  /** The wallet that authorised the session, lowercased. */
  address: string
  sign(payload: string): AuthChain
}

/** The connected wallet isn't the one that owns the World (or none of the wallets that may sign). */
export class WrongWalletError extends Error {
  constructor(public readonly expected: string | string[]) {
    super(`Switch your wallet to ${Array.isArray(expected) ? expected.join(' or ') : expected} and try again.`)
    this.name = 'WrongWalletError'
  }
}

const toHex = (text: string) => '0x' + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')

/** True when the address has contract code (a smart-contract wallet, which can't sign an ephemeral-key message). */
export async function isContractWallet(wallet: Eip1193Provider, address: string): Promise<boolean> {
  const code = (await wallet.request({ method: 'eth_getCode', params: [address, 'latest'] })) as string
  return code !== '0x'
}

/**
 * One wallet signature authorises a fresh in-memory key for `minutes` (like `sdk-commands deploy`);
 * that key then signs every payload. The key is never stored or sent anywhere.
 */
export async function startSignSession(
  wallet: Eip1193Provider,
  opts: { minutes?: number; expectedAddress?: string | string[] } = {},
): Promise<SignSession> {
  const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[]
  const address = accounts?.[0]?.toLowerCase()
  if (!address) throw new Error('No wallet account selected')
  const expected = opts.expectedAddress === undefined ? [] : [opts.expectedAddress].flat()
  if (expected.length && !expected.some((a) => a.toLowerCase() === address)) throw new WrongWalletError(opts.expectedAddress!)

  const identity = await Authenticator.initializeAuthChain(address, createUnsafeIdentity(), opts.minutes ?? 10, async (message) =>
    (await wallet.request({ method: 'personal_sign', params: [toHex(message), address] })) as string,
  )
  return { address, sign: (payload) => Authenticator.signPayload(identity, payload) }
}
