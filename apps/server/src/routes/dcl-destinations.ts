/**
 * Decentraland World destination routes: the wizard, the deploy page and the in-world HUD.
 *
 * GET    /api/dcl/names                          — each verified wallet's DCL names and their Worlds
 * GET    /api/dcl/worlds/:world                  — one typed name (ENS or DCL), plus whether the caller owns it
 * POST   /api/dcl/destinations                   — connect a World to a scene (wizard plot, or adopt the live scene)
 * GET    /api/dcl/destinations/:id               — the destination, models waiting to publish, the last deployment
 * PATCH  /api/dcl/destinations/:id               — switch deploy mode
 * GET    /api/dcl/destinations/:id/grant         — the owner's signed requests that let Virvi deploy
 * POST   /api/dcl/destinations/:id/grant         — forward those signatures, confirm, record the grant
 * DELETE /api/dcl/destinations/:id/grant         — the owner's signed request that removes Virvi
 * POST   /api/dcl/destinations/:id/revoke        — forward that signature, clear the grant
 * POST   /api/dcl/destinations/:id/deploy        — deploy now (mode A: Virvi signs; mode B: returns what to sign)
 * POST   /api/deploy/:id/signature               — mode B: the owner's signature for a prepared deploy
 * POST   /api/dcl/destinations/:id/rebase        — "Use the live version": accept the World's current scene
 * GET    /api/scenes/:sceneId/dcl/destinations — the deploy page: the scene's destinations, and set-up Worlds it can adopt
 * GET    /api/scenes/:sceneId/dcl/publish-status — for the in-world HUD (scene pass)
 *
 * Open to every plan (no feature gate). "Owner" is the World's owner as the Worlds server reports it right
 * now, and it must be one of the caller's verified wallets.
 *
 * Deploy permission, confirmed in worlds-content-server (docs/openapi.yaml and src/controllers/routes.ts,
 * src/logic/permissions, src/adapters/permissions-manager.ts):
 * - `PUT /world/{name}/permissions/deployment/{address}` grants a WORLD-WIDE permission (a permission row
 *   with no parcels is world-wide) and creates the World's record if it has none.
 * - `POST /world/{name}/permissions/deployment/address/{address}/parcels` `{ parcels }` adds parcels to the
 *   address's permission, creating the row if missing; once a row has parcels it covers only those parcels.
 *   It does not create the World's record, and `world_permissions` has a foreign key to it, so on a World
 *   that has never had a scene or permission it fails without the PUT first.
 * - A second PUT does NOT reset an existing row: it is `INSERT … ON CONFLICT DO NOTHING`, so a parcel-scoped
 *   row keeps its parcels (the PUT neither widens it nor clears it), and the POST adds to them: parcels
 *   accumulate across grants.
 * - `DELETE /world/{name}/permissions/deployment/{address}` removes the address's permission, parcels included
 *   (cascade). Deleting an address that has none is not an error, but the handler 404s when the World has no
 *   record, which only exists once something (a deploy or a PUT) created it.
 * So the grant is, in order: a reset DELETE (only when Virvi is already listed, so the World's record exists
 * and old parcels are cleared), the PUT (world-wide, creates the record), the parcels POST (narrows it to the
 * destination's parcels). The owner also signs a rollback DELETE up front: if the PUT or the POST fails, Virvi may
 * be left world-wide, so the rollback is sent at once; if that fails too the owner is told plainly (grant_partial).
 * - `GET /world/{name}/permissions` lists parcel-scoped deployers in `deployment.wallets` too.
 * All three writes are strict signed fetch (current 6.x payload), checked against the World owner.
 * `x-identity-metadata` is not read by these handlers; the only check on it is that `signer` isn't
 * `decentraland-kernel-scene`, and a missing header parses as `{}`. Virvi sends `'{}'` (the Creator Hub
 * sends no metadata on these calls). The parcels POST's JSON body is not covered by the signature.
 * The Worlds server accepts a signed fetch only within 60 s of its timestamp (crypto-middleware's default), so
 * Virvi refuses anything older than 50 s rather than forwarding what Decentraland will reject.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { plotParcels, validPlot, type Plot } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { analyticsScenes, dclWorldDestinations, locationSetups, sceneDeployments } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess } from '../auth/permissions.js'
import { fromParam, isUuid } from '../auth/scene-from.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { DirectoryUnavailableError, getDclDirectory } from '../analytics/dcl-directory.js'
import { getActiveSetup } from '../setup/setups.js'
import { config } from '../config.js'
import { pendingModels } from '../services/dcl/assemble.js'
import { chainSigner, signedFetchPayload, verifyChain, virviSigner, type AuthChain } from '../services/dcl/entity.js'
import { getWorldsClient, WorldsError, type LiveEntity, type SignedRequest } from '../services/dcl/worlds-client.js'
import {
  DeployerError, prepareSignedDeploy, startVirviDeploy, submitSignedDeploy, type Destination,
} from '../services/dcl/world-deployer.js'
import { deploymentForCaller, publicDeployment } from './deploy.js'

/** Signed-fetch metadata Virvi sends on permission calls (see the header comment). */
const PERMISSION_METADATA = '{}'
/** A grant or revoke POST must come within this long of the timestamp chosen at GET: under Decentraland's 60 s. */
const SIGNED_REQUEST_MAX_AGE_MS = 50_000
/** How long Decentraland accepts a signed request after its timestamp. */
const SIGNED_REQUEST_TTL_MS = 60_000
/** Time left before a signed request with this timestamp expires (at least 1 s, so it is still tried). */
const timeLeft = (timestamp: number) => Math.max(1_000, timestamp + SIGNED_REQUEST_TTL_MS - Date.now())
/** Clock skew tolerated for a timestamp in the future. */
const FUTURE_SKEW_MS = 60_000
/** DCL names and ENS names, ASCII only. */
const WORLD_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.eth$/
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

