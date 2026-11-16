import { and, eq } from 'drizzle-orm'
import type { SignInMethod } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { accountWalletEvents, userAuthMethods, walletBlocks, type LinkedBy } from '../db/schema.js'

/**
 * Wallet blocks and provenance (LIV-11, reissue fix round 1).
 *
 * A blocked wallet can't sign in to Virvi (dashboard or in-world), can't be linked to an account, and every session
 * carrying it stops working: `authenticate` refuses its access tokens and `/api/auth/refresh` its refresh tokens. A
 * reissue's old wallet is blocked at approval; an admin unlinking a wallet from an account blocks it too.
 *
 * Sessions are stateless JWTs (there is no session table), so revoking means refusing the wallet claim wherever a token
 * is checked; access tokens carrying it end at once, refresh tokens at their next use.
 */

type Exec = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>

export async function isWalletBlocked(wallet: string | null | undefined, exec: Pick<typeof db, 'select'> = db): Promise<boolean> {
  if (!wallet) return false
  const [row] = await exec.select({ wallet: walletBlocks.wallet }).from(walletBlocks).where(eq(walletBlocks.wallet, wallet.toLowerCase())).limit(1)
  return !!row
}

/** Whether a token's wallet claim is blocked (rooms check this at join and at pass renewal; REST in authenticate). */
export async function claimsWalletBlocked(c: { wallet?: string | null; verified?: boolean } | null | undefined): Promise<boolean> {
  return !!c?.wallet && c.verified !== false && isWalletBlocked(c.wallet)
}

/** How a session signed in: its `am` claim, else a wallet claim means a wallet sign-in; with its wallet or email. */
export function signInOf(u: { wallet?: string | null; email?: string | null; am?: SignInMethod } | null | undefined): LinkedBy {
  if (!u) return { method: 'unknown' }
  const wallet = u.wallet ? u.wallet.toLowerCase() : null
  const method: SignInMethod = u.am ?? (wallet ? 'wallet' : 'unknown')
  return { method, wallet: method === 'wallet' ? wallet : null, email: method === 'wallet' ? null : u.email?.toLowerCase() ?? null }
}

/** Two sessions signed in the same way: the same method and the same wallet (wallet) or email (email, OAuth). */
export function sameSignIn(a: LinkedBy | null | undefined, b: LinkedBy | null | undefined): boolean {
  if (!a || !b || a.method === 'unknown' || a.method !== b.method) return false
  return a.method === 'wallet' ? !!a.wallet && a.wallet === b.wallet : !!a.email && a.email === b.email
}

/** Blocks a wallet (no-op when it already is). True when this call made the block. */
export async function blockWallet(
  exec: Exec, wallet: string, o: { userId: string | null; requestId?: string | null; reason: 'reissue' | 'unlinked_by_admin'; byUserId: string | null; now: Date },
): Promise<boolean> {
  const w = wallet.toLowerCase()
  const made = await exec.insert(walletBlocks).values({ wallet: w, userId: o.userId, requestId: o.requestId ?? null, reason: o.reason, byUserId: o.byUserId, createdAt: o.now })
    .onConflictDoNothing().returning({ wallet: walletBlocks.wallet })
  if (made.length && o.userId) {
    await exec.insert(accountWalletEvents).values({ userId: o.userId, wallet: w, event: 'blocked', byUserId: o.byUserId, requestId: o.requestId ?? null, note: o.reason, at: o.now })
  }
  return made.length > 0
}

/** Lifts the block a reissue request made (only that one: a block from elsewhere stays). */
export async function unblockForRequest(exec: Exec, wallet: string, requestId: string, o: { userId: string | null; byUserId: string | null; now: Date }): Promise<boolean> {
  const w = wallet.toLowerCase()
  const gone = await exec.delete(walletBlocks).where(and(eq(walletBlocks.wallet, w), eq(walletBlocks.requestId, requestId), eq(walletBlocks.reason, 'reissue'))).returning({ wallet: walletBlocks.wallet })
  if (gone.length && o.userId) {
    await exec.insert(accountWalletEvents).values({ userId: o.userId, wallet: w, event: 'unblocked', byUserId: o.byUserId, requestId, at: o.now })
  }
  return gone.length > 0
}

/** Removes a wallet from an account (its sign-in method), keeping its link history in account_wallet_events. */
export async function unlinkWallet(
  exec: Exec, userId: string | null, wallet: string, o: { byUserId: string | null; requestId?: string | null; note?: string; now: Date },
): Promise<boolean> {
  const w = wallet.toLowerCase()
  const where = userId
    ? and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, w), eq(userAuthMethods.userId, userId))
    : and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, w))
  const gone = await exec.delete(userAuthMethods).where(where).returning()
  for (const m of gone) {
    await exec.insert(accountWalletEvents).values({
      userId: m.userId, wallet: w, event: 'unlinked', linkedAt: m.linkedAt ?? m.createdAt, linkedBy: m.linkedBy,
      byUserId: o.byUserId, requestId: o.requestId ?? null, note: o.note ?? null, at: o.now,
    })
  }
  return gone.length > 0
}
