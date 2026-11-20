// Read tools: each wraps one GET route (get_plan and get_scene_publishing wrap two and three).
import { z } from 'zod'
import type { ToolDef } from './types.js'

/** An id as the routes take it. Anything else could steer the URL, so it never reaches one. */
export const id = () => z.guid()

/** `o`'s listed keys that are present. */
export function pick<T extends Record<string, unknown>>(o: T | null | undefined, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!o) return out
  for (const k of keys) if (k in o) out[k] = o[k]
  return out
}

const list = <T = Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
type Obj = Record<string, any>

const sceneArgs = z.object({ sceneId: id() })
const none = z.object({})

function read<A>(def: Omit<ToolDef<A>, 'effect'>): ToolDef<A> {
  return { ...def, effect: 'read' }
}

const ELEMENT_KEYS = ['id', 'type', 'name', 'enabled', 'customId', 'properties', 'roomSetId'] as const
const INSTANCE_KEYS = ['id', 'enabled', 'customId', 'position', 'rotation', 'scale', 'parentInstanceId', 'withCollisions'] as const

export const READ_TOOLS: ToolDef<any>[] = [
  read({
    name: 'get_plan',
    description: "The user's Virvi plan (tier, status, renewal) with its limits, and how much of them they use.",
    input: none,
    call: () => [{ method: 'GET', url: '/api/billing/subscription' }, { method: 'GET', url: '/api/billing/usage' }],
    label: () => 'Check your plan',
    summarize: (res) => {
      const [sub, usage] = res as [Obj, Obj]
      return { ...pick(sub, ['tier', 'status', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'billingEnabled', 'limits']), usage: usage?.usage ?? null }
    },
  }),
  read({
    name: 'list_orgs',
    description: "The organizations the user belongs to, their role in each, and which one is active.",
    input: none,
    call: () => ({ method: 'GET', url: '/api/orgs' }),
    label: () => 'List your organizations',
    summarize: (res) => list<Obj>((res as Obj)?.organizations).map((o) => pick(o, ['id', 'name', 'slug', 'role', 'memberCount', 'isActive'])),
  }),
  read({
    name: 'list_scenes',
    description: 'The scenes the user owns or works on, with their ids, names and relationship (owner, collaborator, crew).',
    input: none,
    call: () => ({ method: 'GET', url: '/api/scenes' }),
    label: () => 'List your scenes',
    summarize: (res) =>
      list<Obj>((res as Obj)?.scenes).map((s) => pick(s, ['id', 'name', 'description', 'orgId', 'activePresetId', 'relationship', 'role', 'updatedAt'])),
  }),
  read({
    name: 'get_scene',
    description: "One scene: its presets (which is live), each preset's elements (screens, images, models, sounds…) with their properties, and each element's instances (placements).",
    input: sceneArgs,
    call: (a) => ({ method: 'GET', url: `/api/scenes/${a.sceneId}` }),
    label: () => 'Read the scene',
    summarize: (res) => {
      const s = ((res as Obj)?.scene ?? {}) as Obj
      return {
        ...pick(s, ['id', 'name', 'description', 'orgId', 'activePresetId', 'thumbnailUrl', 'updatedAt']),
        presets: list<Obj>(s.presets).map((p) => ({
          ...pick(p, ['id', 'name']),
          elements: list<Obj>(p.elements).map((e) => ({ ...pick(e, ELEMENT_KEYS), instances: list<Obj>(e.instances).map((i) => pick(i, INSTANCE_KEYS)) })),
        })),
      }
    },
  }),
  read({
    name: 'get_scene_publishing',
    description: "Where a scene is published: its Decentraland destinations (Worlds or parcels), the publish status, and its recent deployments.",
    input: sceneArgs,
    call: (a) => [
      { method: 'GET', url: `/api/scenes/${a.sceneId}/dcl/destinations` },
      { method: 'GET', url: `/api/scenes/${a.sceneId}/dcl/publish-status` },
      { method: 'GET', url: `/api/deploy/scene/${a.sceneId}` },
    ],
    label: () => "Check the scene's publishing",
    summarize: (res) => {
      const [dest, status, deploys] = res as [Obj, Obj, Obj]
      return {
        destinations: list<Obj>(dest?.destinations).map((d) => pick(d, ['id', 'kind', 'worldName', 'base', 'parcels', 'mode', 'status', 'statusDetail', 'createdAt'])),
        adoptable: list(dest?.adoptable),
        publishStatus: status?.destination ? pick(status.destination, ['id', 'world', 'mode', 'status', 'granted', 'pending']) : null,
        deployments: list<Obj>(deploys?.deployments)
          .slice(0, 10)
          .map((d) => pick(d, ['id', 'platform', 'deploymentType', 'status', 'errorMessage', 'createdAt', 'deployedAt'])),
      }
    },
  }),
  read({
    name: 'get_preset_schedules',
    description: "A scene's scheduled presets (which preset goes live when, and for how long) and what is live now.",
    input: sceneArgs,
    call: (a) => ({ method: 'GET', url: `/api/scenes/${a.sceneId}/preset-schedules` }),
    label: () => "Read the scene's schedules",
    summarize: (res) => ({ schedules: (res as Obj)?.schedules ?? [], status: (res as Obj)?.status ?? null }),
  }),
  read({
    name: 'list_events',
    description: "The user's events.",
    input: none,
    call: () => ({ method: 'GET', url: '/api/events' }),
    label: () => 'List your events',
    summarize: (res) => list<Obj>((res as Obj)?.events).map((e) => pick(e, ['id', 'name', 'description', 'startTime', 'endTime', 'timezone'])),
  }),
  read({
    name: 'get_event',
    description: 'One event: its times, the scenes and giveaways linked to it, and the schedules and showings that follow it.',
    input: z.object({ eventId: id() }),
    call: (a) => ({ method: 'GET', url: `/api/events/${a.eventId}` }),
    label: () => 'Read the event',
    summarize: (res) => {
      const r = (res ?? {}) as Obj
      const e = (r.event ?? {}) as Obj
      return {
        ...pick(e, ['id', 'name', 'description', 'startTime', 'endTime', 'timezone']),
        scenes: list<Obj>(e.sceneLinks).map((l) => pick(l.scene, ['id', 'name'])),
        giveaways: list<Obj>(e.giveawayLinks).map((l) => pick(l.giveaway, ['id', 'name'])),
        presetSchedules: r.presetSchedules ?? [],
        showings: r.showings ?? [],
      }
    },
  }),
  read({
    name: 'list_analytics_locations',
    description: 'The Decentraland locations (parcels or Worlds) whose visitor analytics the user can read.',
    input: none,
    call: () => ({ method: 'GET', url: '/api/analytics/locations' }),
    label: () => 'List your analytics locations',
    summarize: (res) => list<Obj>((res as Obj)?.scenes).map((s) => pick(s, ['id', 'title', 'kind', 'locationKey', 'baseParcel', 'virviSceneId', 'since', 'until'])),
  }),
  read({
    name: 'get_analytics_summary',
    description: "A location's visitor summary between two ISO dates (the last 7 days when left out; at most 400 days).",
    input: z.object({ locationId: id(), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }),
    call: (a) => {
      const q = new URLSearchParams()
      if (a.from) q.set('from', a.from)
      if (a.to) q.set('to', a.to)
      const qs = q.toString()
      return { method: 'GET', url: `/api/analytics/locations/${a.locationId}/summary${qs ? `?${qs}` : ''}` }
    },
    label: () => 'Read visitor analytics',
    summarize: (res) => res,
  }),
  read({
    name: 'get_scene_errors',
    description: "A scene's recent errors (the last 7 days): what failed, how often, and when last.",
    input: sceneArgs,
    call: (a) => ({ method: 'GET', url: `/api/scenes/${a.sceneId}/errors` }),
    label: () => "Check the scene's errors",
    summarize: (res) => res,
  }),
  read({
    name: 'list_media',
    description: "The user's uploaded images and videos (Images & Video), with their web addresses.",
    input: none,
    call: () => ({ method: 'GET', url: '/api/media' }),
    label: () => 'List your images and videos',
    summarize: (res) => list<Obj>((res as Obj)?.assets).map((m) => pick(m, ['id', 'filename', 'contentType', 'publicUrl', 'sizeBytes', 'createdAt'])),
  }),
  read({
    name: 'list_scene_library',
    description: "The files in a scene's library (images, videos and 3D models it can use).",
    input: sceneArgs,
    call: (a) => ({ method: 'GET', url: `/api/scenes/${a.sceneId}/library` }),
    label: () => "List the scene's library",
    summarize: (res) => list<Obj>((res as Obj)?.items).map((i) => pick(i, ['id', 'kind', 'name', 'contentType', 'url', 'status'])),
  }),
  read({
    name: 'list_scene_streams',
    description: "The live streams a scene's video screens can play (name, playback address, whether it's live).",
    input: sceneArgs,
    call: (a) => ({ method: 'GET', url: `/api/scenes/${a.sceneId}/streams` }),
    label: () => "List the scene's streams",
    summarize: (res) => list<Obj>((res as Obj)?.streams).map((s) => pick(s, ['id', 'name', 'hlsPlaylistUrl', 'live', 'mine'])),
  }),
  read({
    name: 'list_showings',
    description: "A video screen's scheduled showings (programmes of videos at set times), and the scene's events a showing can follow.",
    input: z.object({ elementId: id() }),
    call: (a) => ({ method: 'GET', url: `/api/elements/${a.elementId}/showings` }),
    label: () => "List the screen's showings",
    summarize: (res) => ({
      showings: list<Obj>((res as Obj)?.showings).map((s) =>
        pick(s, ['id', 'title', 'description', 'enabled', 'eventId', 'recurrence', 'startDate', 'startTime', 'weekdays', 'timezone', 'items', 'lengthSeconds', 'nextStarts']),
      ),
      events: (res as Obj)?.events ?? [],
    }),
  }),
]
