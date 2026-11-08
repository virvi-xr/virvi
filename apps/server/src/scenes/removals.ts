/**
 * What deleting a scene shuts down or removes (LIV-83), and how each is removed:
 *
 * - Virvi-hosted Hyperfy world ('hosted_world'): shut down for good (destroyHostedWorld: Fly app, database, files).
 * - Self-run Hyperfy world ('hyperfy_world'): Virvi unlinks itself (the world key's row goes), so its feed stops; the
 *   owner removes the Virvi app inside Hyperfy themselves.
 * - Decentraland World ('dcl_world'): a real undeploy, `DELETE /world/:name/scenes/:base` as a signed fetch (ADR-44,
 *   strict 6.x payload, metadata '{}'). The Worlds server (worlds-content-server src/controllers/handlers/
 *   scenes-handler.ts, undeploySceneHandler) removes every scene covering that parcel, for the name's owner or for a
 *   wallet whose deployment permission covers the full footprint of those scenes, so Virvi's parcel-scoped grant
 *   (mode 'virvi') signs it with Virvi's World key; otherwise the owner's wallet signs it in the browser. Never
 *   `DELETE /entities/:world` (the whole World).
 * - Genesis City parcels ('dcl_parcels'): an empty scene published over the same parcels, signed by Virvi's Genesis
 *   City wallet when it is an operator there (mode 'virvi'), otherwise by the owner's wallet in the browser.
 *
 * A removed Decentraland destination is then disconnected (services/dcl/disconnect.ts), so the World or the parcels can
 * be connected to another scene, and its deployments are stamped removed_at/removal_outcome. Each removal is a
 * scene_removals row with its outcome; one that failed can be retried, one that's done is never run again.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { dclWorldDestinations, hyperfyWorlds, sceneDeployments, sceneImports, sceneRemovals } from '../db/schema.js'
import { destroyHostedWorld, HostingError, type HostingDeps } from '../hyperfy/hosting.js'
import { buildEntity, chainSigner, signedFetchPayload, verifyChain, virviSignerFor, type AuthChain, type SceneMetadata } from '../services/dcl/entity.js'
import { getWorldsClient, WorldsError, type SignedRequest } from '../services/dcl/worlds-client.js'
import { CatalystError, contentServerFor } from '../services/dcl/catalyst-client.js'
import { worldOf } from '../services/dcl/world-of.js'
import { DisconnectBusyError, disconnectDestination } from '../services/dcl/disconnect.js'
import type { Destination } from '../services/dcl/world-deployer.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { parcelControl } from '../services/dcl/parcel-control.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'

export type RemovalKind = 'hosted_world' | 'hyperfy_world' | 'dcl_world' | 'dcl_parcels'
export type Removal = typeof sceneRemovals.$inferSelect

/** One line of the delete dialog: something running that the delete can shut down or remove. */
export interface RemovalOption {
  /** The hyperfy_worlds or dcl_world_destinations id; what DELETE's `remove` lists. */
  id: string
  kind: RemovalKind
  /** "Shut down my-world", "Remove the scene from party.dcl.eth". */
  label: string
  /** Ticked when the dialog opens (unticked for a Decentraland scene Virvi didn't build: the owner's own work). */
  defaultChecked: boolean
  /** Removing it needs the owner's wallet to sign in the browser. */
  needsSignature: boolean
  /** Decentraland: the live content there isn't Virvi's (adopted or uploaded); shown with the line. */
  ownContent?: boolean
}

/** Signed-fetch metadata on the undeploy, as on Virvi's permission calls (dcl-destinations.ts header). */
const UNDEPLOY_METADATA = '{}'
/** A browser-signed undeploy must reach Decentraland within its 60 s; Virvi refuses older ones (as the grant routes). */
const SIGNED_REQUEST_MAX_AGE_MS = 50_000
/** How long the owner has to sign an empty-scene deploy over their parcels (as a mode B deploy). */
export const EMPTY_SCENE_WINDOW_MS = 240_000

const isVirviSigned = (dest: Destination) => dest.mode === 'virvi' && !!dest.grantedAt && !!virviSignerFor(dest.kind)

/** The live content at the destination is the owner's own (adopted, or a scene they uploaded), not one Virvi built. */
async function ownContent(dest: Destination): Promise<boolean> {
  if (dest.adopted) return true
  const imported = await db.query.sceneImports.findFirst({
    where: and(eq(sceneImports.destinationId, dest.id), eq(sceneImports.status, 'deployed')),
    columns: { id: true },
  })
  return !!imported
}

const dclLabel = (dest: Destination) =>
  dest.kind === 'parcels' ? `Remove the scene from Genesis City parcels ${dest.base}` : `Remove the scene from ${worldOf(dest)}`