class RouteError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) {
    super(code)
  }
}

/** Runs a route body, mapping known errors to `{ error: code }`. */
async function handle(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RouteError) return reply.status(err.status).send({ error: err.code, ...err.extra })
    if (err instanceof DeployerError) return reply.status(err.status).send({ error: err.code, message: err.message })
    if (err instanceof WorldsError) return reply.status(502).send({ error: 'world_unreachable' })
    if (err instanceof DirectoryUnavailableError) return reply.status(502).send({ error: 'directory_unavailable' })
    throw err
  }
}

/** A read from the Worlds server; any failure (a listed-but-unresolvable entity too) is "unreachable", never "none". */
async function read<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof WorldsError) throw new RouteError(502, 'world_unreachable')
    throw err
  }
}

const unique = (xs: string[]) => [...new Set(xs)]

/** Parcel union of the World's live scenes, based at the first one; null when it has none. */
function footprint(entities: LiveEntity[]): { base: string; parcels: string[] } | null {
  if (!entities.length) return null
  const first = entities[0]
  return { base: first.metadata?.scene?.base ?? first.pointers[0], parcels: unique(entities.flatMap((e) => e.pointers)) }
}

/** Parcels of the live scenes that share any parcel with `parcels` (deploying there replaces them). */
function overlapping(entities: LiveEntity[], parcels: string[]): string[] {
  const mine = new Set(parcels)
  return unique(entities.filter((e) => e.pointers.some((p) => mine.has(p))).flatMap((e) => e.pointers))
}

function worldParam(raw: unknown): string {
  const world = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (world.length > 255 || !WORLD_NAME.test(world)) throw new RouteError(400, 'invalid_world')
  return world
}

async function describeWorld(world: string, storage: { maxAllowedBytes: number; usedBytes: number } | null) {
  const entities = await read(() => getWorldsClient().getWorldEntities(world))
  return { world, hasScene: entities.length > 0, footprint: footprint(entities), storage }
}

/** The World's owner when it is one of the caller's verified wallets; 403 not_world_owner otherwise. */
async function ownerFor(userId: string, world: string): Promise<string> {
  const [{ owner }, wallets] = await Promise.all([read(() => getWorldsClient().getDeployers(world)), verifiedWalletsOf(userId)])
  if (!owner || !wallets.includes(owner)) throw new RouteError(403, 'not_world_owner')
  return owner
}

