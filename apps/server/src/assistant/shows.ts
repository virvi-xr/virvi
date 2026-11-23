// Shows (phase 2b): one user's saved checklist for an event. Every item's state is computed here, on each read, from
// the rows its ref points at, read through the same access rules as the routes that own them, so a show never holds a
// state of its own and can be picked up from any conversation.
import type { FastifyRequest } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import type { ShowItem, ShowItemKind, ShowItemRef, ShowItemState, ShowItemView, ShowView, ShowWearable } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { config } from '../config.js'
import { assistantShows, eventSceneLinks, events, studioJobs, users } from '../db/schema.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'
import { mayUseEvent } from '../routes/events.js'
import { mayRunRaffles } from '../raffles/routes.js'
import { getRaffle, type RaffleRow } from '../raffles/service.js'
import { beatCaller } from '../beats/routes.js'
import { BeatError, getBeat } from '../beats/service.js'
import { manageableScreen } from '../routes/showings.js'
import { designAccessTo } from '../routes/studio.js'
import { finalizedCounts } from '../studio/designs.js'
import { orgNameOf } from './tools/write.js'
import type { AuthUser } from '../middleware/auth.js'

/** An event starting sooner than this, with a wearable still to design, gets the curation warning. */
export const CURATION_DAYS = 7
/** A show's checklist holds 1 to this many items. */
export const SHOW_ITEMS_MAX = 20
export const SHOW_TIMELINE = "Making the wearable takes a few days in Studio, then Decentraland curation, so I can't name it as the prize until it's published. I'll keep it on the checklist."
export const SHOW_TOO_SOON = "This event starts in fewer than 7 days. A new wearable may not be through Decentraland curation by then. A wearable you've already published would be safer."

export const DELETED = 'This was deleted.'
export const WAITING_FOR_PAYMENT = 'Waiting for payment.'
export const PUBLISH_THEN_PASTE = 'Publish it on Decentraland, then paste its Marketplace link.'
export const NOT_YOURS = "That isn't yours, or it's gone."
export const RAFFLE_CANCELLED = 'This raffle was cancelled.'
export const BEAT_CANCELLED = 'This BEAT was cancelled.'
/** A wearable Virvi found by itself: say which, so a wrong pick is easy to replace. */
export const foundNote = (name: string, giveaways = config.giveaways.enabled) =>
  `Found on Decentraland: "${name}". If it isn't the one, paste the right Marketplace link.${giveaways ? GIVE_AWAY_OFFER : ''}`
/** With giveaways on, the found wearable is offered as an automatic giveaway first and a raffle prize second. */
export const GIVE_AWAY_OFFER = ' You can give it away with an automatic giveaway, or make it a raffle prize.'
export const WEARABLE_EXAMPLE = "Paste the wearable's Marketplace link, like https://decentraland.org/marketplace/contracts/0x…/items/0."

/**
 * The ref key each kind of item takes. The followers take none of their own: raffle_scheduled and beat_paid always read
 * the show's raffle and BEAT items, and scene_link's event is always the show's event.
 */
export const REF_KEYS: Record<ShowItemKind, ReadonlyArray<keyof ShowItemRef>> = {
  event: ['eventId'],
  scene_link: ['sceneId'],
  showing: ['showingId'],
  raffle: ['raffleId'],
  raffle_scheduled: [],
  beat: ['beatId'],
  beat_paid: [],
  wearable_design: ['designId'],
  wearable_published: [],
}

export type ShowRow = typeof assistantShows.$inferSelect

const MARKETPLACE = /^https:\/\/decentraland\.org\/marketplace\/contracts\/(0x[0-9a-fA-F]{40})\/items\/(\d{1,30})$/
const CONTRACT = /^0x[0-9a-fA-F]{40}$/
const ITEM_ID = /^\d{1,30}$/
const marketplaceUrl = (contract: string, itemId: string) => `https://decentraland.org/marketplace/contracts/${contract}/items/${itemId}`

/** A pasted wearable: a Marketplace item link, or its contract and item id. Null for anything else. */
export function parseWearable(raw: unknown): ShowWearable | null {
  let contract: string | undefined
  let itemId: string | undefined
  if (typeof raw === 'string') {
    const m = MARKETPLACE.exec(raw.trim())
    if (!m) return null
    ;[, contract, itemId] = m
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    if (Object.keys(o).some((k) => k !== 'contract' && k !== 'itemId')) return null
    if (typeof o.contract !== 'string' || !CONTRACT.test(o.contract)) return null
    if (typeof o.itemId !== 'string' || !ITEM_ID.test(o.itemId)) return null
    ;({ contract, itemId } = o as { contract: string; itemId: string })
  } else {
    return null
  }
  contract = contract!.toLowerCase()
  return { contract, itemId: itemId!, url: marketplaceUrl(contract, itemId!) }
}

