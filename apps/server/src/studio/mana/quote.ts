import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { studioPayments } from '../../db/schema.js'
import { config } from '../../config.js'
import type { Exec } from '../quota.js'
import type { ManaRate } from './rate.js'

/**
 * A MANA quote: the USD price at the current rate, rounded up to a millionth of a MANA, plus a random salt in the
 * low 12 digits of wei, so each open quote asks for its own exact amount and a transfer matches one payment by amount.
 */

const STEP = 10n ** 12n // wei in a millionth of a MANA
const MAX_TRIES = 5

export type ManaQuote = {
  paymentId: string; amountWei: string; recipient: string; token: string; chainId: 137
  usdCents: number; usdPerMana: number; expiresAt: string
}

/** usdCents at usdPerMana in wei, rounded up to a multiple of 10^12 (never below the USD price), with no salt. */
export function manaWeiAtLeast(usdCents: number, usdPerMana: number): bigint {
  if (!Number.isInteger(usdCents) || usdCents <= 0) throw new Error(`not a price: ${usdCents}`)
  if (!Number.isFinite(usdPerMana) || usdPerMana <= 0) throw new Error(`not a rate: ${usdPerMana}`)
  // usdCents / 100 / usdPerMana MANA, in millionths of a MANA, rounded up
  return BigInt(Math.ceil((usdCents * 10_000) / usdPerMana)) * STEP
}

/**
 * A quote's amount: usdCents at usdPerMana in wei, rounded up to a multiple of 10^12, plus salt (1..10^12-1), so open
 * quotes never ask for the same amount. The owner's MANA-back sends need no salt: they use manaWeiAtLeast.
 */
export function manaWeiFor(usdCents: number, usdPerMana: number, salt: bigint): bigint {
  const wei = manaWeiAtLeast(usdCents, usdPerMana)
  if (salt < 1n || salt >= STEP) throw new Error('the salt must be 1..10^12-1')
  return wei + salt
}

const randomSalt = () => (BigInt('0x' + randomBytes(8).toString('hex')) % (STEP - 1n)) + 1n
let saltSource: () => bigint = randomSalt

/** Tests fix the salts; null puts the random ones back. */
export function setManaSaltSource(fn: (() => bigint) | null): void {
  saltSource = fn ?? randomSalt
}

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505'

/**
 * Prices a pending MANA payment's due cents at the rate and records the amount and rate on it. An amount another open
 * quote already asks for draws a new salt (in a savepoint, so the caller's transaction survives), up to 5 times.
 */
export async function setManaAmount(tx: Exec, paymentId: string, usdCents: number, rate: ManaRate): Promise<string> {
  for (let i = 0; i < MAX_TRIES; i++) {
    const amountWei = manaWeiFor(usdCents, rate.usdPerMana, saltSource()).toString()
    try {
      await tx.transaction((sp) => sp.update(studioPayments)
        .set({ manaAmountWei: amountWei, manaUsdRate: String(rate.usdPerMana) }).where(eq(studioPayments.id, paymentId)))
      return amountWei
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
    }
  }
  throw new ManaBusy()
}

export class ManaBusy extends Error {
  constructor() { super('mana_busy') }
}

/** The quote a pending MANA payment stands for. */
export function manaQuoteOf(pay: {
  id: string; amountCents: number; creditHeldCents: number; manaAmountWei: string | null; manaUsdRate: string | null; expiresAt: Date | null
}): ManaQuote {
  return {
    paymentId: pay.id,
    amountWei: pay.manaAmountWei!,
    recipient: config.studioMana.recipient!,
    token: config.studioMana.token,
    chainId: config.studioMana.chainId,
    usdCents: pay.amountCents - pay.creditHeldCents,
    usdPerMana: Number(pay.manaUsdRate),
    expiresAt: pay.expiresAt!.toISOString(),
  }
}
