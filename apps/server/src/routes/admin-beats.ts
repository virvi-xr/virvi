import type { FastifyInstance } from 'fastify'
import { desc, eq, sql } from 'drizzle-orm'
import { BEAT_CHAINS, beatTxUrl, type BeatChain } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { beatClaims, beatMintBatches, beats } from '../db/schema.js'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../auth/admin.js'
import { isUuid } from '../auth/scene-from.js'
import { beatChainClient } from '../beats/chain.js'
import { beatPaused, type BeatPauseReason, clearBeatPause, retryFailedClaims, safeErr } from '../beats/job.js'

const FAILED_LIST_MAX = 200
const BATCH_LIST_MAX = 50

/**
 * The admin BEAT page (LIV-11): minter balance and pauses per chain, claim counts, failed claims and the latest
 * transactions. Site admins only, and dark with the rest of BEAT: 404 unless BEAT_ENABLED. Responses carry visitors'
 * wallets (admins need them for failed claims); nothing here logs them.
 */
export default async function adminBeatRoutes(app: FastifyInstance) {
  // Before authenticate, like the other BEAT routes: a signed-out caller can't tell these exist while BEAT is dark
  app.addHook('onRequest', async (_request, reply) => {
    if (!config.beats.enabled) return reply.status(404).send({ error: 'not_found', message: 'Not found.' })
  })
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get('/api/admin/beats', async (_request, reply) => {
    const chains: Array<{ chain: BeatChain; contract: string | null; minter: string; balanceWei: string; paused: boolean; reason: BeatPauseReason }> = []
    for (const chain of BEAT_CHAINS) {
      const client = beatChainClient(chain)
      if (!client) continue
      let balanceWei = '0'
      try {
        balanceWei = (await client.balanceWei()).toString()
      } catch (err) {
        console.error(`[beats] admin balance read on ${chain} failed:`, safeErr(err))
      }
      const { paused, reason } = beatPaused(chain)
      chains.push({ chain, contract: config.beats.contracts[chain] ?? null, minter: client.minterAddress, balanceWei, paused, reason })
    }

    const countRows = await db.select({ status: beatClaims.status, n: sql<number>`count(*)::int` }).from(beatClaims).groupBy(beatClaims.status)
    const n = (s: string) => countRows.find((r) => r.status === s)?.n ?? 0
    const counts = { claimed: n('claimed'), minting: n('minting'), failed: n('failed') }

    const failed = await db.select({ beatId: beatClaims.beatId, name: beats.name, wallet: beatClaims.wallet, failReason: beatClaims.failReason })
      .from(beatClaims).innerJoin(beats, eq(beats.id, beatClaims.beatId))
      .where(eq(beatClaims.status, 'failed')).orderBy(desc(beatClaims.createdAt)).limit(FAILED_LIST_MAX)

    const rows = await db.select().from(beatMintBatches).orderBy(desc(beatMintBatches.createdAt), desc(beatMintBatches.nonce)).limit(BATCH_LIST_MAX)
    const batches = rows.map((b) => {
      const hash = b.txHashes.at(-1) ?? b.txHash
      return {
        id: b.id, chain: b.chain, kind: b.kind, tokenId: String(b.tokenId), nonce: b.nonce, status: b.status, attempts: b.attempts,
        txUrl: hash ? beatTxUrl(b.chain, hash) : null, createdAt: b.createdAt.toISOString(),
      }
    })
    return reply.send({ chains, counts, failed, batches })
  })

  app.post<{ Body: { beatId?: unknown } }>('/api/admin/beats/retry-failed', async (request, reply) => {
    const beatId = request.body?.beatId
    if (beatId !== undefined && (typeof beatId !== 'string' || !isUuid(beatId))) return reply.status(400).send({ error: 'bad_beat_id', message: 'Not a BEAT id.' })
    return reply.send({ retried: await retryFailedClaims(beatId as string | undefined) })
  })

  // An id_conflict pause is sticky: an admin lifts it once the clash has been looked into
  app.post<{ Body: { chain?: unknown } }>('/api/admin/beats/clear-pause', async (request, reply) => {
    const chain = request.body?.chain
    if (typeof chain !== 'string' || !(BEAT_CHAINS as readonly string[]).includes(chain)) return reply.status(400).send({ error: 'bad_chain', message: 'Unknown chain.' })
    clearBeatPause(chain as BeatChain)
    return reply.send({ ok: true })
  })
}