/** What's running for the scene that the delete dialog offers to shut down or remove. */
export async function removalOptions(sceneId: string): Promise<RemovalOption[]> {
  const worlds = await db.select().from(hyperfyWorlds).where(and(eq(hyperfyWorlds.sceneId, sceneId), isNull(hyperfyWorlds.purgedAt)))
  const dests = await db.query.dclWorldDestinations.findMany({ where: eq(dclWorldDestinations.sceneId, sceneId), orderBy: [dclWorldDestinations.createdAt] })
  const out: RemovalOption[] = []
  for (const w of worlds) {
    if (w.kind === 'hosted') out.push({ id: w.id, kind: 'hosted_world', label: `Shut down ${w.slug ?? w.name}`, defaultChecked: true, needsSignature: false })
    else out.push({ id: w.id, kind: 'hyperfy_world', label: `Remove the scene from ${w.name} (Hyperfy)`, defaultChecked: true, needsSignature: false })
  }
  for (const d of dests) {
    // Nothing of the scene's is live there yet (connected, never deployed): nothing to remove
    if (!d.lastEntityId && !d.adopted) continue
    const own = await ownContent(d)
    out.push({ id: d.id, kind: d.kind === 'parcels' ? 'dcl_parcels' : 'dcl_world', label: dclLabel(d), defaultChecked: !own, needsSignature: !isVirviSigned(d), ownContent: own })
  }
  return out
}

/** A removal as the dashboard sees it. */
export function publicRemoval(r: Removal) {
  return { id: r.id, kind: r.kind, label: r.label, status: r.status, errorMessage: r.errorMessage, finishedAt: r.finishedAt }
}

const failed = (id: string, message: string) =>
  db.update(sceneRemovals).set({ status: 'failed', errorMessage: message, pending: null, updatedAt: new Date() }).where(eq(sceneRemovals.id, id))
const done = (id: string) =>
  db.update(sceneRemovals).set({ status: 'done', errorMessage: null, pending: null, finishedAt: new Date(), updatedAt: new Date() }).where(eq(sceneRemovals.id, id))
const awaiting = (id: string) =>
  db.update(sceneRemovals).set({ status: 'awaiting_signature', errorMessage: null, updatedAt: new Date() }).where(eq(sceneRemovals.id, id))
const reload = async (id: string) => (await db.query.sceneRemovals.findFirst({ where: eq(sceneRemovals.id, id) }))!

function plain(err: unknown): string {
  if (err instanceof DisconnectBusyError) return err.message
  if (err instanceof WorldsError || err instanceof CatalystError) {
    if (err.status === 0) return "Couldn't reach Decentraland. Try again in a minute."
    let reason = err.body
    try {
      const j = JSON.parse(err.body) as { message?: string; error?: string }
      reason = j.message || j.error || err.body
    } catch { /* not JSON */ }
    return `Decentraland refused it: ${reason.slice(0, 300) || `HTTP ${err.status}`}`
  }
  if (err instanceof RemovalError) return err.message
  return 'Something went wrong on our side. Try again in a few minutes.'
}

export class RemovalError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

/**
 * Records the removals the delete asked for (`ids` from removalOptions; anything else is ignored) and runs each.
 * Ones that need the owner's signature are left awaiting_signature.
 */
export async function startRemovals(sceneId: string, ids: string[], by: string | null, deps?: Partial<HostingDeps>): Promise<Removal[]> {
  const options = await removalOptions(sceneId)
  const chosen = options.filter((o) => ids.includes(o.id))
  const out: Removal[] = []
  for (const o of chosen) {
    const dest = o.kind === 'dcl_world' || o.kind === 'dcl_parcels'
      ? await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, o.id) })
      : null
    const target = dest
      ? { world: dest.worldName, base: dest.base, parcels: dest.parcels, ownerWallet: dest.ownerWallet, mode: dest.mode }
      : {}
    const [row] = await db.insert(sceneRemovals)
      .values({ sceneId, kind: o.kind, targetId: o.id, label: o.label, target, requestedBy: by })
      .onConflictDoUpdate({ target: [sceneRemovals.sceneId, sceneRemovals.targetId], set: { status: 'pending', errorMessage: null, requestedBy: by, updatedAt: new Date() } })
      .returning()
    out.push(row.status === 'done' ? row : await runRemoval(row, deps))
  }
  return out
}

