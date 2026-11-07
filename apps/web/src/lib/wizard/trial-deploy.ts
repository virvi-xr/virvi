// LIV-91 phase 2: a trial deploys by connecting its wallet, which signs it in (creating the Virvi account, or moving the
// trial into the wallet's existing one), then the World is picked from what that wallet owns.
import type { DclWorld } from '../api'

export type WalletNames = Array<{ address: string; names: DclWorld[] }>

/** Shown on a trial's Deploy button area: the wallet sign-in is also the sign-up. */
export const DEPLOY_LINE = 'Connect your wallet to deploy. This also creates your Virvi account.'
/** While the wallet is asked: one signature for the account (SIWE), one more for the deploy. */
export const WALLET_PROMPT = 'Check your wallet: sign once to create your account, then once more to deploy.'
/** The wallet that signed in owns no NAME: the account exists anyway (owner-decision default). */
export const NO_WORLD_MESSAGE =
  "This wallet doesn't own a Decentraland NAME. Your account is ready: connect the wallet that owns your World, or pick Hyperfy or Virvi AR instead."

/**
 * Signs the trial in with its wallet (`fromAction` 'deploy'), then lists the Worlds of the account it became, using the
 * token the sign-in returned (the page's own requests still hold the trial's until it re-renders). A refused or failed
 * sign-in throws before anything is listed.
 */
export async function connectForDeploy(deps: {
  loginWithWallet: (fromAction: string) => Promise<string>
  names: (token: string) => Promise<{ wallets: WalletNames }>
}): Promise<{ wallets: WalletNames }> {
  const token = await deps.loginWithWallet('deploy')
  return deps.names(token)
}

/** The World to use without asking: the only one across the wallets, and only when it has no scene to replace. */
export function autoPickWorld(wallets: WalletNames): { world: DclWorld; wallet: string } | null {
  const all = wallets.flatMap((w) => w.names.map((world) => ({ world, wallet: w.address })))
  return all.length === 1 && !all[0].world.hasScene ? all[0] : null
}

/** The no-NAME line when no wallet owns a World, else null. */
export function noWorldMessage(wallets: WalletNames): string | null {
  return wallets.some((w) => w.names.length > 0) ? null : NO_WORLD_MESSAGE
}

/**
 * What Deploy needs before its normal button: a trial that chose Decentraland connects its wallet ('wallet'); an account
 * carrying that choice (a converted trial, or a draft it adopted) picks a World or skips Decentraland ('world'). Otherwise
 * the normal deploy ('deploy'); a trial without Decentraland is asked to sign up by the save itself.
 */
export function deployGate(s: { trial: boolean; dclLater: boolean; dcl: unknown }): 'wallet' | 'world' | 'deploy' {
  if (s.dcl || !s.dclLater) return 'deploy'
  return s.trial ? 'wallet' : 'world'
}
