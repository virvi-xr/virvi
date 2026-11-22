// Event, raffle and BEAT tools. Creating a raffle accepts Virvi's raffle host terms, so it is public: only ever a card
// whose detail shows the terms word for word, and `acceptHostTerms: true` is added here, never taken from the model.
// Scheduling a raffle to open is public too (it opens to visitors by itself). A BEAT is only ever made as a draft; paying
// for it is the user's own step on its page (open_beat_pay in local.ts links there with the server's price).
import { z } from 'zod'
import { BEAT_DESCRIPTION_MAX, BEAT_MIN_PRESENT_MAX_MINUTES, BEAT_NAME_MAX, BEAT_SUPPLY_CAP_MAX, MIN_PRESENT_MAX_MINUTES, RAFFLE_HOST_TERMS, RAFFLE_WINNERS_MAX, SHOW_ITEM_KINDS, type RaffleMode } from '@virvixr/shared'
import { id, pick } from './read.js'
import { atLeastOne, created, fields, get, orgNameOf, previous, sceneState, setKeys } from './write.js'
import { ToolError, type Before, type ToolCtx, type ToolDef } from './types.js'
import { isUuid } from '../conversations.js'
import { SHOW_ITEMS_MAX, showOrgId } from '../shows.js'

type Obj = Record<string, any>
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v : [])

const iso = () => z.iso.datetime({ offset: true })
/** An ISO time as the cards show it: `2031-03-04 20:30` (UTC). */
const utc = (at: string) => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

export const RAFFLE_TERMS_CONFIRM = 'Confirming accepts these terms for this raffle.'
/** The raffle draw modes (MODES in raffles/service.ts). */
const RAFFLE_MODES = ['one_per_person', 'weighted'] as const satisfies readonly RaffleMode[]
const RAFFLE_KEYS = ['id', 'sceneId', 'name', 'prize', 'winnersCount', 'mode', 'minPresentMinutes', 'status', 'entryCount', 'opensAt', 'openError'] as const
const NOT_DRAFT = "Only a raffle that hasn't opened can be scheduled."

const EVENT_FIELDS = ['name', 'description', 'startTime', 'endTime', 'timezone'] as const
const BEAT_KEYS = ['id', 'name', 'status', 'startsAt', 'endsAt', 'supplyCap', 'sceneIds'] as const
const BEAT_FIELDS = ['name', 'description', 'startsAt', 'endsAt', 'sceneIds', 'imageMediaId', 'supplyCap', 'minPresentMinutes', 'tradeable'] as const

const ENDS_BEFORE_START = 'The event must end after it starts.'
const endsAfterStart = (a: { startTime?: string | null; endTime?: string | null }) => !a.startTime || !a.endTime || new Date(a.endTime) > new Date(a.startTime)

/** An event's fields, and how many things are attached to it: everything deleting it would lose. */
const EVENT_KEPT = ['id', 'name', 'description', 'startTime', 'endTime', 'timezone'] as const
function eventFootprint(r: Obj): Obj {
  const event = (r.event ?? {}) as Obj
  return {
    ...fields(event, EVENT_KEPT),
    sceneLinks: list(event.sceneLinks).length,
    giveawayLinks: list(event.giveawayLinks).length,
    presetSchedules: list(r.presetSchedules).length,
    showings: list(r.showings).length,
  }
}

/** The ids of a scene's preset schedules and showings that follow an event: what unlinking that scene drops or pauses. */
const followingIn = (r: Obj, sceneId: string): string[] =>
  [...list(r.presetSchedules), ...list(r.showings)].filter((x) => x.sceneId === sceneId).map((x) => String(x.id)).sort()

/** The event as the user sees it (their own; the route's refusal otherwise), and its organization's name. */
async function eventState(ctx: ToolCtx, eventId: string): Promise<{ event: Obj; orgName: string | null }> {
  const event = ((await get(ctx, `/api/events/${eventId}`)).event ?? {}) as Obj
  return { event, orgName: await orgNameOf(event.orgId) }
}

/** The raffle as its host sees it (the route's refusal otherwise), and its scene's organization's name. */
async function raffleState(ctx: ToolCtx, raffleId: string): Promise<{ raffle: Obj; orgName: string | null }> {
  const raffle = ((await get(ctx, `/api/raffles/${raffleId}`)).raffle ?? {}) as Obj
  return { raffle, orgName: (await sceneState(ctx, raffle.sceneId)).orgName }
}

const winners = (n: number) => `${n} winner${n === 1 ? '' : 's'}`