/** As ownerFor, and keeps the destination's owner up to date (the NAME may have moved between their wallets). */
async function requireOwner(userId: string, dest: Destination): Promise<string> {
  const owner = await ownerFor(userId, dest.worldName)
  if (owner !== dest.ownerWallet || userId !== dest.ownerUserId) {
    await db.update(dclWorldDestinations).set({ ownerWallet: owner, ownerUserId: userId, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, dest.id))
  }
  return owner
}

/** The destination when the caller has `need` on its scene; 404 otherwise (never says whether it exists). */
async function destinationFor(request: FastifyRequest, id: string, need: 'edit' | 'full'): Promise<Destination> {
  if (!isUuid(id)) throw new RouteError(404, 'not_found')
  const dest = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, id) })
  if (!dest) throw new RouteError(404, 'not_found')
  const access = await getSceneAccess(actorFromClaims(request.user), dest.sceneId)
  if (!(need === 'full' ? isFullAccess(access) : hasScope(access, 'scene.edit'))) throw new RouteError(404, 'not_found')
  return dest
}

const reload = async (id: string) => (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, id) }))!

function virviAddress(): string {
  const signer = virviSigner()
  if (!signer) throw new RouteError(503, 'virvi_deploys_unavailable')
  return signer.address
}

type Signable = SignedRequest & { payload: string }
const signable = (r: SignedRequest): Signable => ({ ...r, payload: signedFetchPayload(r.method, r.path, r.timestamp, r.metadata) })

type GrantStep = SignedRequest & { purpose: 'reset' | 'grant' | 'scope' | 'rollback' }

/**
 * The grant (see the header): [reset DELETE when Virvi is already listed], world-wide PUT, the parcels POST
 * narrowing it to the destination's parcels plus any live scene it replaces (R3), and the rollback DELETE.
 */
async function grantRequests(dest: Destination, virvi: string, timestamp: number): Promise<GrantStep[]> {
  const [entities, { deployers }] = await Promise.all([
    read(() => getWorldsClient().getWorldEntities(dest.worldName)),
    read(() => getWorldsClient().getDeployers(dest.worldName)),
  ])
  const parcels = unique([...dest.parcels, ...overlapping(entities, dest.parcels)])
  const w = encodeURIComponent(dest.worldName)
  const remove = { method: 'DELETE', path: `/world/${w}/permissions/deployment/${virvi}`, metadata: PERMISSION_METADATA, timestamp } as const
  return [
    ...(deployers.includes(virvi) ? [{ ...remove, purpose: 'reset' } as const] : []),
    { method: 'PUT', path: `/world/${w}/permissions/deployment/${virvi}`, metadata: PERMISSION_METADATA, timestamp, purpose: 'grant' },
    { method: 'POST', path: `/world/${w}/permissions/deployment/address/${virvi}/parcels`, metadata: PERMISSION_METADATA, timestamp, body: { parcels }, purpose: 'scope' },
    { ...remove, purpose: 'rollback' },
  ]
}

function revokeRequests(dest: Destination, virvi: string, timestamp: number): SignedRequest[] {
  return [{ method: 'DELETE', path: `/world/${encodeURIComponent(dest.worldName)}/permissions/deployment/${virvi}`, metadata: PERMISSION_METADATA, timestamp }]
}

function signedTimestamp(raw: unknown): number {
  if (!Number.isInteger(raw)) throw new RouteError(400, 'invalid_timestamp')
  const ts = raw as number
  const now = Date.now()
  if (ts > now + FUTURE_SKEW_MS) throw new RouteError(400, 'invalid_timestamp')
  if (now - ts > SIGNED_REQUEST_MAX_AGE_MS) {
    throw new RouteError(400, 'expired', { message: 'The signatures took too long to reach Decentraland. Please try again and sign straight away.' })
  }
  return ts
}

/** Checks each chain against the payload the server derives for its request, with the owner as signer. */
async function verifyChains(requests: SignedRequest[], chains: unknown, owner: string): Promise<AuthChain[]> {
  if (!Array.isArray(chains) || chains.length !== requests.length || !chains.every(Array.isArray)) {
    throw new RouteError(400, 'invalid_chains')
  }
  const signed = chains as AuthChain[]
  for (const [i, req] of requests.entries()) {
    if (chainSigner(signed[i]) !== owner) throw new RouteError(403, 'not_world_owner')
    if (!(await verifyChain(signed[i], signable(req).payload, owner))) throw new RouteError(400, 'invalid_signature')
  }
  return signed
}

