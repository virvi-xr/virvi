import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { BEAT_CHAIN_INFO, BEAT_CHAINS, type BeatChain, type BeatStatus } from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { beats, mediaAssets } from '../db/schema.js'

/**
 * BEAT token metadata (LIV-11): public JSON that wallets and marketplaces read, at the contract's URI
 * `{PUBLIC_URL}/api/beats/metadata/{chain}/{id}.json` (the base URI is set on the contract at deploy, contracts/README.md). `{id}` is decimal or the 64 lowercase hex digits ERC-1155's `{id}` substitution
 * gives; `contract.json` is the ERC-7572 collection metadata. No bearer is read. Dark (404) unless BEAT_ENABLED, by the
 * hook in beats/routes.ts.
 */

export const BEAT_METADATA_ROUTE = '/api/beats/metadata/:chain/:file'
/** Served from go-live (when the BEAT goes on chain with locked metadata) and after; any BEAT already on chain is served
 * whatever its status, so live tokens keep their metadata after an admin cancel (standards M5). */
const SHOWN: BeatStatus[] = ['live', 'ended']
const MAX_ID = (1n << 63n) - 1n
const DECIMAL = /^(0|[1-9][0-9]*)\.json$/
const HEX = /^([0-9a-f]{64})\.json$/
const COLLECTION_DESCRIPTION = "BEATs are free attendance tokens from Virvi events. Each one shows that a wallet signed in from the event's scene and stayed connected for the minimum time. Hosts pay for them; visitors never pay or sign anything. Each token says whether it can be transferred."

const base = (url: string) => url.replace(/\/+$/, '') + '/'
/** A URL made absolute against the server (a local upload's public URL is a path). */
function absolute(url: string): string {
  try {
    return new URL(url, base(config.publicUrl)).toString()
  } catch {
    return virviLogoUrl()
  }
}
/** The Virvi icon the web app serves (square PNG). */
export const virviLogoUrl = () => new URL('icon-512.png', base(config.webAppUrl)).toString()

/** A BEAT's image as an absolute URL: the frozen copy, else the live media file, else the Virvi logo. */
export function beatImageUrl(frozenUrl: string | null, mediaUrl: string | null): string {
  if (frozenUrl) return absolute(frozenUrl)
  if (mediaUrl) return absolute(mediaUrl)
  return virviLogoUrl()
}

/** The token id named by a file, or null (not canonical, or past the bigint column). */
export function parseTokenFile(file: string): bigint | null {
  const d = DECIMAL.exec(file)
  const h = d ? null : HEX.exec(file)
  if (!d && !h) return null
  const id = d ? BigInt(d[1]) : BigInt(`0x${h![1]}`)
  return id > MAX_ID ? null : id
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000)

/** The plain line a non-tradeable BEAT's description ends with (standards M1): marketplaces show a Sell button anyway. */
export const NOT_TRADEABLE_NOTE = "This BEAT can't be sold or transferred. It stays in the wallet it was sent to."
/** Where every BEAT's token links to (standards M2): there is no public page per BEAT yet. */
export const BEAT_EXTERNAL_URL = 'https://virvi.io/beats'

type Row = typeof beats.$inferSelect

/** The description's "Where" line: the location's label, with an online event's link. */
function whereLine(b: Row): string | null {
  if (!b.locationLabel) return null
  if (b.locationType === 'online' && b.locationUrl) return `Where: ${b.locationLabel} (${b.locationUrl})`
  return `Where: ${b.locationLabel}`
}

export async function tokenMetadata(chain: BeatChain, id: bigint) {
  const [b] = await db.select().from(beats)
    .where(and(eq(beats.chain, chain), sql`${beats.tokenId} = ${id.toString()}::bigint`, or(inArray(beats.status, SHOWN), isNotNull(beats.createdOnChainTx))))
  if (!b) return null
  const media = b.imageUrl || !b.imageMediaId ? null : await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, b.imageMediaId), columns: { publicUrl: true } })
  const description = [b.description, whereLine(b), b.tradeable ? null : NOT_TRADEABLE_NOTE].filter((x): x is string => !!x).join('\n\n')
  return {
    name: b.name,
    description,
    image: beatImageUrl(b.imageUrl, media?.publicUrl ?? null),
    external_url: BEAT_EXTERNAL_URL,
    attributes: [
      { trait_type: 'Starts', display_type: 'date', value: unix(b.startsAt) },
      // The scheduled end, also after the host ended it early (standards M7); the actual end is its own attribute
      { trait_type: 'Ends', display_type: 'date', value: unix(b.scheduledEndsAt ?? b.endsAt) },
      ...(b.scheduledEndsAt ? [{ trait_type: 'Ended early', display_type: 'date', value: unix(b.endsAt) }] : []),
      { trait_type: 'Tradeable', value: b.tradeable ? 'Yes' : 'No' },
      // Searchable on marketplaces that have no soulbound display (standards M1)
      { trait_type: 'Transfers', value: b.tradeable ? 'Transferable' : 'Non-transferable (soulbound)' },
      { trait_type: 'Location type', value: b.locationType === 'in_person' ? 'In person' : 'Virtual' },
      ...(b.locationLabel ? [{ trait_type: 'Location', value: b.locationLabel }] : []),
      { trait_type: 'Supply', display_type: 'number', value: b.supplyCap },
      { trait_type: 'Minimum minutes', display_type: 'number', value: Math.round(b.minPresentSeconds / 60) },
      { trait_type: 'Network', value: BEAT_CHAIN_INFO[b.chain].label },
    ],
  }
}

/** ERC-7572 collection metadata (standards M3). No royalties: BEATs carry none, by ruling. */
export function collectionMetadata() {
  return {
    name: 'Virvi BEAT',
    symbol: 'BEAT',
    description: COLLECTION_DESCRIPTION,
    image: virviLogoUrl(),
    featured_image: virviLogoUrl(),
    external_link: 'https://virvi.io',
  }
}

export default async function beatMetadataRoutes(app: FastifyInstance) {
  const missing = (reply: FastifyReply) => reply.status(404).header('access-control-allow-origin', '*').send({ error: 'not_found', message: 'Not found.' })

  app.get<{ Params: { chain: string; file: string } }>(BEAT_METADATA_ROUTE, async (request, reply) => {
    const { chain, file } = request.params
    if (!(BEAT_CHAINS as readonly string[]).includes(chain)) return missing(reply)
    let body: object | null
    if (file === 'contract.json') {
      body = collectionMetadata()
    } else {
      const id = parseTokenFile(file)
      body = id === null ? null : await tokenMetadata(chain as BeatChain, id)
    }
    if (!body) return missing(reply)
    return reply
      .header('access-control-allow-origin', '*')
      .header('cache-control', 'public, max-age=300')
      .type('application/json')
      .send(body)
  })
}