// ── Shows: a saved checklist for one event (assistant/shows.ts computes each item's state from the real rows) ──

const SHOW_KINDS_HELP =
  'event (make the event), scene_link (link a scene to it), showing (a screening on a screen), raffle (make the raffle), raffle_scheduled (schedule it to open), beat (draft the BEAT), beat_paid (the user pays for it), wearable_design (design the wearable in Studio and finalize it), wearable_published (the user publishes it on Decentraland and pastes its Marketplace link)'
const SHOW_ITEM_KEYS = ['id', 'kind', 'label', 'state', 'note', 'ref', 'wearable'] as const
const showSummary = (v: unknown) => {
  const s = (v ?? {}) as Obj
  return { ...pick(s, ['id', 'title', 'eventId', 'closedAt', 'timeline', 'warning']), items: list(s.items).map((i) => pick(i, SHOW_ITEM_KEYS)) }
}
const showUrl = (showId: string) => `/api/assistant/shows/${showId}`
/** The conversation the tool runs in, when the route has one: a new show remembers where it started. */
const conversationOf = (ctx: ToolCtx) => {
  const c = (ctx.request.params as Obj | undefined)?.conversationId
  return isUuid(c) ? c : undefined
}
const refArgs = z.object({ eventId: id().optional(), sceneId: id().optional(), showingId: id().optional(), raffleId: id().optional(), beatId: id().optional(), designId: id().optional() })
const wearableArg = z.union([z.string().max(300), z.object({ contract: z.string().max(64), itemId: z.string().max(40) }), z.null()])
/** The item's ref and wearable (only the keys the write set), as the show's view has them. */
const itemFields = (view: unknown, itemId: string, keys: string[]) => {
  const item = list((view as Obj)?.items).find((i) => i.id === itemId)
  return item ? fields(item, keys) : null
}

const SHOW_TOOLS: ToolDef<any>[] = [
  {
    name: 'start_show',
    description:
      `Start a show: a saved checklist for one event, kept with the user's account, so any conversation can pick it up. List every item it needs, in order, each a kind and a short label. Kinds: ${SHOW_KINDS_HELP}. Pass the event's start (startTime, ISO) whenever the user gave one. It returns timeline and warning: say them to the user, in those words, before going further. Then make each thing and attach_to_show it.`,
    input: z.object({
      title: z.string().trim().min(1).max(120),
      startTime: iso().optional(),
      items: z.array(z.object({ kind: z.enum(SHOW_ITEM_KINDS), label: z.string().trim().min(1).max(120) })).min(1).max(SHOW_ITEMS_MAX),
    }),
    effect: 'write',
    call: (a, ctx) => ({ method: 'POST', url: '/api/assistant/shows', body: { ...pick(a, ['title', 'startTime', 'items']), ...(conversationOf(ctx) ? { conversationId: conversationOf(ctx) } : {}) } }),
    // Undo closes it; a closed show is left alone (closed since is changed)
    before: async (_a, ctx): Promise<Before> => ({
      undo: (res) => ({ method: 'POST', url: `${showUrl((res as Obj).id)}/close` }),
      after: (res) => ({ id: (res as Obj).id, closedAt: null }),
      orgName: await orgNameOf(await showOrgId(ctx.user)),
    }),
    currentOf: async (after, _a, ctx) => fields(await get(ctx, showUrl((after as Obj)?.id)), ['id', 'closedAt']),
    label: (a) => `Start the show "${a.title}"`,
    summarize: showSummary,
  },
  {
    name: 'get_show',
    description: "One show: its event, the timeline and warning, and each item's state (todo, waiting, done, skipped), note and what is attached (ref, wearable).",
    input: z.object({ showId: id() }),
    effect: 'read',
    call: (a) => ({ method: 'GET', url: showUrl(a.showId) }),
    label: () => 'Read the show',
    summarize: showSummary,
  },
  {
    name: 'list_shows',
    description: "The user's open shows, newest first, or only an event's (eventId).",
    input: z.object({ eventId: id().optional() }),
    effect: 'read',
    call: (a) => ({ method: 'GET', url: a.eventId ? `/api/assistant/shows?eventId=${a.eventId}` : '/api/assistant/shows' }),
    label: () => 'List your shows',
    summarize: (res) => list((res as Obj)?.shows).map(showSummary),
  },
  {
    name: 'attach_to_show',
    description:
      "Attach what was made to a show's item, by its id (ref): eventId for event, sceneId for scene_link, showingId, raffleId (raffle, raffle_scheduled), beatId (beat, beat_paid), designId (wearable_design). An empty ref clears it. For wearable_published, wearable is the Marketplace link the user pasted (or { contract, itemId }); null clears it. raffle_scheduled and beat_paid read the show's raffle and BEAT when given none.",
    input: z
      .object({ showId: id(), itemId: id(), ref: refArgs.optional(), wearable: wearableArg.optional() })
      .refine((a) => a.ref !== undefined || a.wearable !== undefined, 'Give a ref or a wearable.'),
    effect: 'write',
    call: (a) => ({ method: 'PATCH', url: `${showUrl(a.showId)}/items/${a.itemId}`, body: pick(a, setKeys(a, ['showId', 'itemId'])) }),
    before: async (a, ctx): Promise<Before> => {
      const view = await get(ctx, showUrl(a.showId))
      const keys = setKeys(a, ['showId', 'itemId'])
      const now = itemFields(view, a.itemId, ['ref', 'wearable'])
      if (!now) throw new ToolError(404, "That item isn't in this show.")
      return {
        undo: { method: 'PATCH', url: `${showUrl(a.showId)}/items/${a.itemId}`, body: previous(now, keys) },
        after: (res) => itemFields(res, a.itemId, keys),
        current: fields(now, keys),
        orgName: (view.orgName ?? null) as string | null,
      }
    },
    label: (a) => (a.wearable !== undefined && a.ref === undefined ? "Add the wearable's link to the show" : 'Attach it to the show'),
    summarize: showSummary,
  },
  {
    name: 'close_show',
    description: "Close a show once it's finished or no longer wanted: it drops out of list_shows.",
    input: z.object({ showId: id() }),
    effect: 'write',
    call: (a) => ({ method: 'POST', url: `${showUrl(a.showId)}/close` }),
    // There is no reopening a show, so no undo
    before: async (a, ctx): Promise<Before> => {
      const view = await get(ctx, showUrl(a.showId))
      return { undo: null, after: (res) => fields(res, ['closedAt']), current: fields(view, ['closedAt']), orgName: (view.orgName ?? null) as string | null }
    },
    label: () => 'Close the show',
    summarize: showSummary,
  },
]

