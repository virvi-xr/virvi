import { and, eq, inArray } from 'drizzle-orm'
import type { SignInMethod } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { accountWalletEvents, apiKeys, arDevices, hyperfyPairings, hyperfyWorlds, userAuthMethods, walletBlocks, type LinkedBy } from '../db/schema.js'
import { forgetPairings } from '../hyperfy/pairing.js'
import { devicesRevoked } from '../ar/devices.js'

/**
 * Wallet blocks and provenance (LIV-11, reissue fix round 1).
 *
 * A block is on BEATs everywhere, and on the account it was taken from (the owner's call, 2026-11-16: not on Virvi as a
 * whole). A blocked wallet can never track or claim a BEAT, or be a reissue's new wallet, on any account
 * (`isWalletBlocked`). On the account that blocked it (`walletBlockedOn`), every session carrying it stops working:
 * `authenticate` refuses its access tokens, `/api/auth/refresh` its refresh tokens, the rooms their passes; and it can't
 * sign in to that account or be linked to it again. Once it is off that account (a reissue unlinks it when done, an
 * admin unlink at once), signing in with it makes a new, separate account. A reissue's old wallet is blocked at
 * approval; an admin unlinking a wallet from an account blocks it too.
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
    super('This wallet can no longer sign in to this account.')
    this.name = 'WalletBlockedError'
  }
}

async function readBlock(wallet: string, exec: Pick<typeof db, 'select'>): Promise<boolean> {
  const [row] = await exec.select({ wallet: walletBlocks.wallet }).from(walletBlocks).where(eq(walletBlocks.wallet, wallet)).limit(1)
  return !!row
}
let blockReader = readBlock

/** Whether a wallet is blocked (from BEATs, on every account). A database failure throws (callers answer 503, never "not blocked"). */
export async function isWalletBlocked(wallet: string | null | undefined, exec: Pick<typeof db, 'select'> = db): Promise<boolean> {
  if (!wallet) return false
  return blockReader(wallet.toLowerCase(), exec)
}

async function readBlockOn(wallet: string, userId: string, exec: Pick<typeof db, 'select'>): Promise<boolean> {
  const [row] = await exec.select({ wallet: walletBlocks.wallet }).from(walletBlocks)
    .where(and(eq(walletBlocks.wallet, wallet), eq(walletBlocks.userId, userId))).limit(1)
  return !!row
}
let blockOnReader = readBlockOn

/** Whether a wallet is blocked on this account (the one it was taken from): its sessions there end. Throws on a database failure. */
export async function walletBlockedOn(wallet: string | null | undefined, userId: string | null | undefined, exec: Pick<typeof db, 'select'> = db): Promise<boolean> {
  if (!wallet || !userId) return false
  return blockOnReader(wallet.toLowerCase(), userId, exec)
}

/** Whether a wallet is still linked to an account that blocked it: it can't sign in (to that account) by any path. */
export async function walletSignInBlocked(wallet: string | null | undefined, exec: Pick<typeof db, 'select'> = db): Promise<boolean> {
  if (!wallet) return false
  const w = wallet.toLowerCase()
  const links = await exec.select({ userId: userAuthMethods.userId }).from(userAuthMethods)
    .where(and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, w)))
  for (const l of links) if (await walletBlockedOn(w, l.userId, exec)) return true
  return false
}

/** Tests replace the database reads (say, with ones that fail); null restores them. */
export function setWalletBlockReaderForTests(read: ((wallet: string, exec: Pick<typeof db, 'select'>) => Promise<boolean>) | null): void {
  blockReader = read ?? readBlock
  blockOnReader = read ? (wallet, _userId, exec) => read(wallet, exec) : readBlockOn
}

/** Whether a token's wallet claim is blocked on the token's account (rooms check this at join and at pass renewal; REST in authenticate). */
export async function claimsWalletBlocked(c: { id?: string | null; wallet?: string | null; verified?: boolean } | null | undefined): Promise<boolean> {
  return !!c?.wallet && c.verified !== false && walletBlockedOn(c.wallet, c.id)
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

export type RevokedCredentials = { apiKeys: string[]; pairings: Array<{ id: string; world: string }>; devices: Array<{ id: string; name: string }> }

/**
 * Revokes everything on the account that can act without a fresh sign-in (N1): every API key, Hyperfy pairing and AR
 * headset, in the caller's transaction (P3: approval fails if this fails). Simpler and safer than working out which ones
 * the compromised wallet's sessions made; the person sets them up again. Call `afterCredentialsRevoked` once the
 * transaction has committed, to clear the pairing and headset caches.
 */
async function revokeCredentials(exec: Exec, userId: string): Promise<RevokedCredentials> {
  const keys = await exec.delete(apiKeys).where(eq(apiKeys.userId, userId)).returning({ name: apiKeys.name })
  const open = ['approved', 'claimed']
  const pairings = await exec.select({ id: hyperfyPairings.id, world: hyperfyWorlds.name }).from(hyperfyPairings)
    .innerJoin(hyperfyWorlds, eq(hyperfyWorlds.id, hyperfyPairings.worldId))
    .where(and(eq(hyperfyPairings.userId, userId), inArray(hyperfyPairings.status, open)))
  if (pairings.length) await exec.update(hyperfyPairings).set({ status: 'revoked', codeHash: null }).where(inArray(hyperfyPairings.id, pairings.map((p) => p.id)))
  const devices = await exec.select({ id: arDevices.id, name: arDevices.deviceName }).from(arDevices)
    .where(and(eq(arDevices.userId, userId), inArray(arDevices.status, open)))
  if (devices.length) await exec.update(arDevices).set({ status: 'revoked', codeHash: null }).where(inArray(arDevices.id, devices.map((d) => d.id)))
  return { apiKeys: keys.map((k) => k.name), pairings, devices: devices.map((d) => ({ id: d.id, name: d.name ?? 'unnamed headset' })) }
}
let credentialRevoker = revokeCredentials

export function revokeAccountCredentials(exec: Exec, userId: string): Promise<RevokedCredentials> {
  return credentialRevoker(exec, userId)
}

/** Tests replace the revocation (say, with one that fails); null restores it. */
export function setCredentialRevokerForTests(fn: ((exec: Exec, userId: string) => Promise<RevokedCredentials>) | null): void {
  credentialRevoker = fn ?? revokeCredentials
}

export async function afterCredentialsRevoked(r: RevokedCredentials): Promise<void> {
  forgetPairings(r.pairings.map((p) => p.id))
  await devicesRevoked(r.devices.map((d) => d.id))
}

/**
 * Every wallet the account has ever had (P1): its verified wallets, the blocked ones that name it, and those in its
 * wallet history (unlinked or blocked). Read it before anything clears links, as delete-my-data does.
 */
export async function walletsEverOf(userId: string): Promise<string[]> {
  const linked = await db.select({ w: userAuthMethods.identifier }).from(userAuthMethods)
    .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'wallet')))
  const blocked = await db.select({ w: walletBlocks.wallet }).from(walletBlocks).where(eq(walletBlocks.userId, userId))
  const events = await db.select({ w: accountWalletEvents.wallet }).from(accountWalletEvents).where(eq(accountWalletEvents.userId, userId))
  return [...new Set([...linked, ...blocked, ...events].map((r) => r.w.toLowerCase()))].filter((w) => /^0x[0-9a-f]{40}$/.test(w))
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