/** Runs one removal (a retry too). Never throws for a platform failure: the row says what happened. */
export async function runRemoval(r: Removal, deps?: Partial<HostingDeps>): Promise<Removal> {
  if (r.status === 'done') return r
  try {
    switch (r.kind as RemovalKind) {
      case 'hosted_world':
        try {
          await destroyHostedWorld(r.targetId, deps)
        } catch (err) {
          if (!(err instanceof HostingError && err.code === 'world_not_found')) throw err // gone already: done
        }
        await done(r.id)
        break
      case 'hyperfy_world':
        await db.delete(hyperfyWorlds).where(and(eq(hyperfyWorlds.id, r.targetId), eq(hyperfyWorlds.kind, 'self')))
        await done(r.id)
        break
      case 'dcl_world':
      case 'dcl_parcels': {
        const dest = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, r.targetId) })
        if (!dest) {
          await failed(r.id, 'This destination was disconnected from the scene, so Virvi can no longer remove the scene there. Remove it in the Creator Hub or the Builder.')
          break
        }
        if (!isVirviSigned(dest)) {
          await awaiting(r.id)
          break
        }
        const signer = virviSignerFor(dest.kind)!
        if (dest.kind === 'parcels') {
          const { entityId, files } = await emptySceneEntity(dest, Date.now())
          await contentServerFor(dest).deploy({ entityId, authChain: await signer.signChain(entityId), files })
          await finishDcl(r, dest, 'emptied')
        } else {
          const req = undeployRequest(dest, Date.now())
          await getWorldsClient().sendSigned(req, await signer.signChain(signedFetchPayload(req.method, req.path, req.timestamp, req.metadata)))
          await finishDcl(r, dest, 'undeployed')
        }
        break
      }
    }
  } catch (err) {
    console.error('[scene-removals] removal failed:', r.id, r.kind, err instanceof Error ? err.message : err)
    await failed(r.id, r.kind === 'hosted_world' ? "This world couldn't be shut down just now. Try again." : plain(err))
  }
  return reload(r.id)
}

/** The scene is off the destination: stamp its deployments, disconnect it, and the removal is done. */
async function finishDcl(r: Removal, dest: Destination, outcome: 'undeployed' | 'emptied') {
  const now = new Date()
  await db.update(sceneDeployments)
    .set({ removedAt: now, removalOutcome: outcome })
    .where(and(eq(sceneDeployments.destinationId, dest.id), eq(sceneDeployments.status, 'deployed'), isNull(sceneDeployments.removedAt)))
  await db.update(sceneRemovals).set({ target: { ...r.target, removedAt: now.toISOString(), outcome }, updatedAt: now }).where(eq(sceneRemovals.id, r.id))
  await disconnectDestination(dest)
  await done(r.id)
}

/** The undeploy of the scene on the World's base parcel (never the whole World). */
export function undeployRequest(dest: Pick<Destination, 'worldName' | 'base'>, timestamp: number): SignedRequest {
  // The coordinate goes in the path as is ("x,y"): the Worlds server signs and checks ctx.url.pathname, where a comma stays literal
  return { method: 'DELETE', path: `/world/${encodeURIComponent(worldOf(dest))}/scenes/${dest.base}`, metadata: UNDEPLOY_METADATA, timestamp }
}

const EMPTY_MAIN = 'module.exports.onStart = async function () {}\nmodule.exports.onUpdate = async function () {}\n'

/** An empty SDK7 scene over the destination's parcels (nothing in it), as Decentraland's own "unpublish" leaves the land. */
export async function emptySceneEntity(dest: Pick<Destination, 'base' | 'parcels'>, timestamp: number) {
  const metadata: SceneMetadata = {
    display: { title: 'Empty parcels' },
    owner: '',
    contact: {},
    main: 'bin/index.js',
    scene: { parcels: dest.parcels, base: dest.base },
    ecs7: true,
    runtimeVersion: '7',
    spawnPoints: [],
  }
  const enc = new TextEncoder()
  const newFiles = new Map<string, Uint8Array>([
    ['bin/index.js', enc.encode(EMPTY_MAIN)],
    ['scene.json', enc.encode(JSON.stringify(metadata, null, 2))],
  ])
  return buildEntity({ pointers: dest.parcels, metadata, existing: [], newFiles, timestamp })
}

/** What the owner's wallet signs for a removal awaiting their signature. */
export type SignRequest =
  | { kind: 'request'; signer: string; request: SignedRequest & { payload: string } }
  | { kind: 'entity'; payload: string; expiresAt: string }

async function destinationOf(r: Removal): Promise<Destination> {
  const dest = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, r.targetId) })
  if (!dest) throw new RemovalError(409, 'disconnected', 'This destination was disconnected from the scene, so Virvi can no longer remove the scene there.')
  return dest
}