/** The organization a new show belongs to: the session's, else the user's active one (as for conversations). */
export async function showOrgId(user: AuthUser): Promise<string | null> {
  if (user.orgId) return user.orgId
  const [me] = await db.select({ activeOrgId: users.activeOrgId }).from(users).where(eq(users.id, user.id))
  return me?.activeOrgId ?? null
}

// ── What the user can see, by the owning routes' rules ──

type Seen<T> = T | null

/** The event, when the user may use it (its owner, or an admin). */
async function seenEvent(user: AuthUser, id: string): Promise<Seen<typeof events.$inferSelect>> {
  const [ev] = await db.select().from(events).where(eq(events.id, id))
  return ev && mayUseEvent(ev, user) ? ev : null
}

/** A scene the user runs (full access), as link-scene requires. */
async function seenScene(user: AuthUser, id: string): Promise<boolean> {
  return isFullAccess(await getSceneAccess(actorFromClaims(user), id))
}

/** A showing whose screen the user may manage, as the showing routes require. */
async function seenShowing(user: AuthUser, id: string): Promise<boolean> {
  const row = await db.query.screenShowings.findFirst({ where: (s, { eq: is }) => is(s.id, id), columns: { elementId: true } })
  if (!row) return false
  const screen = await manageableScreen(user, row.elementId)
  return !!screen && screen !== 'forbidden'
}

/** The raffle, when the user may run raffles in its scene (ownRaffle in raffles/routes.ts). */
async function seenRaffle(user: AuthUser, id: string): Promise<Seen<RaffleRow>> {
  const row = await getRaffle(id)
  return row && (await mayRunRaffles(user, row.sceneId)) ? row : null
}

/** The BEAT, when the user may read it (GET /api/beats/:beatId, which is 404 while BEATs are off). */
async function seenBeat(request: FastifyRequest, id: string): Promise<Seen<{ status: string }>> {
  if (!config.beats.enabled) return null
  try {
    return await getBeat(await beatCaller(request), id)
  } catch (e) {
    if (e instanceof BeatError) return null
    throw e
  }
}