export const SHOWS_TOOLS: ToolDef<any>[] = [
  {
    name: 'create_event',
    description: "Make an event in the user's active organization (or personal account): a name, start and end times (ISO), and its timezone (IANA, UTC when left out). Link scenes to it with link_event_scene.",
    input: z
      .object({ name: z.string().trim().min(1).max(120), description: z.string().max(2000).optional(), startTime: iso(), endTime: iso(), timezone: z.string().min(1).max(64).optional() })
      .refine(endsAfterStart, ENDS_BEFORE_START),
    effect: 'write',
    call: (a) => ({ method: 'POST', url: '/api/events', body: pick(a, EVENT_FIELDS) }),
    // The route records the event in the token's organization: the same one ctx.user carries. Deleting an event drops
    // its links and the schedules that follow it, and pauses its showings, so Undo compares those too: a new event has
    // none, and anything attached or edited since makes it refuse.
    before: async (_a, ctx): Promise<Before> => ({
      undo: (res) => ({ method: 'DELETE', url: `/api/events/${created(res, 'event').id}` }),
      after: (res) => eventFootprint({ event: created(res, 'event') }),
      orgName: await orgNameOf(ctx.user.orgId),
    }),
    currentOf: async (after, _a, ctx) => {
      const now = eventFootprint(await get(ctx, `/api/events/${(after as Obj)?.id}`))
      return now.id === (after as Obj)?.id ? now : null
    },
    label: (a) => `Create event "${a.name}"`,
    summarize: (res) => fields(created(res, 'event'), ['id', ...EVENT_FIELDS]),
  },
  {
    name: 'update_event',
    description: "Change an event's name, description, start or end time (ISO) or timezone: only the fields given change.",
    input: z
      .object({
        eventId: id(),
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(2000).optional(),
        startTime: iso().optional(),
        endTime: iso().optional(),
        timezone: z.string().min(1).max(64).optional(),
      })
      .refine(atLeastOne(['eventId']), 'Give something to change.'),
    effect: 'write',
    call: (a) => ({ method: 'PUT', url: `/api/events/${a.eventId}`, body: pick(a, setKeys(a, ['eventId'])) }),
    before: async (a, ctx): Promise<Before> => {
      const { event, orgName } = await eventState(ctx, a.eventId)
      // Only one end given: it is checked against the event's other end as it is now
      if (!endsAfterStart({ startTime: a.startTime ?? event.startTime, endTime: a.endTime ?? event.endTime })) throw new ToolError(400, ENDS_BEFORE_START)
      const keys = setKeys(a, ['eventId'])
      return { undo: { method: 'PUT', url: `/api/events/${a.eventId}`, body: previous(event, keys) }, after: (res) => fields(created(res, 'event'), keys), current: fields(event, keys), orgName }
    },
    label: (a) => (a.name !== undefined ? `Rename event to "${a.name}"` : 'Change the event'),
    summarize: (res) => fields(created(res, 'event'), ['id', ...EVENT_FIELDS]),
  },
  {
    name: 'link_event_scene',
    description: "Link one of the user's scenes to an event, so the scene's schedules and showings can follow the event.",
    input: z.object({ eventId: id(), sceneId: id() }),
    effect: 'write',
    call: (a) => ({ method: 'POST', url: `/api/events/${a.eventId}/link-scene`, body: { sceneId: a.sceneId } }),
    before: async (a, ctx): Promise<Before> => {
      const r = await get(ctx, `/api/events/${a.eventId}`)
      const linked = list(r.event?.sceneLinks).some((l) => l.sceneId === a.sceneId)
      // Unlinking drops the scene's schedules that follow the event and pauses its showings: Undo refuses once any
      // follow it that didn't at link time. A scene already linked, or with any already following, has nothing to undo.
      const following = followingIn(r, a.sceneId)
      return {
        undo: linked || following.length ? null : { method: 'DELETE', url: `/api/events/${a.eventId}/unlink-scene/${a.sceneId}` },
        after: () => ({ linked: true, following }),
        current: { linked, following },
        orgName: await orgNameOf(r.event?.orgId),
      }
    },
    label: () => 'Link a scene to the event',
    summarize: (res) => pick((res as Obj)?.link, ['eventId', 'sceneId']),
  },
  {
    name: 'list_scene_raffles',
    description: "A scene's raffles: name, prize, winners, mode, status, entries, and when a draft opens by itself (opensAt).",
    input: z.object({ sceneId: id() }),
    effect: 'read',
    call: (a) => ({ method: 'GET', url: `/api/scenes/${a.sceneId}/raffles` }),
    label: () => "List the scene's raffles",
    summarize: (res) => list((res as Obj)?.raffles).map((r) => pick(r, RAFFLE_KEYS)),
  },
  {
    name: 'create_raffle',
    description:
      "Create a draft raffle in a scene: its name, prize, number of winners, mode (one_per_person, or weighted by attendance), the minimum minutes present (optional) and when it opens by itself (opensAt, ISO, optional). Creating it accepts Virvi's raffle host terms, so the user sees a card with the terms and confirms it.",
    input: z.object({
      sceneId: id(),
      name: z.string().trim().min(1).max(80),
      prize: z.string().trim().min(1).max(200),
      winnersCount: z.number().int().min(1).max(RAFFLE_WINNERS_MAX),
      mode: z.enum(RAFFLE_MODES),
      minPresentMinutes: z.number().min(0).max(MIN_PRESENT_MAX_MINUTES).optional(),
      opensAt: iso().optional(),
    }),
    effect: 'public',
    // The terms are accepted here, by the confirmed card: never from the model's args (the schema drops any it sends)
    call: (a) => ({ method: 'POST', url: `/api/scenes/${a.sceneId}/raffles`, body: { ...pick(a, ['name', 'prize', 'winnersCount', 'mode', 'minPresentMinutes', 'opensAt']), acceptHostTerms: true } }),
    // The scene must be one the user runs raffles in: the list route's refusal (a viewer can read the scene but not this)
    before: async (a, ctx): Promise<Before> => {
      const { orgName } = await sceneState(ctx, a.sceneId)
      await get(ctx, `/api/scenes/${a.sceneId}/raffles`)
      return { undo: null, after: (res) => fields(created(res, 'raffle'), ['id', 'name']), orgName }
    },
    preview: async (a, ctx) => {
      const { scene } = await sceneState(ctx, a.sceneId)
      const line = `"${scene.name ?? ''}": ${a.name}, prize "${a.prize}", ${winners(a.winnersCount)}${a.opensAt ? `, opens ${utc(a.opensAt)} UTC` : ''}`
      return { detail: `${line}\n\n${RAFFLE_HOST_TERMS}\n${RAFFLE_TERMS_CONFIRM}` }
    },
    label: (a) => `Create raffle "${a.name}"`,
    summarize: (res) => pick(created(res, 'raffle'), RAFFLE_KEYS),
  },
  {
    name: 'schedule_raffle_open',
    description: "Schedule a draft raffle to open to visitors by itself at a time (opensAt, ISO, in the future), or null to stop it opening by itself. The user confirms it on a card.",
    input: z.object({ raffleId: id(), opensAt: iso().nullable() }),
    effect: 'public',
    call: (a) => ({ method: 'PATCH', url: `/api/raffles/${a.raffleId}`, body: { opensAt: a.opensAt } }),
    before: async (a, ctx): Promise<Before> => {
      const { raffle, orgName } = await raffleState(ctx, a.raffleId)
      if (raffle.status !== 'draft') throw new ToolError(400, NOT_DRAFT)
      return { undo: null, after: (res) => fields(created(res, 'raffle'), ['opensAt']), orgName }
    },
    preview: async (a, ctx) => {
      const { raffle } = await raffleState(ctx, a.raffleId)
      return { detail: a.opensAt ? `Open "${raffle.name}" by itself at ${utc(a.opensAt)} UTC` : `Stop "${raffle.name}" opening by itself` }
    },
    label: (a) => (a.opensAt ? `Schedule the raffle to open at ${utc(a.opensAt)} UTC` : 'Stop the raffle opening by itself'),
    summarize: (res) => pick(created(res, 'raffle'), RAFFLE_KEYS),
  },
  {
    name: 'update_raffle_prize',
    description: "Change what a raffle's prize is (while it is a draft or open).",
    input: z.object({ raffleId: id(), prize: z.string().trim().min(1).max(200) }),
    effect: 'write',
    call: (a) => ({ method: 'PATCH', url: `/api/raffles/${a.raffleId}`, body: { prize: a.prize } }),
    before: async (a, ctx): Promise<Before> => {
      const { raffle, orgName } = await raffleState(ctx, a.raffleId)
      return { undo: { method: 'PATCH', url: `/api/raffles/${a.raffleId}`, body: { prize: raffle.prize } }, after: (res) => fields(created(res, 'raffle'), ['prize']), current: fields(raffle, ['prize']), orgName }
    },
    label: (a) => `Change the raffle prize to "${a.prize}"`,
    summarize: (res) => pick(created(res, 'raffle'), RAFFLE_KEYS),
  },
  {
    name: 'create_beat_draft',
    description:
      "Make a draft BEAT (an attendance token visitors claim): its name, description, start and end (ISO, up to 31 days apart, in the future), the scenes it runs in, a square image from the user's Images & Video (imageMediaId, from list_media), the supply (supplyCap), the minutes a visitor must be present and whether it can be traded. It isn't paid for: give the user open_beat_pay for that.",
    input: z.object({
      name: z.string().trim().min(1).max(BEAT_NAME_MAX),
      description: z.string().max(BEAT_DESCRIPTION_MAX).optional(),
      startsAt: iso(),
      endsAt: iso(),
      sceneIds: z.array(id()).min(1).max(20),
      imageMediaId: id(),
      supplyCap: z.number().int().min(1).max(BEAT_SUPPLY_CAP_MAX).optional(),
      minPresentMinutes: z.number().int().min(0).max(BEAT_MIN_PRESENT_MAX_MINUTES).optional(),
      tradeable: z.boolean().optional(),
    }),
    effect: 'write',
    call: (a) => ({ method: 'POST', url: '/api/beats', body: pick(a, BEAT_FIELDS) }),
    // No undo: a draft BEAT is cancelled on its page. The row names the first scene's organization.
    before: async (a, ctx): Promise<Before> => ({ undo: null, after: (res) => pick(res as Obj, ['id', 'name', 'status']), orgName: (await sceneState(ctx, a.sceneIds[0])).orgName }),
    label: (a) => `Create a BEAT draft "${a.name}"`,
    summarize: (res) => pick(res as Obj, BEAT_KEYS),
  },
  {
    name: 'get_beat',
    description: 'One BEAT: its name, status (draft, paid, live, ended, cancelled), start and end, supply and scenes.',
    input: z.object({ beatId: id() }),
    effect: 'read',
    call: (a) => ({ method: 'GET', url: `/api/beats/${a.beatId}` }),
    label: () => 'Read the BEAT',
    summarize: (res) => pick(res as Obj, BEAT_KEYS),
  },
  ...SHOW_TOOLS,
]
