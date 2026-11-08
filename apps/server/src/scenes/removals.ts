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
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { dclWorldDestinations, hyperfyWorlds, sceneDeployments, sceneImports, sceneRemovals, scenes } from '../db/schema.js'
import { destroyHostedWorld, HostingError, type HostingDeps } from '../hyperfy/hosting.js'
import { buildEntity, chainSigner, signedFetchPayload, verifyChain, virviSignerFor, type AuthChain, type SceneMetadata } from '../services/dcl/entity.js'
import { getWorldsClient, WorldsError, type LiveEntity, type SignedRequest } from '../services/dcl/worlds-client.js'
import { CatalystError, contentServerFor } from '../services/dcl/catalyst-client.js'
import { worldOf } from '../services/dcl/world-of.js'
import { DisconnectBusyError, underDestinationLocks } from '../services/dcl/disconnect.js'
import { builtByVirvi } from '../services/dcl/assemble.js'
import type { Destination } from '../services/dcl/world-deployer.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { parcelControl } from '../services/dcl/parcel-control.js'
import { isAccessRefusal } from '../services/dcl/parcel-grant.js'
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
  /** Decentraland: the live content there isn't Virvi's to remove unasked; `reason` says why. */
  ownContent?: boolean
  reason?: string
  /** Decentraland: the live entity the dialog showed (null: nothing live, or unreadable). */
  liveEntityId?: string | null
}

/** Signed-fetch metadata on the undeploy, as on Virvi's permission calls (dcl-destinations.ts header). */
const UNDEPLOY_METADATA = '{}'
/** A browser-signed undeploy must reach Decentraland within its 60 s; Virvi refuses older ones (as the grant routes). */
const SIGNED_REQUEST_MAX_AGE_MS = 50_000
/** How long the owner has to sign an empty-scene deploy over their parcels (as a mode B deploy). */
export const EMPTY_SCENE_WINDOW_MS = 240_000

const isVirviSigned = (dest: Destination) => dest.mode === 'virvi' && !!dest.grantedAt && !!virviSignerFor(dest.kind)

/** The live scene on the destination's base parcel; null when there's none. Throws WorldsError/CatalystError when unreadable. */
async function liveAtBase(dest: Destination): Promise<LiveEntity | null> {
  return (await contentServerFor(dest).liveEntities(dest)).find((e) => e.pointers.includes(dest.base)) ?? null
}

/**
 * Whether Virvi may take `live` off the destination without the owner having seen it: it's the scene Virvi built and
 * last deployed there (not changed outside Virvi), and for Genesis City it covers only the destination's parcels.
 * Null when it may; otherwise the reason, as the dialog says it.
 */
export function notVirvisReason(dest: Pick<Destination, 'kind' | 'parcels' | 'lastEntityId'>, live: LiveEntity): string | null {
  const place = dest.kind === 'parcels' ? 'These parcels now show' : 'Your World now shows'
  if (!builtByVirvi(live.metadata)) return `${place} a scene Virvi didn't build.`
  if (live.id !== dest.lastEntityId) return dest.kind === 'parcels' ? 'These parcels changed outside Virvi since Virvi last deployed there.' : 'Your World changed outside Virvi since Virvi last deployed there.'
  if (dest.kind === 'parcels' && live.pointers.some((p) => !dest.parcels.includes(p))) {
    return 'The scene there also covers parcels outside this scene, so an empty scene would clear those too.'
  }
  return null
}

/** The live content is the owner's own work uploaded through Virvi (an import): Virvi never treats it as its own. */
async function importedLive(dest: Destination): Promise<boolean> {
  const imported = await db.query.sceneImports.findFirst({
    where: and(eq(sceneImports.destinationId, dest.id), eq(sceneImports.status, 'deployed')),
    columns: { id: true },
  })
  return !!imported
}

const dclLabel = (dest: Destination) =>
  dest.kind === 'parcels' ? `Remove the scene from Genesis City parcels ${dest.base}` : `Remove the scene from ${worldOf(dest)}`

/**
 * What's running for the scene that the delete dialog offers to shut down or remove. A Decentraland line is ticked only
 * when what's live is the scene Virvi built and last deployed (read from Decentraland now); otherwise it's unticked
 * and says why. `liveEntityId` is what the dialog showed: DELETE sends it back (`seen`), so a removal never takes
 * down something the owner didn't see.
 */
