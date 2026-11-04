// Kept apart from dcl-sign (which loads @dcl/crypto only when the wallet is first asked to sign).

/** The connected wallet isn't the one that owns the World (or none of the wallets that may sign, or send). */
export class WrongWalletError extends Error {
  constructor(public readonly expected: string | string[]) {
    super(`Switch your wallet to ${Array.isArray(expected) ? expected.join(' or ') : expected} and try again.`)
    this.name = 'WrongWalletError'
  }
}
