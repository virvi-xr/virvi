import { randomRingId, parseRingCode, type AppArc, type ArMarkerLookup } from '@virvixr/shared'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { arMarkers, beatArcs, beats } from '../db/schema.js'
import { claimUntil, hidden, VISIBLE } from '../beats/visitor.js'
import { markerByCode } from './access.js'

/** Anything with `select`: the connection or a transaction. */
type Reader = Pick<typeof db, 'select'>

/** An ARC id no AR space marker and no BEAT ARC has (one id space for both), at most 20 tries. */
export async function allocateRingId(tx: Reader): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const ringId = randomRingId()
    const [marker] = await tx.select({ id: arMarkers.id }).from(arMarkers).where(eq(arMarkers.ringId, ringId)).limit(1)
    if (marker) continue
    const [arc] = await tx.select({ id: beatArcs.id }).from(beatArcs).where(eq(beatArcs.ringId, ringId)).limit(1)
    if (!arc) return ringId
  }
  throw new Error('could not allocate a free ARC id')
}

/**
 * What an ARC code opens in the app. A space ARC follows by-code's rule (`mayOpenSpace` says whether the caller may
 * see an unpublished space); a BEAT ARC answers only while its BEAT is paid, live or within the claim grace, and not hidden.
 */
export async function lookupArc(code: string, mayOpenSpace: (sceneId: string) => Promise<boolean> = async () => false): Promise<AppArc | null> {
  const marker = await markerByCode(code)
  if (marker) {
    if (!marker.published && !(await mayOpenSpace(marker.sceneId))) return null
    const lookup: ArMarkerLookup = {
      spaceId: marker.spaceId, floorId: marker.floorId, markerId: marker.markerId, spaceName: marker.spaceName, whereText: marker.whereText,
    }
    return { kind: 'space', lookup }
  }
  const ringId = parseRingCode(code)
  if (ringId === null) return null
  const [hit] = await db.select({ b: beats }).from(beatArcs).innerJoin(beats, eq(beats.id, beatArcs.beatId)).where(eq(beatArcs.ringId, ringId))
  if (!hit || !VISIBLE.includes(hit.b.status) || hidden(hit.b) || claimUntil(hit.b).getTime() < Date.now()) return null
  return { kind: 'beat', beatId: hit.b.id, name: hit.b.name }
}