export async function removalOptions(sceneId: string, opts: { readLive?: boolean } = {}): Promise<RemovalOption[]> {
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
    const base = { id: d.id, kind: (d.kind === 'parcels' ? 'dcl_parcels' : 'dcl_world') as RemovalKind, label: dclLabel(d), needsSignature: !isVirviSigned(d) }
    if (opts.readLive === false) {
      out.push({ ...base, defaultChecked: false, ownContent: true })
      continue
    }
    let live: LiveEntity | null
    try {
      live = await liveAtBase(d)
    } catch {
      out.push({ ...base, defaultChecked: false, ownContent: true, liveEntityId: null, reason: "Couldn't check what's live there right now, so it's left unticked." })
      continue
    }
    if (!live) {
      out.push({ ...base, defaultChecked: true, ownContent: false, liveEntityId: null })
      continue
    }
    const reason = (await importedLive(d)) && live.id === d.lastEntityId ? "What's live there is a scene you uploaded." : notVirvisReason(d, live)
    out.push({ ...base, defaultChecked: !reason, ownContent: !!reason, liveEntityId: live.id, ...(reason ? { reason } : {}) })
  }
  return out
}

/** A removal as the dashboard sees it. */
export function publicRemoval(r: Removal, now = Date.now()) {
  // A removal left pending (a restart or a timeout mid-way) shows as failed, so it gets Retry
  if (r.status === 'pending' && now - r.updatedAt.getTime() > STALE_PENDING_MS) {
    return { id: r.id, kind: r.kind, label: r.label, status: 'failed' as const, errorMessage: 'This was interrupted. Try again.', finishedAt: null }
  }
  return { id: r.id, kind: r.kind, label: r.label, status: r.status, errorMessage: r.errorMessage, finishedAt: r.finishedAt }
}

/** A pending removal older than this was interrupted. */
export const STALE_PENDING_MS = 5 * 60_000

const failed = (id: string, message: string) =>
  db.update(sceneRemovals).set({ status: 'failed', errorMessage: message, pending: null, updatedAt: new Date() }).where(eq(sceneRemovals.id, id))
const done = (id: string) =>
  db.update(sceneRemovals).set({ status: 'done', errorMessage: null, pending: null, finishedAt: new Date(), updatedAt: new Date() }).where(eq(sceneRemovals.id, id))
const awaiting = (id: string, message: string | null = null) =>
  db.update(sceneRemovals).set({ status: 'awaiting_signature', errorMessage: message, updatedAt: new Date() }).where(eq(sceneRemovals.id, id))
const needsReview = (id: string, reason: string) =>
  db.update(sceneRemovals).set({ status: 'needs_review', errorMessage: `${reason} Virvi left it as it is. Check it, then choose Remove anyway if you still want it gone.`, pending: null, updatedAt: new Date() }).where(eq(sceneRemovals.id, id))
/** The removal as it is now; gone (a restore cleared it) reads as stopped. */
const reload = async (r: Removal): Promise<Removal> =>
  (await db.query.sceneRemovals.findFirst({ where: eq(sceneRemovals.id, r.id) }))
  ?? { ...r, status: 'failed', errorMessage: RESTORED_MEANWHILE, pending: null }
const RESTORED_MEANWHILE = 'The scene was restored, so this was stopped.'

/** The scene is still deleted (read under `q`'s lock when given: a restore waits for the removal, or it stops). */
async function stillDeleted(sceneId: string, q: Pick<typeof db, 'select'> = db): Promise<boolean> {
  const [row] = await q.select({ deletedAt: scenes.deletedAt }).from(scenes).where(eq(scenes.id, sceneId)).for('share')
  return !!row?.deletedAt
}

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
 * `seen` is the live entity the dialog showed for each Decentraland line. Ones that need the owner's signature are left
 * awaiting_signature.
 */
