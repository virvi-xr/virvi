import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import type { SceneRequestContext } from '../middleware/dcl-auth.js'
import { getActiveSetup, releaseIfRedeployed } from '../setup/setups.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'
import { isOfficialRealm, isWorldRealm } from './official-realms.js'
import { isSceneDeleted } from '../scenes/live.js'

export interface SceneBinding { locationId: string | null; sceneId: string | null }
const VISITOR: SceneBinding = { locationId: null, sceneId: null }

const isWorld = isWorldRealm

/** Same keys as @virvixr/shared locationKeyFor, built only from the signed context. */
export function locationKeyForContext(ctx: SceneRequestContext, wallet: string, preview: boolean): string {
  const place = isWorld(ctx) ? ctx.realm.serverName.toLowerCase() : ctx.parcel
  if (preview) return `preview:${wallet.toLowerCase()}:${place}`
  return isWorld(ctx) ? `world:${place}` : `gc:${place}`
}

/**
 * The Virvi scene a signed scene request may act on: the active setup at its location. Anything uncertain → visitor.
 * Outside local preview, only official Decentraland realms bind (the realm controls serverName, parcel and code),
 * and the signed scene entity must be the deployment the setup recorded (when none is recorded, the live one, if the team deployed it).
 */
export async function bindSceneRequest(ctx: SceneRequestContext, wallet: string, opts: { preview?: boolean } = {}): Promise<SceneBinding> {
  if (!opts.preview && !(await isOfficialRealm(ctx))) return VISITOR
  const key = locationKeyForContext(ctx, wallet, !!opts.preview)
  let loc = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
  if (!loc && !isWorld(ctx) && !opts.preview) {
    loc = await db.query.analyticsScenes.findFirst({
      where: and(eq(analyticsScenes.kind, 'parcels'), sql`${analyticsScenes.parcels} @> ARRAY[${ctx.parcel}]::text[]`),
    })
  }
  if (!loc) return VISITOR
  let setup = await getActiveSetup(loc.id)
  if (!setup) return { locationId: loc.id, sceneId: null }
  if (!opts.preview && setup.deploymentEntityId !== ctx.sceneId) {
    // Not the recorded deployment, or none recorded: the redeploy check records the live one when the team
    // deployed it, and releases the setup when an outsider did.
    try {
      setup = await releaseIfRedeployed(setup, loc)
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return { locationId: loc.id, sceneId: null }
      throw err
    }
    if (!setup) return { locationId: loc.id, sceneId: null }
    // Still not the recorded deployment (unchanged, unknown deployer, nothing live, or another entity than the live one) → visitor.
    if (!setup.deploymentEntityId || setup.deploymentEntityId !== ctx.sceneId) return { locationId: loc.id, sceneId: null }
  }
  // A deleted scene (LIV-83) binds nothing: a deployment left up gets no scene pass, ads or HUD
  if (await isSceneDeleted(setup.virviSceneId)) return { locationId: loc.id, sceneId: null }
  return { locationId: loc.id, sceneId: setup.virviSceneId }
}