const refusal = (err: WorldsError) =>
  err.status === 0 ? "Decentraland didn't answer in time" : `Decentraland refused it: ${err.body.slice(0, 300) || `HTTP ${err.status}`}`

/** Verifies every chain, then forwards the requests in order. Nothing is sent unless every chain verifies. */
async function forwardSigned(requests: SignedRequest[], chains: unknown, owner: string, failCode: string) {
  const signed = await verifyChains(requests, chains, owner)
  for (const [i, req] of requests.entries()) {
    try {
      await getWorldsClient().sendSigned(req, signed[i], timeLeft(req.timestamp))
    } catch (err) {
      if (err instanceof WorldsError) throw new RouteError(502, failCode, { message: refusal(err) })
      throw err
    }
  }
}

const PARTIAL_GRANT =
  "Virvi can currently deploy anywhere in your World, not just this scene's parcels, and removing that failed. " +
  "Remove Virvi's permission from this page, or in the Creator Hub under your World's permissions."

/**
 * Sends a verified grant. If the PUT or the parcels POST fails, Virvi may hold a world-wide permission (a PUT that
 * timed out or got a 5xx may have landed), so the pre-signed rollback goes out at once; a 404 from it means there was
 * nothing to remove. If the rollback fails too, 502 grant_partial, unless the failure was the PUT with a plain 4xx
 * (nothing was granted). Each step but the rollback gets half the time the signatures have left, so a slow step
 * can't use up the rollback's. grantedAt is cleared whenever Virvi's permission was touched.
 */
async function sendGrant(dest: Destination, steps: GrantStep[], chains: AuthChain[]) {
  const send = (i: number, timeoutMs: number) => getWorldsClient().sendSigned(steps[i], chains[i], timeoutMs)
  const rollback = steps.findIndex((s) => s.purpose === 'rollback')
  let touched = false
  let reset = false
  for (const [i, step] of steps.entries()) {
    if (step.purpose === 'rollback') continue
    try {
      await send(i, Math.max(1_000, Math.floor(timeLeft(step.timestamp) / 2)))
    } catch (err) {
      if (!(err instanceof WorldsError)) throw err
      if (touched || step.purpose === 'grant') {
        await db.update(dclWorldDestinations).set({ grantedAt: null, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, dest.id))
      }
      const earlier = reset ? " Virvi's earlier permission on this World was removed, so it can't deploy there until you grant it again." : ''
      if (step.purpose === 'grant' || step.purpose === 'scope') {
        // A PUT refused with a plain 4xx granted nothing; anything else may have.
        const mayHold = step.purpose === 'scope' || err.status === 0 || err.status >= 500
        try {
          await send(rollback, timeLeft(steps[rollback].timestamp))
        } catch (again) {
          if (!(again instanceof WorldsError)) throw again
          if (again.status !== 404 && mayHold) throw new RouteError(502, 'grant_partial', { message: PARTIAL_GRANT })
        }
        const undone = step.purpose === 'scope' ? " Virvi's permission was removed again, so nothing changed." : ''
        throw new RouteError(502, 'grant_rejected', { message: `${refusal(err)}.${undone}${earlier}` })
      }
      throw new RouteError(502, 'grant_rejected', { message: refusal(err) })
    }
    touched = true
    if (step.purpose === 'reset') reset = true
  }
}

interface CreateBody {
  sceneId?: unknown
  world?: unknown
  mode?: unknown
  plot?: unknown
  spawn?: unknown
}

