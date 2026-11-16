import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm'
import { BEAT_CHAINS, BEAT_CLAIM_GRACE_MS, beatTxUrl, type BeatChain } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { beatClaims, beatMintBatches, beats } from '../db/schema.js'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../auth/admin.js'
import { isUuid } from '../auth/scene-from.js'
import { beatChainClient, beatChainMissing, beatMinGasWei } from '../beats/chain.js'
import { BeatError } from '../beats/errors.js'
import {
  adminListReissueRequests, adminLiftBlock, getSafeBatchFile, previewSafeBatch, proposeSafeBatch, reviewReissueRequest, unlinkAccountWallet, withdrawReissue,
} from '../beats/reissue.js'
import {
  BEAT_GIVEN_UP, beatBatchCostWei, beatPaused, type BeatPauseReason, clearBeatPause, giveUpFailedClaims, retryableFailed, retryFailedClaims, safeErr,
} from '../beats/job.js'

const FAILED_LIST_MAX = 200
const BATCH_LIST_MAX = 50

/**
 * The admin BEAT page (LIV-11): minter balance and pauses per chain (and the server's chain, with what it's missing,
 * when it has no minter or contract), claim counts, failed claims, the BEATs they hold open, and the latest transactions. Site admins only, and dark with the rest of BEAT: 404 unless BEAT_ENABLED. Responses carry visitors'
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
    const chains: Array<{
      chain: BeatChain; contract: string | null; minter: string | null; balanceWei: string | null; balanceError: boolean; paused: boolean
      reason: BeatPauseReason; missing: string[]
      /** BEAT_MIN_GAS_POL in wei; what one full mint batch costs at the last signed fees (null until known); and, while
       * paused for low gas with a readable balance, the suggested top-up: the minimum plus that batch, less the balance
       * (null when that isn't above 0). */
      minGasWei: string; batchCostWei: string | null; topUpWei: string | null
    }> = []
    for (const chain of BEAT_CHAINS) {
      const minGasWei = beatMinGasWei(chain)
      const client = beatChainClient(chain)
      if (!client) {
        // The server's own chain is shown even without a client: hosts can't pay for BEATs until it's set up
        if (chain === config.beats.chain) {
          chains.push({
            chain, contract: config.beats.contracts[chain] ?? null, minter: null, balanceWei: null, balanceError: false,
            paused: true, reason: 'no_client', missing: beatChainMissing(chain), minGasWei: minGasWei.toString(), batchCostWei: null, topUpWei: null,
          })
        }
        continue
      }
      let balanceWei: string | null = null
      let balanceError = false
      try {
        balanceWei = (await client.balanceWei()).toString()
      } catch (err) {
        balanceError = true
        console.error(`[beats] admin balance read on ${chain} failed:`, safeErr(err))
      }
      const { paused, reason } = beatPaused(chain)
      const batchCost = await beatBatchCostWei(chain)
      let topUpWei: string | null = null
      if (reason === 'low_gas' && balanceWei !== null) {
        // Never a top-up of 0: with nothing to suggest, the page shows the balance and the minimum only
        const need = minGasWei + (batchCost ?? 0n) - BigInt(balanceWei)
        if (need > 0n) topUpWei = need.toString()
      }
      chains.push({
        chain, contract: config.beats.contracts[chain] ?? null, minter: client.minterAddress, balanceWei, balanceError, paused, reason, missing: [],
        minGasWei: minGasWei.toString(), batchCostWei: batchCost?.toString() ?? null, topUpWei,
      })
    }

    const countRows = await db.select({ status: beatClaims.status, n: sql<number>`count(*)::int` }).from(beatClaims).groupBy(beatClaims.status)
    const n = (s: string) => countRows.find((r) => r.status === s)?.n ?? 0
    // Given-up claims are failed for good: counted apart, so "failed" is what a retry could still send
    const [gu] = await db.select({ n: sql<number>`count(*)::int` }).from(beatClaims)
      .where(and(eq(beatClaims.status, 'failed'), eq(beatClaims.failReason, BEAT_GIVEN_UP)))
    const givenUp = gu?.n ?? 0
    const counts = { claimed: n('claimed'), minting: n('minting'), failed: n('failed') - givenUp, givenUp }

    const failedRows = await db.select({ beatId: beatClaims.beatId, name: beats.name, wallet: beatClaims.wallet, failReason: beatClaims.failReason })
      .from(beatClaims).innerJoin(beats, eq(beats.id, beatClaims.beatId))
      .where(eq(beatClaims.status, 'failed')).orderBy(desc(beatClaims.createdAt)).limit(FAILED_LIST_MAX)
    const failed = failedRows.map((f) => ({ ...f, retryable: f.failReason !== BEAT_GIVEN_UP }))

    const rows = await db.select().from(beatMintBatches).orderBy(desc(beatMintBatches.createdAt), desc(beatMintBatches.nonce)).limit(BATCH_LIST_MAX)
    const batches = rows.map((b) => {
      const hash = b.txHash ?? b.txHashes.at(-1) ?? null
      return {
        id: b.id, chain: b.chain, kind: b.kind, tokenId: String(b.tokenId), nonce: b.nonce, status: b.status, attempts: b.attempts,
        txUrl: hash ? beatTxUrl(b.chain, hash) : null, createdAt: b.createdAt.toISOString(),
      }
    })
    // BEATs a give-up would let close: ended past the claim grace, not closed on chain, held by retryable failed claims
    const held = await db.select({ beatId: beats.id, name: beats.name, retryable: sql<number>`count(*)::int` })
      .from(beatClaims).innerJoin(beats, eq(beats.id, beatClaims.beatId))
      .where(and(
        eq(beats.status, 'ended'), lte(beats.endsAt, new Date(Date.now() - BEAT_CLAIM_GRACE_MS)), isNull(beats.closedOnChainAt), retryableFailed,
      ))
      .groupBy(beats.id, beats.name, beats.endsAt).orderBy(beats.endsAt)
    return reply.send({ chains, counts, failed, batches, held })
  })

  app.post<{ Body: { beatId?: unknown } }>('/api/admin/beats/retry-failed', async (request, reply) => {
    const beatId = request.body?.beatId
    if (beatId !== undefined && (typeof beatId !== 'string' || !isUuid(beatId))) return reply.status(400).send({ error: 'bad_beat_id', message: 'Not a BEAT id.' })
    return reply.send(await retryFailedClaims(beatId as string | undefined))
  })

  // Stop retrying a BEAT's failed claims so it can close on chain (they become final: `given_up`)
  app.post<{ Params: { id: string } }>('/api/admin/beats/:id/give-up', async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.status(400).send({ error: 'bad_beat_id', message: 'Not a BEAT id.' })
    try {
      return reply.send(await giveUpFailedClaims(id, new Date()))
    } catch (e) {
      if (e instanceof BeatError) return reply.status(e.status).send({ ...e.details, error: e.code, message: e.message })
      throw e
    }
  })

  // ── Reissue requests (beats/reissue.ts). Review and proposing the Safe files are separate steps, so a support role can
  // take the first later. The server never signs or sends a reissue: the admin Safe does.
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof BeatError) return reply.status(e.status).send({ ...e.details, error: e.code, message: e.message })
    throw e
  }

  const body = (request: { body?: unknown }) => (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
  const attempt = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return reply.send(await fn())
    } catch (e) {
      return fail(reply, e)
    }
  }

  app.get<{ Querystring: { status?: string; offset?: string } }>('/api/admin/beats/reissue-requests', async (request, reply) =>
    attempt(reply, () => adminListReissueRequests(request.query.status, request.query.offset)))

  for (const decision of ['approve', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(`/api/admin/beats/reissue-requests/:id/${decision}`, async (request, reply) =>
      attempt(reply, () => reviewReissueRequest(request.user.id, request.params.id, decision, body(request))))
  }

  // Read-only: the files proposing would make now (a live read), and those already proposed
  app.get<{ Params: { id: string }; Querystring: { chain?: string } }>('/api/admin/beats/reissue-requests/:id/safe-batch', async (request, reply) =>
    attempt(reply, () => previewSafeBatch(request.params.id, request.query.chain)))

  // Records the files (one Safe transaction each) and marks the request proposed
  app.post<{ Params: { id: string } }>('/api/admin/beats/reissue-requests/:id/propose', async (request, reply) =>
    attempt(reply, () => proposeSafeBatch(request.user.id, request.params.id, body(request).chain)))

  // One proposed file, exactly as recorded, as a download
  app.get<{ Params: { id: string; fileId: string } }>('/api/admin/beats/reissue-requests/:id/files/:fileId', async (request, reply) => {
    try {
      const { filename, file } = await getSafeBatchFile(request.params.id, request.params.fileId)
      return reply.header('content-disposition', `attachment; filename="${filename}"`).header('cache-control', 'no-store').type('application/json').send(file)
    } catch (e) {
      return fail(reply, e)
    }
  })

  // Voids a request (or one of its files) that hasn't landed; the Safe's pending transaction must be discarded too
  app.post<{ Params: { id: string } }>('/api/admin/beats/reissue-requests/:id/withdraw', async (request, reply) =>
    attempt(reply, () => withdrawReissue(request.user.id, request.params.id, body(request))))

  // Takes a (backdoor) wallet off the request's account and blocks it
  app.post<{ Params: { id: string } }>('/api/admin/beats/reissue-requests/:id/unlink-wallet', async (request, reply) =>
    attempt(reply, () => unlinkAccountWallet(request.user.id, request.params.id, body(request).wallet)))

  // Lifts a wallet's block (a reissue's, or an admin unlink's), with a note; logged on the account and the request
  app.post('/api/admin/beats/wallet-blocks/lift', async (request, reply) => attempt(reply, () => adminLiftBlock(request.user.id, body(request))))

  // An id_conflict pause is sticky: an admin lifts it once the clash has been looked into
  app.post<{ Body: { chain?: unknown } }>('/api/admin/beats/clear-pause', async (request, reply) => {
    const chain = request.body?.chain
    if (typeof chain !== 'string' || !(BEAT_CHAINS as readonly string[]).includes(chain)) return reply.status(400).send({ error: 'bad_chain', message: 'Unknown chain.' })
    clearBeatPause(chain as BeatChain)
    return reply.send({ ok: true })
  })
}
