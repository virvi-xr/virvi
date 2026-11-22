// Event, raffle and BEAT tools. Creating a raffle accepts Virvi's raffle host terms, so it is public: only ever a card
// whose detail shows the terms word for word, and `acceptHostTerms: true` is added here, never taken from the model.
// Scheduling a raffle to open is public too (it opens to visitors by itself). A BEAT is only ever made as a draft; paying
// for it is the user's own step on its page (open_beat_pay in local.ts links there with the server's price).
import { z } from 'zod'
import { BEAT_DESCRIPTION_MAX, BEAT_MIN_PRESENT_MAX_MINUTES, BEAT_NAME_MAX, BEAT_SUPPLY_CAP_MAX, MIN_PRESENT_MAX_MINUTES, RAFFLE_HOST_TERMS, RAFFLE_WINNERS_MAX, type RaffleMode } from '@virvixr/shared'
import { id, pick } from './read.js'
import { atLeastOne, created, fields, get, orgNameOf, previous, sceneState, setKeys } from './write.js'
import { ToolError, type Before, type ToolCtx, type ToolDef } from './types.js'

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
]