/** The design, when the user may see it (GET /api/studio/designs/:id, which is 404 while Studio is off). */
async function seenDesign(request: FastifyRequest, id: string): Promise<boolean> {
  if (!config.studioEnabled) return false
  // `need: 'view'` never answers VIEWER (that is a work route's refusal): a design or null
  return !!(await designAccessTo(request, id, { need: 'view', allowAdmin: true }))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether the user may attach this row: the owning GET route's rule for each key. */
export async function mayAttach(request: FastifyRequest, key: keyof ShowItemRef, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false
  const user = request.user
  switch (key) {
    case 'eventId': return !!(await seenEvent(user, id))
    case 'sceneId': return seenScene(user, id)
    case 'showingId': return seenShowing(user, id)
    case 'raffleId': return !!(await seenRaffle(user, id))
    case 'beatId': return !!(await seenBeat(request, id))
    case 'designId': return seenDesign(request, id)
  }
}

// ── States ──

type State = { state: ShowItemState; note: string | null }
const done: State = { state: 'done', note: null }
const todo: State = { state: 'todo', note: null }
const waiting = (note: string | null = null): State => ({ state: 'waiting', note })
const skipped: State = { state: 'skipped', note: DELETED }
const cancelled = (note: string): State => ({ state: 'skipped', note })

/** The show's first item of a kind's ref value: raffle_scheduled and beat_paid read the show's raffle and BEAT. */
const shared = (items: ShowItem[], kind: ShowItemKind, key: keyof ShowItemRef) => items.find((i) => i.kind === kind && i.ref?.[key])?.ref[key]

async function stateOf(request: FastifyRequest, show: ShowRow, item: ShowItem): Promise<State> {
  const user = request.user
  const ref = item.ref ?? {}
  switch (item.kind) {
    case 'event':
      if (!ref.eventId) return todo
      return (await seenEvent(user, ref.eventId)) ? done : skipped
    case 'scene_link': {
      if (!ref.sceneId) return todo
      if (!(await seenScene(user, ref.sceneId))) return skipped
      // Linked to the show's event: none yet (or it's gone, which the event item shows) is still to do
      if (!show.eventId || !(await seenEvent(user, show.eventId))) return todo
      const [link] = await db.select().from(eventSceneLinks).where(and(eq(eventSceneLinks.eventId, show.eventId), eq(eventSceneLinks.sceneId, ref.sceneId)))
      return link ? done : todo
    }
    case 'showing':
      if (!ref.showingId) return todo
      return (await seenShowing(user, ref.showingId)) ? done : skipped
    case 'raffle': {
      if (!ref.raffleId) return todo
      const r = await seenRaffle(user, ref.raffleId)
      if (!r) return skipped
      return r.status === 'cancelled' ? cancelled(RAFFLE_CANCELLED) : done
    }
    case 'raffle_scheduled': {
      const id = shared(show.items, 'raffle', 'raffleId')
      if (!id) return todo
      const r = await seenRaffle(user, id)
      if (!r) return skipped
      // A cancelled draft keeps its opens_at: cancelled comes first
      if (r.status === 'cancelled') return cancelled(RAFFLE_CANCELLED)
      return r.opensAt || ['open', 'drawn', 'closed'].includes(r.status) ? done : waiting(r.openError ?? null)
    }
    case 'beat':
      if (!ref.beatId) return todo
      return (await seenBeat(request, ref.beatId)) ? done : skipped
    case 'beat_paid': {
      const id = shared(show.items, 'beat', 'beatId')
      if (!id) return todo
      const b = await seenBeat(request, id)
      if (!b) return skipped
      // A draft never paid for, or a paid one refunded, is cancelled: neither is paid
      if (b.status === 'cancelled') return cancelled(BEAT_CANCELLED)
      return ['paid', 'live', 'ended'].includes(b.status) ? done : waiting(WAITING_FOR_PAYMENT)
    }
    case 'wearable_design': {
      if (!ref.designId) return todo
      if (!(await seenDesign(request, ref.designId))) return skipped
      if (((await finalizedCounts([ref.designId])).get(ref.designId)?.finalizedPieces ?? 0) > 0) return done
      const [job] = await db.select({ id: studioJobs.id }).from(studioJobs)
        .where(and(eq(studioJobs.designId, ref.designId), inArray(studioJobs.status, ['queued', 'taken']))).limit(1)
      return job ? waiting() : todo
    }
    case 'wearable_published':
      if (item.wearable?.found) return { state: 'done', note: foundNote(item.wearable.found.name) }
      return item.wearable ? done : waiting(PUBLISH_THEN_PASTE)
  }
}

/** When the show's event starts: the attached event's start, else the start the user gave. */
async function startOf(user: AuthUser, show: ShowRow): Promise<Date | null> {
  if (show.eventId) {
    const ev = await seenEvent(user, show.eventId)
    if (ev?.startTime) return ev.startTime
  }
  return show.startTime
}

/** The show as the user sees it now: every item's state read from the database. */
export async function computeShow(request: FastifyRequest, show: ShowRow, now = new Date()): Promise<ShowView> {
  const items: ShowItemView[] = []
  for (const item of show.items) {
    const { state, note } = await stateOf(request, show, item)
    items.push({ id: item.id, kind: item.kind, label: item.label, state, note, ref: item.ref ?? {}, wearable: item.wearable ?? null })
  }
  const design = items.find((i) => i.kind === 'wearable_design')
  const start = design && design.state !== 'done' ? await startOf(request.user, show) : null
  return {
    id: show.id,
    title: show.title,
    eventId: show.eventId,
    orgName: await orgNameOf(show.orgId),
    createdAt: show.createdAt.toISOString(),
    closedAt: show.closedAt?.toISOString() ?? null,
    timeline: design ? SHOW_TIMELINE : null,
    warning: start && start.getTime() - now.getTime() < CURATION_DAYS * 86_400_000 ? SHOW_TOO_SOON : null,
    items,
  }
}

/** The user's own show, or null (another user's id, or not an id). */
export async function ownShow(userId: string, showId: unknown): Promise<ShowRow | null> {
  if (typeof showId !== 'string' || !UUID.test(showId)) return null
  const [row] = await db.select().from(assistantShows).where(and(eq(assistantShows.id, showId), eq(assistantShows.userId, userId)))
  return row ?? null
}