export default async function dclDestinationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/dcl/names', async (request, reply) => handle(reply, async () => {
    const wallets = await verifiedWalletsOf(request.user.id)
    const out = await Promise.all(wallets.map(async (address) => {
      const [names, storage] = await Promise.all([
        getDclDirectory().getOwnedNames(address),
        read(() => getWorldsClient().getWalletStats(address)),
      ])
      return { address, names: await Promise.all(unique(names.map((n) => n.toLowerCase())).map((w) => describeWorld(w, storage))) }
    }))
    return reply.send({ wallets: out })
  }))

  app.get<{ Params: { world: string } }>('/api/dcl/worlds/:world', async (request, reply) => handle(reply, async () => {
    const world = worldParam(request.params.world)
    const [{ owner }, wallets] = await Promise.all([read(() => getWorldsClient().getDeployers(world)), verifiedWalletsOf(request.user.id)])
    const storage = owner ? await read(() => getWorldsClient().getWalletStats(owner)) : null
    return reply.send({ ...(await describeWorld(world, storage)), owner: !!owner && wallets.includes(owner) })
  }))

  app.post<{ Body: CreateBody }>('/api/dcl/destinations', async (request, reply) => handle(reply, async () => {
    const { sceneId, mode, plot, spawn } = request.body ?? {}
    if (!isUuid(sceneId)) throw new RouteError(400, 'invalid_scene')
    const world = worldParam(request.body?.world)
    if (mode !== 'virvi' && mode !== 'sign') throw new RouteError(400, 'invalid_mode')
    if (plot !== undefined && !validPlot(plot)) throw new RouteError(400, 'invalid_plot')
    const s = spawn as { x?: unknown; z?: unknown } | undefined
    if (spawn !== undefined && !(s && typeof s === 'object' && isNum(s.x) && isNum(s.z))) throw new RouteError(400, 'invalid_spawn')

    if (!isFullAccess(await getSceneAccess(actorFromClaims(request.user), sceneId))) throw new RouteError(403, 'forbidden')
    const owner = await ownerFor(request.user.id, world)
    const inUse = async () => {
      const other = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.worldName, world), columns: { sceneId: true } })
      return other ? new RouteError(409, 'world_in_use', { sceneId: other.sceneId }) : null
    }
    const taken = await inUse()
    if (taken) throw taken
    const entities = await read(() => getWorldsClient().getWorldEntities(world))

    let fields: Pick<Destination, 'base' | 'parcels'> & Partial<Pick<Destination, 'lastEntityId' | 'deployedFiles' | 'adopted'>>
    let replaces: { parcels: string[] } | undefined
    if (plot !== undefined) {
      // Deploying over the live scene's base replaces it (the Decentraland rule), so the plot moves there.
      const live = footprint(entities)
      let p = plot as Plot
      if (live) {
        const [x, y] = live.base.split(',').map(Number)
        p = { ...p, base: { x, y } }
      }
      const parcels = plotParcels(p)
      fields = { base: parcels[0], parcels }
      if (live) replaces = { parcels: overlapping(entities, parcels) }
    } else {
      if (!entities.length) throw new RouteError(400, 'no_live_scene')
      const loc = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, `world:${world}`) })
      const setup = loc ? await getActiveSetup(loc.id) : null
      if (!loc || setup?.virviSceneId !== sceneId) throw new RouteError(400, 'not_connected')
      const live =
        entities.find((e) => e.id === setup.deploymentEntityId) ??
        entities.find((e) => !!loc.baseParcel && e.pointers.includes(loc.baseParcel)) ??
        entities[0]
      fields = {
        base: live.metadata?.scene?.base ?? live.pointers[0],
        parcels: live.metadata?.scene?.parcels ?? live.pointers,
        lastEntityId: live.id,
        deployedFiles: live.content.map((c) => c.file.toLowerCase()),
        adopted: true,
      }
    }

    let destination: Destination
    try {
      ;[destination] = await db.insert(dclWorldDestinations).values({
        sceneId, ownerUserId: request.user.id, ownerWallet: owner, worldName: world, mode, ...fields,
        spawn: s ? { x: s.x as number, y: 0, z: s.z as number } : null,
      }).returning()
    } catch (err) {
      // Lost a race with another create for this World (world_name is unique)
      if ((err as { code?: string })?.code === '23505' || (err as { cause?: { code?: string } })?.cause?.code === '23505') throw (await inUse()) ?? err
      throw err
    }
    return reply.status(201).send({ destination, ...(replaces ? { replaces } : {}) })
  }))

  app.get<{ Params: { id: string } }>('/api/dcl/destinations/:id', async (request, reply) => handle(reply, async () => {
    const dest = await destinationFor(request, request.params.id, 'edit')
    const last = await db.query.sceneDeployments.findFirst({
      where: eq(sceneDeployments.destinationId, dest.id),
      orderBy: [desc(sceneDeployments.createdAt)],
    })
    const refused = (last?.assetBundle as { refused?: unknown } | null)?.refused ?? []
    return reply.send({ destination: dest, pending: await pendingModels(dest), refused, lastDeployment: last ? publicDeployment(last) : null })
  }))

  app.patch<{ Params: { id: string }; Body: { mode?: unknown } }>('/api/dcl/destinations/:id', async (request, reply) => handle(reply, async () => {
    const mode = request.body?.mode
    if (mode !== 'virvi' && mode !== 'sign') throw new RouteError(400, 'invalid_mode')
    const dest = await destinationFor(request, request.params.id, 'full')
    await db
      .update(dclWorldDestinations)
      .set({ mode, ...(mode === 'sign' ? { grantedAt: null } : {}), updatedAt: new Date() })
      .where(eq(dclWorldDestinations.id, dest.id))
    const message = mode === 'sign'
      ? "Virvi won't deploy on its own any more. Its permission stays on your World until you remove it in the Creator Hub or here."
      : undefined
    return reply.send({ destination: await reload(dest.id), ...(message ? { message } : {}) })
  }))

  app.get<{ Params: { id: string } }>('/api/dcl/destinations/:id/grant', async (request, reply) => handle(reply, async () => {
    const dest = await destinationFor(request, request.params.id, 'full')
    await requireOwner(request.user.id, dest)
    const virvi = virviAddress()
    const requests = await grantRequests(dest, virvi, Date.now())
    return reply.send({ virviAddress: virvi, requests: requests.map(signable) })
  }))

  app.post<{ Params: { id: string }; Body: { chains?: unknown; timestamp?: unknown } }>('/api/dcl/destinations/:id/grant', async (request, reply) => handle(reply, async () => {
    const dest = await destinationFor(request, request.params.id, 'full')
    const owner = await requireOwner(request.user.id, dest)
    const virvi = virviAddress()
    const timestamp = signedTimestamp(request.body?.timestamp)
    const steps = await grantRequests(dest, virvi, timestamp)
    await sendGrant(dest, steps, await verifyChains(steps, request.body?.chains, owner))
    const { deployers } = await read(() => getWorldsClient().getDeployers(dest.worldName))
    if (!deployers.includes(virvi)) {
      await db.update(dclWorldDestinations).set({ grantedAt: null, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, dest.id))
      throw new RouteError(502, 'grant_not_visible')
    }
    await db.update(dclWorldDestinations).set({ mode: 'virvi', grantedAt: new Date(), updatedAt: new Date() }).where(eq(dclWorldDestinations.id, dest.id))
    return reply.send({ destination: await reload(dest.id) })
  }))

  app.delete<{ Params: { id: string } }>('/api/dcl/destinations/:id/grant', async (request, reply) => handle(reply, async () => {
    const dest = await destinationFor(request, request.params.id, 'full')
    await requireOwner(request.user.id, dest)
    return reply.send({ requests: revokeRequests(dest, virviAddress(), Date.now()).map(signable) })
  }))

  app.post<{ Params: { id: string }; Body: { chains?: unknown; timestamp?: unknown } }>('/api/dcl/destinations/:id/revoke', async (request, reply) => handle(reply, async () => {
    const dest = await destinationFor(request, request.params.id, 'full')
    const owner = await requireOwner(request.user.id, dest)
    const timestamp = signedTimestamp(request.body?.timestamp)
    await forwardSigned(revokeRequests(dest, virviAddress(), timestamp), request.body?.chains, owner, 'revoke_rejected')
    await db.update(dclWorldDestinations).set({ mode: 'sign', grantedAt: null, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, dest.id))
    return reply.send({ destination: await reload(dest.id) })
  }))

  app.post<{ Params: { id: string } }>('/api/dcl/destinations/:id/deploy', async (request, reply) => handle(reply, async () => {
    const dest = await destinationFor(request, request.params.id, 'full')
    await requireOwner(request.user.id, dest)
    if (dest.mode === 'virvi') {
      const deployment = await startVirviDeploy(dest.id, request.user.id)
      return reply.status(202).send({ deployment: publicDeployment(deployment) })
    }
    const { deployment, payload, expiresAt } = await prepareSignedDeploy(dest.id, request.user.id)
    return reply.send({ deployment: publicDeployment(deployment), payload, expiresAt })
  }))

  app.post<{ Params: { id: string }; Body: { chain?: unknown } }>('/api/deploy/:id/signature', async (request, reply) => handle(reply, async () => {
    const chain = request.body?.chain
    if (!Array.isArray(chain)) throw new RouteError(400, 'invalid_chain')
    const dep = await deploymentForCaller(request, request.params.id, 'manage')
    if (!dep) throw new RouteError(404, 'not_found')
    return reply.send({ deployment: publicDeployment(await submitSignedDeploy(dep.id, chain as AuthChain)) })
  }))

  app.post<{ Params: { id: string } }>('/api/dcl/destinations/:id/rebase', async (request, reply) => handle(reply, async () => {
    const dest = await destinationFor(request, request.params.id, 'full')
    const entities = await read(() => getWorldsClient().getWorldEntities(dest.worldName))
    const live = entities.find((e) => e.pointers.includes(dest.base))
    if (!live) throw new RouteError(409, 'no_live_scene')
    await db
      .update(dclWorldDestinations)
      // A scene without Virvi's `virvi` block is the owner's own code (rebuilt in the Creator Hub, say): adopted, never touched
      .set({
        lastEntityId: live.id, deployedFiles: live.content.map((c) => c.file.toLowerCase()), adopted: !live.metadata?.virvi,
        status: 'ok', statusDetail: null, updatedAt: new Date(),
      })
      .where(eq(dclWorldDestinations.id, dest.id))
    return reply.send({ destination: await reload(dest.id) })
  }))

  // `adoptable`: Worlds whose active location setup is this scene (a Creator Hub `@virvixr/dcl` scene) and that no
  // destination uses yet. Adopting one is POST /api/dcl/destinations without a plot.
  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/dcl/destinations', async (request, reply) => handle(reply, async () => {
    const { sceneId } = request.params
    if (!isUuid(sceneId) || !hasScope(await getSceneAccess(actorFromClaims(request.user), sceneId), 'scene.edit')) {
      throw new RouteError(404, 'not_found')
    }
    const destinations = await db.query.dclWorldDestinations.findMany({
      where: eq(dclWorldDestinations.sceneId, sceneId),
      orderBy: [dclWorldDestinations.createdAt],
    })
    const setUp = await db
      .select({ world: analyticsScenes.worldName })
      .from(locationSetups)
      .innerJoin(analyticsScenes, eq(analyticsScenes.id, locationSetups.analyticsSceneId))
      .where(and(eq(locationSetups.virviSceneId, sceneId), isNull(locationSetups.endedAt), eq(analyticsScenes.kind, 'world')))
    const worlds = unique(setUp.map((r) => r.world?.toLowerCase()).filter((w): w is string => !!w))
    const taken = worlds.length
      ? new Set((await db.query.dclWorldDestinations.findMany({ where: inArray(dclWorldDestinations.worldName, worlds), columns: { worldName: true } })).map((d) => d.worldName))
      : new Set<string>()
    return reply.send({ destinations, adoptable: worlds.filter((w) => !taken.has(w)).map((world) => ({ world })) })
  }))

  app.get<{ Params: { sceneId: string } }>(
    '/api/scenes/:sceneId/dcl/publish-status',
    { config: { scenePass: { sceneFrom: fromParam('sceneId'), ar: 'personal' } } },
    async (request, reply) => handle(reply, async () => {
      const { sceneId } = request.params
      if (!isUuid(sceneId) || !hasScope(await getSceneAccess(actorFromClaims(request.user), sceneId), 'scene.edit')) {
        throw new RouteError(404, 'not_found')
      }
      const dest = await db.query.dclWorldDestinations.findFirst({
        where: eq(dclWorldDestinations.sceneId, sceneId),
        orderBy: [dclWorldDestinations.createdAt],
      })
      if (!dest) return reply.send({ destination: null })
      return reply.send({
        destination: {
          id: dest.id, world: dest.worldName, mode: dest.mode, status: dest.status,
          granted: dest.mode === 'virvi' && !!dest.grantedAt,
          pending: (await pendingModels(dest)).length,
          publishUrl: `${config.webAppUrl}/publish/?d=${dest.id}`,
        },
      })
    }),
  )
}
