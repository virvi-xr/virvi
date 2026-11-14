import { sql } from 'drizzle-orm'
import type { db } from '../db/connection.js'

export type BeatTx = Pick<typeof db, 'select' | 'execute'>

/**
 * One writer at a time per BEAT: edit, cancel and payment confirmation (and Task 7's paid -> live) take it. An advisory
 * lock, not only a row lock: refundBeat runs on its own connection while cancel holds this, and writes the BEAT's row.
 */
export async function lockBeat(tx: BeatTx, beatId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`beat:${beatId}`}))`)
}
