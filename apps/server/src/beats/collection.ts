import type { FastifyInstance } from 'fastify'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getAddress, isAddress } from 'ethers'
import { beatTokenUrl, beatTxUrl, type CollectedBeat } from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { beatClaims, beatHoldings, beats, mediaAssets, userAuthMethods } from '../db/schema.js'
import { beatImageUrl, beatPlace } from './metadata.js'

/**
 * The BEAT collection (LIV-185): the BEATs wallets hold, from the holdings index (holdings.ts), joined to Virvi's BEAT.
 * A holding with no BEAT row (another project's token on the contract, or another chain) is never shown. A holding whose
 * `replaced_by` is set was reissued away from that wallet, so the old wallet no longer counts it. Every contract in
 * `beats.contract_address` is Virvi's shared contract today, so every BEAT is `basic`.
 */
export async function collectionFor(wallets: string[], opts: { includeClaimTimes: boolean }): Promise<CollectedBeat[]> {
  const lower = [...new Set(wallets.map((w) => w.toLowerCase()))]
  if (lower.length === 0) return []
  const chain = config.beats.chain
  const rows = await db.select({
    holding: beatHoldings,
    beat: beats,
    mediaUrl: mediaAssets.publicUrl,
    claim: { mintTx: beatClaims.mintTx, claimedAt: beatClaims.claimedAt, id: beatClaims.id },
  })
    .from(beatHoldings)
    .innerJoin(beats, and(
      eq(beats.chain, beatHoldings.chain),
      sql`lower(${beats.contractAddress}) = ${beatHoldings.contract}`,
      sql`${beats.tokenId} = ${beatHoldings.tokenId}`,
    ))
    .leftJoin(mediaAssets, eq(mediaAssets.id, beats.imageMediaId))
    .leftJoin(beatClaims, and(
      eq(beatClaims.beatId, beats.id),
      eq(beatClaims.status, 'minted'),
      sql`lower(${beatClaims.wallet}) = ${beatHoldings.wallet}`,
    ))
    .where(and(eq(beatHoldings.chain, chain), inArray(beatHoldings.wallet, lower), isNull(beatHoldings.replacedBy)))
    .orderBy(desc(beats.startsAt), beats.tokenId, beatHoldings.wallet)

  return rows.map(({ holding: h, beat: b, mediaUrl, claim }): CollectedBeat => {
    const earned = !!claim?.id
    const contract = getAddress(h.contract)
    const tokenId = h.tokenId.toString()
    return {
      tokenId, contract, chain: h.chain, kind: 'basic',
      wallet: getAddress(h.wallet),
      quantity: Number(h.balance),
      earned,
      name: b.name,
      imageUrl: beatImageUrl(b.imageUrl, mediaUrl ?? null),
      place: beatPlace(b),
      startsAt: b.startsAt.toISOString(),
      endsAt: (b.scheduledEndsAt ?? b.endsAt).toISOString(),
      tradeable: b.tradeable,
      tokenUrl: beatTokenUrl(h.chain, contract, tokenId),
      mintTxUrl: earned && claim.mintTx ? beatTxUrl(h.chain, claim.mintTx) : null,
      claimedAt: opts.includeClaimTimes && earned && claim.claimedAt ? claim.claimedAt.toISOString() : null,
    }
  })
}

/** The account's linked wallets (checksummed). */
export async function walletsOf(userId: string): Promise<string[]> {
  const rows = await db.select({ identifier: userAuthMethods.identifier }).from(userAuthMethods)
    .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'wallet')))
  return rows.map((r) => r.identifier).filter((w) => isAddress(w.toLowerCase())).map((w) => getAddress(w.toLowerCase()))
}

export const WALLET_BEATS_ROUTE = '/api/wallets/:address/beats'

/** The public page's data: no account, no other wallet, no claim times. Dark (404) unless BEAT_ENABLED. */
export default async function walletBeatsRoutes(app: FastifyInstance) {
  app.get<{ Params: { address: string } }>(WALLET_BEATS_ROUTE, { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { address } = request.params
    if (!config.beats.enabled || !isAddress(address.toLowerCase())) return reply.status(404).send({ error: 'not_found', message: 'Not found.' })
    const wallet = getAddress(address.toLowerCase())
    return reply.header('cache-control', 'public, max-age=60').send({ wallet, beats: await collectionFor([wallet], { includeClaimTimes: false }) })
  })
}
