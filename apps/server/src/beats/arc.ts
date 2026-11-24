import { ringCodeOf, RING_DEFAULT_DIAMETER_MM } from '@virvixr/shared'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { beatArcs, beats } from '../db/schema.js'
import { allocateRingId } from '../ar/arcs.js'
import { paperPdf, type MarkerStyle } from '../ar/printfiles.js'
import { BeatError } from './errors.js'
import { VISIBLE } from './visitor.js'

/**
 * The BEAT's one printed ARC, made on its first request (not by a go-live hook: the host sees the same either way).
 * Only a paid in-person BEAT has one; a clash on the unique ids (two requests at once) retries and ends up with the winner's.
 */
export async function ensureBeatArc(beatId: string): Promise<{ code: string; ringId: number }> {
  const [beat] = await db.select({ status: beats.status, type: beats.locationType }).from(beats).where(eq(beats.id, beatId))
  if (!beat || beat.type !== 'in_person' || !VISIBLE.includes(beat.status)) throw new BeatError(409, 'no_arc', 'Only in-person BEATs have an ARC.')
  for (let attempt = 0; attempt < 3; attempt++) {
    const [have] = await db.select({ code: beatArcs.code, ringId: beatArcs.ringId }).from(beatArcs).where(eq(beatArcs.beatId, beatId))
    if (have) return have
    const ringId = await allocateRingId(db)
    const [made] = await db.insert(beatArcs).values({ beatId, ringId, code: ringCodeOf(ringId), kind: 'printed' }).onConflictDoNothing().returning({ code: beatArcs.code, ringId: beatArcs.ringId })
    if (made) return made
  }
  throw new Error('could not create the BEAT ARC')
}

/** The paper PDF of the BEAT's ARC, its caption telling the host what to do with it. */
export async function beatArcPdf(beatId: string, style: MarkerStyle): Promise<{ pdf: Buffer; code: string }> {
  const { code, ringId } = await ensureBeatArc(beatId)
  const [beat] = await db.select({ venue: beats.locationVenue }).from(beats).where(eq(beats.id, beatId))
  const caption = `Print this ARC and put it up at ${beat?.venue ?? 'the venue'}. Visitors scan it with the Virvi app to earn this BEAT.`
  return { pdf: paperPdf(ringId, RING_DEFAULT_DIAMETER_MM, style, caption), code }
}
