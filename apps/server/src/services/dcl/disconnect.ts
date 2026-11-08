/**
 * Disconnecting a Decentraland destination from its scene: the destination row goes, so the World (or the parcels) can
 * be connected to another scene. Shared by `DELETE /api/dcl/destinations/:id` and by deleting a scene with "Remove from
 * Decentraland" ticked (LIV-83), which disconnects once the scene is off the World or the parcels.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { dclWorldDestinations, sceneDeployments, sceneImports } from '../../db/schema.js'
import { BLOCKING, lockLocation, sameLocation } from '../import/imports.js'
import { destinationLocation, type Destination } from './world-deployer.js'

/** Set on a deploy still waiting for its signature when its World is disconnected: that signature can no longer be used. */
export const DISCONNECTED = 'This World was disconnected from the scene, so this deploy was cancelled.'

/** Something is building or deploying to the destination right now: nothing was disconnected. */
export class DisconnectBusyError extends Error {
  constructor(public code: 'import_in_progress' | 'deploy_in_progress', message: string) {
    super(message)
  }
}

/**
 * Removes the destination row under the locks uploads, import deploys, mode A deploys and signed submits take, so
 * nothing starts between the checks and the delete. A deploy still waiting for a signature fails (DISCONNECTED).
 * Throws DisconnectBusyError while an upload or a deploy is running; returns the removed row, or null when it was gone.
 */
export async function disconnectDestination(dest: Destination): Promise<Destination | null> {
  const loc = destinationLocation(dest)
  const place = dest.kind === 'parcels' ? 'these parcels' : 'this World'
  return db.transaction(async (tx) => {
    await lockLocation(tx, loc)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${dest.id}))`)
    const uploading = await tx.query.sceneImports.findFirst({
      where: and(sameLocation(loc), inArray(sceneImports.status, [...BLOCKING])),
      columns: { id: true },
    })
    if (uploading) {
      throw new DisconnectBusyError('import_in_progress', `An upload to ${place} is being built or deployed right now. Wait for it to finish, then disconnect.`)
    }
    const busy = await tx.query.sceneDeployments.findFirst({
      where: and(eq(sceneDeployments.destinationId, dest.id), inArray(sceneDeployments.status, ['pending', 'building', 'deploying'])),
      columns: { id: true },
    })
    const importing = await tx.query.sceneImports.findFirst({
      where: and(eq(sceneImports.destinationId, dest.id), eq(sceneImports.status, 'deploying')),
      columns: { id: true },
    })
    if (busy || importing) {
      throw new DisconnectBusyError('deploy_in_progress', `A deploy is going out to ${place} right now. Wait for it to finish, then disconnect.`)
    }
    // A submit claims its row under the destination's lock, so it either got there first (busy above) or finds it failed
    await tx.update(sceneDeployments).set({ status: 'failed', errorMessage: DISCONNECTED })
      .where(and(eq(sceneDeployments.destinationId, dest.id), eq(sceneDeployments.status, 'awaiting_signature')))
    const [row] = await tx.delete(dclWorldDestinations).where(eq(dclWorldDestinations.id, dest.id)).returning()
    return row ?? null
  })
}