export async function startRemovals(
  sceneId: string, ids: string[], by: string | null, opts: { seen?: Record<string, string | null>; deps?: Partial<HostingDeps> } = {},
): Promise<Removal[]> {
  const options = await removalOptions(sceneId, { readLive: false })
  const chosen = options.filter((o) => ids.includes(o.id))
  const out: Removal[] = []
  for (const o of chosen) {
    const dest = o.kind === 'dcl_world' || o.kind === 'dcl_parcels'
      ? await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, o.id) })
      : null
    const seen = opts.seen && o.id in opts.seen ? { seenEntityId: opts.seen[o.id] } : {}
    const target = dest
      ? { world: dest.worldName, base: dest.base, parcels: dest.parcels, ownerWallet: dest.ownerWallet, mode: dest.mode, ...seen }
      : {}
    const [row] = await db.insert(sceneRemovals)
      .values({ sceneId, kind: o.kind, targetId: o.id, label: o.label, target, requestedBy: by })
      .onConflictDoUpdate({
        target: [sceneRemovals.sceneId, sceneRemovals.targetId],
        set: { status: 'pending', errorMessage: null, requestedBy: by, target, updatedAt: new Date() },
        // Never run again once done
        setWhere: sql`${sceneRemovals.status} <> 'done'`,
      })
      .returning()
    const current = row ?? (await db.query.sceneRemovals.findFirst({ where: and(eq(sceneRemovals.sceneId, sceneId), eq(sceneRemovals.targetId, o.id)) }))!
    out.push(current.status === 'done' ? current : await runRemoval(current, { deps: opts.deps }))
  }
  return out
}

/** Decentraland refused Virvi's own signature (its permission is gone or doesn't cover the scene): the owner signs. */
const isRefusal = (err: unknown) =>
  ((err instanceof WorldsError || err instanceof CatalystError) && (err.status === 401 || err.status === 403))
  // The catalyst's access check answers 400 naming the problem: the same test a mode A parcels deploy uses
  || isAccessRefusal(err)
const VIRVI_REFUSED = "Decentraland didn't accept Virvi's permission there any more. Sign with your wallet to remove it."

const SIGNATURE_REFUSED = "Decentraland didn't accept that signature. Sign again with the wallet that owns it."

type DclOutcome = 'done' | 'needs_review' | 'refused' | 'restored'

/**
 * Takes the scene off a Decentraland destination, under the destination's locks (underDestinationLocks): nothing is
 * deploying there meanwhile and nothing can start, a deploy waiting for a signature is cancelled, and the destination
 * is disconnected in the same transaction once the platform call worked. Reads what's live first: when it isn't what
 * the owner saw in the dialog (`seen`) or what Virvi itself deployed, nothing is sent and the removal needs a look.
 */
async function removeFromDcl(r: Removal, dest: Destination, send: () => Promise<void>, seen: string | null | undefined): Promise<DclOutcome> {
  let outcome: DclOutcome = 'done'
  await underDestinationLocks(dest, async (tx) => {
    // A restore that got in first keeps its deployment: nothing is sent or disconnected
    if (!(await stillDeleted(r.sceneId, tx))) {
      outcome = 'restored'
      return false
    }
    const live = await liveAtBase(dest)
    if (live) {
      const reason = seen !== undefined && live.id === seen ? null : notVirvisReason(dest, live)
      if (reason) {
        outcome = 'needs_review'
        await needsReview(r.id, reason)
        return false
      }
      try {
        await send()
      } catch (err) {
        if (!isRefusal(err)) throw err
        outcome = 'refused'
        return false
      }
    }
    const now = new Date()
    const what = dest.kind === 'parcels' ? 'emptied' : 'undeployed'
    await tx.update(sceneDeployments)
      .set({ removedAt: now, removalOutcome: what })
      .where(and(eq(sceneDeployments.destinationId, dest.id), eq(sceneDeployments.status, 'deployed'), isNull(sceneDeployments.removedAt), lte(sceneDeployments.createdAt, now)))
    await tx.update(sceneRemovals)
      .set({ status: 'done', errorMessage: null, pending: null, finishedAt: now, updatedAt: now, target: { ...r.target, removedAt: now.toISOString(), outcome: live ? what : 'nothing_live' } })
      .where(eq(sceneRemovals.id, r.id))
    return true
  })
  return outcome
}