/** A fresh thing to sign for a removal awaiting the owner's signature (a World's undeploy, or the parcels' empty scene). */
export async function signRequestFor(r: Removal): Promise<SignRequest> {
  if (r.status !== 'awaiting_signature') throw new RemovalError(409, 'not_awaiting_signature', 'This removal is not waiting for a signature.')
  const dest = await destinationOf(r)
  const now = Date.now()
  if (dest.kind === 'parcels') {
    const { entityId } = await emptySceneEntity(dest, now)
    await db.update(sceneRemovals).set({ pending: { entityId, timestamp: now }, updatedAt: new Date() }).where(eq(sceneRemovals.id, r.id))
    return { kind: 'entity', payload: entityId, expiresAt: new Date(now + EMPTY_SCENE_WINDOW_MS).toISOString() }
  }
  const req = undeployRequest(dest, now)
  return { kind: 'request', signer: dest.ownerWallet, request: { ...req, payload: signedFetchPayload(req.method, req.path, req.timestamp, req.metadata) } }
}

/**
 * The owner's signature for a removal: for a World, over the undeploy with `timestamp` (from signRequestFor), by the
 * World's owner, who must be a verified wallet of `userId` (checked against Decentraland now); for parcels, over the
 * prepared empty scene, by a verified wallet of `userId` that may deploy to every parcel. Sends it and finishes.
 */
export async function submitRemovalSignature(r: Removal, userId: string, body: { chain?: unknown; timestamp?: unknown }): Promise<Removal> {
  if (r.status !== 'awaiting_signature') throw new RemovalError(409, 'not_awaiting_signature', 'This removal is not waiting for a signature.')
  const chain = body.chain
  if (!Array.isArray(chain)) throw new RemovalError(400, 'invalid_chain', 'A signature is required.')
  const dest = await destinationOf(r)
  const wallets = await verifiedWalletsOf(userId)
  try {
    if (dest.kind === 'parcels') {
      const pending = r.pending
      if (!pending || Date.now() - pending.timestamp > EMPTY_SCENE_WINDOW_MS) throw new RemovalError(409, 'expired', 'The signature took too long. Try again and sign straight away.')
      const { entityId, files } = await emptySceneEntity(dest, pending.timestamp)
      const signer = chainSigner(chain as AuthChain)
      if (entityId !== pending.entityId || !signer || !wallets.includes(signer) || !(await verifyChain(chain as AuthChain, entityId, signer))) {
        throw new RemovalError(403, 'not_parcel_controller', "That signature isn't from a wallet that can deploy to every one of these parcels.")
      }
      let control
      try {
        control = await parcelControl([signer], dest.parcels)
      } catch (err) {
        if (err instanceof DirectoryUnavailableError) throw new RemovalError(503, 'catalyst_unreachable', "Decentraland didn't answer just now. Try again in a minute.")
        throw err
      }
      if (control.wallet !== signer) throw new RemovalError(403, 'not_parcel_controller', "That signature isn't from a wallet that can deploy to every one of these parcels.")
      await contentServerFor(dest).deploy({ entityId, authChain: chain as AuthChain, files })
      await finishDcl(r, dest, 'emptied')
    } else {
      const ts = body.timestamp
      if (!Number.isInteger(ts) || (ts as number) > Date.now() + 60_000) throw new RemovalError(400, 'invalid_timestamp', 'The signature is missing its time.')
      if (Date.now() - (ts as number) > SIGNED_REQUEST_MAX_AGE_MS) throw new RemovalError(400, 'expired', 'The signature took too long to reach Decentraland. Try again and sign straight away.')
      const { owner } = await getWorldsClient().getDeployers(worldOf(dest))
      if (!owner || !wallets.includes(owner)) throw new RemovalError(403, 'not_world_owner', 'None of your verified wallets owns this World.')
      const req = undeployRequest(dest, ts as number)
      if (chainSigner(chain as AuthChain) !== owner || !(await verifyChain(chain as AuthChain, signedFetchPayload(req.method, req.path, req.timestamp, req.metadata), owner))) {
        throw new RemovalError(403, 'not_world_owner', "That signature isn't from the wallet that owns this World.")
      }
      await getWorldsClient().sendSigned(req, chain as AuthChain)
      await finishDcl(r, dest, 'undeployed')
    }
  } catch (err) {
    if (err instanceof RemovalError) throw err
    console.error('[scene-removals] signed removal failed:', r.id, err instanceof Error ? err.message : err)
    await failed(r.id, plain(err))
  }
  return reload(r.id)
}

/** The scene's removals, oldest first. */
export async function removalsOf(sceneIds: string[]): Promise<Removal[]> {
  if (!sceneIds.length) return []
  return db.select().from(sceneRemovals).where(inArray(sceneRemovals.sceneId, sceneIds)).orderBy(sceneRemovals.createdAt)
}
