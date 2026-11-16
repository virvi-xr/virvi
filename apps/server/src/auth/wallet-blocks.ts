import { and, eq, inArray } from 'drizzle-orm'
import type { SignInMethod } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { accountWalletEvents, apiKeys, arDevices, hyperfyPairings, hyperfyWorlds, userAuthMethods, walletBlocks, type LinkedBy } from '../db/schema.js'
import { revokePairing } from '../hyperfy/pairing.js'
import { revokeDevice } from '../ar/devices.js'

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

/** A refusal for a blocked wallet, from any path that would sign it in or up (resolveVerifiedWalletUser). */
export class WalletBlockedError extends Error {
  readonly code = 'wallet_blocked'
  readonly status = 403
  constructor() {
    super('This wallet can no longer sign in to Virvi.')
    this.name = 'WalletBlockedError'
  }
}

async function readBlock(wallet: string, exec: Pick<typeof db, 'select'>): Promise<boolean> {
  const [row] = await exec.select({ wallet: walletBlocks.wallet }).from(walletBlocks).where(eq(walletBlocks.wallet, wallet)).limit(1)
  return !!row
}
let blockReader = readBlock

/** Whether a wallet is blocked. A database failure throws (callers answer 503, never "not blocked"). */
export async function isWalletBlocked(wallet: string | null | undefined, exec: Pick<typeof db, 'select'> = db): Promise<boolean> {
  if (!wallet) return false
  return blockReader(wallet.toLowerCase(), exec)
}

/** Tests replace the database read (say, with one that fails); null restores it. */
export function setWalletBlockReaderForTests(read: ((wallet: string, exec: Pick<typeof db, 'select'>) => Promise<boolean>) | null): void {
  blockReader = read ?? readBlock
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

/**
 * Revokes everything on the account that can act without a fresh sign-in (fix round 2, N1): every API key, Hyperfy
 * pairing and AR headset. Simpler and safer than working out which ones the compromised wallet's sessions made; the
 * person sets them up again. Returns what went, for the request's history.
 */
export async function revokeAccountCredentials(userId: string): Promise<{ apiKeys: string[]; pairings: string[]; devices: string[] }> {
  const keys = await db.delete(apiKeys).where(eq(apiKeys.userId, userId)).returning({ name: apiKeys.name })
  const pairings = await db.select({ id: hyperfyPairings.id, world: hyperfyWorlds.name }).from(hyperfyPairings)
    .innerJoin(hyperfyWorlds, eq(hyperfyWorlds.id, hyperfyPairings.worldId))
    .where(and(eq(hyperfyPairings.userId, userId), inArray(hyperfyPairings.status, ['approved', 'claimed'])))
  const gonePairings: string[] = []
  for (const p of pairings) if (await revokePairing(p.id, userId)) gonePairings.push(p.world)
  const devices = await db.select({ id: arDevices.id, name: arDevices.deviceName }).from(arDevices)
    .where(and(eq(arDevices.userId, userId), inArray(arDevices.status, ['approved', 'claimed'])))
  const goneDevices: string[] = []
  for (const d of devices) if (await revokeDevice(d.id, userId)) goneDevices.push(d.name ?? 'unnamed headset')
  return { apiKeys: keys.map((k) => k.name), pairings: gonePairings, devices: goneDevices }
}

/** An admin lifts a block (fix round 2, N8), with a note; logged on the account it names. Null when it isn't blocked. */
export async function liftBlock(exec: Exec, wallet: string, o: { byUserId: string; note: string; now: Date }): Promise<{ userId: string | null; requestId: string | null } | null> {
  const w = wallet.toLowerCase()
  const [gone] = await exec.delete(walletBlocks).where(eq(walletBlocks.wallet, w)).returning()
  if (!gone) return null
  if (gone.userId) {
    await exec.insert(accountWalletEvents).values({ userId: gone.userId, wallet: w, event: 'unblocked', byUserId: o.byUserId, requestId: gone.requestId, note: o.note, at: o.now })
  }
  return { userId: gone.userId, requestId: gone.requestId }
}