/** Runs one removal (a retry too). `confirm`: the owner chose "Remove anyway" for what's live now. Never throws for a platform failure. */
export async function runRemoval(r: Removal, opts: { deps?: Partial<HostingDeps>; confirm?: boolean } = {}): Promise<Removal> {
  if (r.status === 'done') return r
  await db.update(sceneRemovals).set({ status: 'pending', updatedAt: new Date() }).where(eq(sceneRemovals.id, r.id))
  try {
    switch (r.kind as RemovalKind) {
      case 'hosted_world':
        if (!(await stillDeleted(r.sceneId))) { await failed(r.id, RESTORED_MEANWHILE); break }
        try {
          await destroyHostedWorld(r.targetId, opts.deps)
        } catch (err) {
          if (!(err instanceof HostingError && err.code === 'world_not_found')) throw err // gone already: done
        }
        await done(r.id)
        break
      case 'hyperfy_world':
        if (!(await stillDeleted(r.sceneId))) { await failed(r.id, RESTORED_MEANWHILE); break }
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
        const seen = await seenFor(r, dest, opts.confirm)
        if (!isVirviSigned(dest)) {
          if (opts.confirm) await recordSeen(r, seen)
          await awaiting(r.id)
          break
        }
        // Recorded first, so a refusal that hands it to the owner's wallet carries "Remove anyway" along
        if (opts.confirm) await recordSeen(r, seen)
        const signer = virviSignerFor(dest.kind)!
        const send = dest.kind === 'parcels'
          ? async () => {
            const { entityId, files } = await emptySceneEntity(dest, Date.now())
            await contentServerFor(dest).deploy({ entityId, authChain: await signer.signChain(entityId), files })
          }
          : async () => {
            const req = undeployRequest(dest, Date.now())
            await getWorldsClient().sendSigned(req, await signer.signChain(signedFetchPayload(req.method, req.path, req.timestamp, req.metadata)))
          }
        const outcome = await removeFromDcl(r, dest, send, seen)
        if (outcome === 'refused') await awaiting(r.id, VIRVI_REFUSED)
        if (outcome === 'restored') await failed(r.id, RESTORED_MEANWHILE)
        break
      }
    }
  } catch (err) {
    console.error('[scene-removals] removal failed:', r.id, r.kind, err instanceof Error ? err.message : err)
    await failed(r.id, r.kind === 'hosted_world' ? "This world couldn't be shut down just now. Try again." : plain(err))
  }
  return reload(r)
}

/** What the owner saw (or, with `confirm`, what's live now: they chose "Remove anyway"). Undefined: nothing seen. */
async function seenFor(r: Removal, dest: Destination, confirm?: boolean): Promise<string | null | undefined> {
  if (confirm) return (await liveAtBase(dest))?.id ?? null
  const t = r.target as { seenEntityId?: string | null }
  return 'seenEntityId' in t ? t.seenEntityId : undefined
}

async function recordSeen(r: Removal, seen: string | null | undefined) {
  if (seen === undefined) return
  r.target = { ...r.target, seenEntityId: seen }
  await db.update(sceneRemovals).set({ target: r.target, updatedAt: new Date() }).where(eq(sceneRemovals.id, r.id))
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
      const outcome = await removeFromDcl(r, dest, () => contentServerFor(dest).deploy({ entityId, authChain: chain as AuthChain, files }), await seenFor(r, dest))
      if (outcome === 'refused') await awaiting(r.id, SIGNATURE_REFUSED)
      if (outcome === 'restored') await failed(r.id, RESTORED_MEANWHILE)
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
      const outcome = await removeFromDcl(r, dest, () => getWorldsClient().sendSigned(req, chain as AuthChain), await seenFor(r, dest))
      if (outcome === 'refused') await awaiting(r.id, SIGNATURE_REFUSED)
      if (outcome === 'restored') await failed(r.id, RESTORED_MEANWHILE)
    }
  } catch (err) {
    if (err instanceof RemovalError) throw err
    console.error('[scene-removals] signed removal failed:', r.id, err instanceof Error ? err.message : err)
    await failed(r.id, plain(err))
  }
  return reload(r)
}

/** The scene's removals, oldest first. */
export async function removalsOf(sceneIds: string[]): Promise<Removal[]> {
  if (!sceneIds.length) return []
  return db.select().from(sceneRemovals).where(inArray(sceneRemovals.sceneId, sceneIds)).orderBy(sceneRemovals.createdAt)
}
