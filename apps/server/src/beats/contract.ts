import { sql, type SQL } from 'drizzle-orm'
import { BEAT_CHAINS, type BeatChain } from '@virvixr/shared'
import { config } from '../config.js'
import { beats } from '../db/schema.js'
import { beatChainClient } from './chain.js'

/**
 * Which contract a BEAT is on (LIV-11, final fixes I-2). Each BEAT records the contract its create was planned for
 * (`beats.contract_address`). The job, the art sweep, the admin retries and reissue act on a BEAT only while that is
 * the chain's configured contract. A BEAT on another contract (the chain's contract was replaced) is retired: it is
 * shown read-only, and the metadata route keeps serving it, but it is never created, minted, closed, retried, reissued
 * or alerted on again.
 */

/** The chain's configured contract (its client's, else BEAT_CONTRACT_*), or null when it has none. */
export function beatContractOf(chain: BeatChain): string | null {
  return beatChainClient(chain)?.contract ?? config.beats.contracts[chain] ?? null
}

/** True when the BEAT is on its chain's configured contract. */
export function onBeatContract(b: { chain: BeatChain; contractAddress: string | null }): boolean {
  const c = beatContractOf(b.chain)
  return !!c && !!b.contractAddress && b.contractAddress.toLowerCase() === c.toLowerCase()
}

/** Retired: the BEAT was planned for a contract other than its chain's configured one (or the chain has none now). */
export function beatRetired(b: { chain: BeatChain; contractAddress: string | null }): boolean {
  return !!b.contractAddress && !onBeatContract(b)
}

/** SQL: a BEAT of this chain on its configured contract (false when the chain has none). */
export function onContractSql(chain: BeatChain): SQL {
  const c = beatContractOf(chain)
  return c ? sql`lower(${beats.contractAddress}) = ${c.toLowerCase()}` : sql`false`
}

/** SQL: a BEAT of this chain that may still be created on its configured contract (none recorded yet, or that one). */
export function creatableOnContractSql(chain: BeatChain): SQL {
  const c = beatContractOf(chain)
  return c ? sql`(${beats.contractAddress} is null or lower(${beats.contractAddress}) = ${c.toLowerCase()})` : sql`false`
}

/** SQL: the BEAT (of any chain) is not retired. */
export function notRetiredSql(): SQL {
  const on = BEAT_CHAINS.map((chain) => {
    const c = beatContractOf(chain)
    return c ? sql`(${beats.chain} = ${chain} and lower(${beats.contractAddress}) = ${c.toLowerCase()})` : sql`false`
  })
  return sql`(${beats.contractAddress} is null or ${sql.join(on, sql` or `)})`
}
