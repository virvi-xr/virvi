// Write tools: each wraps one route, and its `before` reads the current values first (through the user's own GET
// routes), so the write can be undone and its row names its organization.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { organizations } from '../../db/schema.js'
import { inject, routeError } from './http.js'
import { id, pick } from './read.js'
import { ToolError, type Before, type Call, type ToolCtx, type ToolDef } from './types.js'

type Obj = Record<string, any>
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v : [])

function write<A>(def: Omit<ToolDef<A>, 'effect'> & { before: NonNullable<ToolDef<A>['before']> }): ToolDef<A> {
  return { ...def, effect: 'write' }
}

/** GET `url` as the user; their refusal (403, 404) is the tool's. */
export async function get(ctx: ToolCtx, url: string, words?: Record<string, string>): Promise<Obj> {
  const res = await inject(ctx, { method: 'GET', url })
  if (res.status >= 400) throw new ToolError(res.status, routeError(res.status, res.json, words))
  return (res.json ?? {}) as Obj
}

/** An organization's name; null for none (a personal account). */
export async function orgNameOf(orgId: unknown): Promise<string | null> {
  if (typeof orgId !== 'string' || !orgId) return null
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId))
  return org?.name ?? null
}

/** The scene as the user sees it (presets → elements → instances), and its organization's name. */
export async function sceneState(ctx: ToolCtx, sceneId: string): Promise<{ scene: Obj; orgName: string | null }> {
  const scene = ((await get(ctx, `/api/scenes/${sceneId}`)).scene ?? {}) as Obj
  return { scene, orgName: await orgNameOf(scene.orgId) }
}

const presetIn = (scene: Obj, presetId: string): Obj => {
  const p = list(scene.presets).find((x) => x.id === presetId)
  if (!p) throw new ToolError(404, "That preset isn't in this scene.")
  return p
}
const elementIn = (scene: Obj, elementId: string): Obj => {
  for (const p of list(scene.presets)) for (const e of list(p.elements)) if (e.id === elementId) return e
  throw new ToolError(404, "That element isn't in this scene.")
}
const instanceIn = (scene: Obj, instanceId: string): Obj => {
  for (const p of list(scene.presets)) for (const e of list(p.elements)) for (const i of list(e.instances)) if (i.id === instanceId) return i
  throw new ToolError(404, "That instance isn't in this scene.")
}

const elementsOf = (scene: Obj): Obj[] => list(scene.presets).flatMap((p) => list(p.elements))
const instancesOf = (scene: Obj): Obj[] => elementsOf(scene).flatMap((e) => list(e.instances))
/** The created row's current values for `after`'s keys, found by `after`'s id; null when it's gone. */
export const createdNow = (rows: Obj[], after: unknown): Obj | null => {
  const a = (after ?? {}) as Obj
  const row = a.id ? rows.find((r) => r.id === a.id) : undefined
  return row ? pick(row, Object.keys(a)) : null
}

/** The keys of `args` a write sets (everything but the ids that address it). */
export const setKeys = (args: Obj, ids: string[]) => Object.keys(args).filter((k) => !ids.includes(k) && args[k] !== undefined)
/** `prev`'s values for `keys`, null where it had none: the body that puts them back. */
export const previous = (prev: Obj, keys: string[]) => Object.fromEntries(keys.map((k) => [k, prev[k] ?? null]))
export const fields = (o: unknown, keys: readonly string[]) => pick((o ?? {}) as Obj, keys)
export const created = (res: unknown, key: string): Obj => (((res ?? {}) as Obj)[key] ?? {}) as Obj
export const atLeastOne = (ids: string[]) => (a: Obj) => setKeys(a, ids).length > 0

const vec = z.object({ x: z.number(), y: z.number(), z: z.number() })
const props = z.record(z.string(), z.unknown())
const name = (max: number) => z.string().trim().min(1).max(max)
const recurrence = z.enum(['once', 'daily', 'weekly'])
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const time = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM (24-hour)')
const weekdays = z.array(z.number().int().min(0).max(6))

const SCHEDULE_FIELDS = ['presetId', 'recurrence', 'startDate', 'startTime', 'weekdays', 'durationMinutes', 'timezone', 'returnToPresetId', 'enabled', 'eventId'] as const
const scheduleFields = {
  presetId: id(),
  recurrence,
  startDate: date,
  startTime: time,
  weekdays: weekdays.optional(),
  durationMinutes: z.number().int().min(1).nullable().optional(),
  timezone: z.string().min(1),
  returnToPresetId: id().nullable().optional(),
  enabled: z.boolean().optional(),
  eventId: id().nullable().optional(),
}

const SHOWING_FIELDS = ['id', 'title', 'description', 'posterUrl', 'items', 'enabled', 'eventId', 'recurrence', 'startDate', 'startTime', 'weekdays', 'timezone'] as const
const ELEMENT_TYPES = ['image', 'video', 'nft', 'sound', 'widget', 'model', 'custom', 'ad_space'] as const
const INSTANCE_FIELDS = ['position', 'rotation', 'scale', 'enabled'] as const

export const WRITE_TOOLS: ToolDef<any>[] = [
  write({
    name: 'create_scene',
    description: "Make a new, empty scene in the user's personal account, with one preset (Default) that is live.",
    input: z.object({ name: name(100), description: z.string().max(500).optional() }),
    call: (a) => ({ method: 'POST', url: '/api/scenes', body: pick(a, ['name', 'description']) }),
    // Undoing a create would be a delete, which the assistant doesn't do
    before: async () => ({ undo: null, after: (res) => fields(created(res, 'scene'), ['id', 'name']), orgName: null }),
    label: (a) => `Create scene "${a.name}"`,
    summarize: (res) => ({ sceneId: created(res, 'scene').id, presetId: created(res, 'preset').id, name: created(res, 'scene').name }),
  }),
  write({
    name: 'update_scene',
    description: "Rename a scene or change its description.",
    input: z.object({ sceneId: id(), name: name(100).optional(), description: z.string().max(2000).nullable().optional() }).refine(atLeastOne(['sceneId']), 'Give a name or a description.'),
    call: (a) => ({ method: 'PUT', url: `/api/scenes/${a.sceneId}`, body: pick(a, setKeys(a, ['sceneId'])) }),
    before: async (a, ctx): Promise<Before> => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      const keys = setKeys(a, ['sceneId'])
      return { undo: { method: 'PUT', url: `/api/scenes/${a.sceneId}`, body: previous(scene, keys) }, after: (res) => fields(created(res, 'scene'), keys), current: fields(scene, keys), orgName }
    },
    label: (a) => (a.name !== undefined ? `Rename scene to "${a.name}"${a.description !== undefined ? ' and change its description' : ''}` : "Change the scene's description"),
    summarize: (res) => fields(created(res, 'scene'), ['id', 'name', 'description']),
  }),
  write({
    name: 'create_preset',
    description: 'Add a preset to a scene: blank, or a copy of one of its presets (fromPresetId). It does not go live.',
    input: z.object({ sceneId: id(), name: name(100), fromPresetId: id().optional() }),
    call: (a) => ({ method: 'POST', url: `/api/scenes/${a.sceneId}/presets`, body: pick(a, ['name', 'fromPresetId']) }),
    before: async (a, ctx) => {
      const { orgName } = await sceneState(ctx, a.sceneId)
      return { undo: (res) => ({ method: 'DELETE', url: `/api/presets/${created(res, 'preset').id}` }), after: (res) => fields(created(res, 'preset'), ['id', 'name']), orgName }
    },
    currentOf: async (after, a, ctx) => createdNow(list((await sceneState(ctx, a.sceneId)).scene.presets), after),
    label: (a) => `Add preset "${a.name}"`,
    summarize: (res) => fields(created(res, 'preset'), ['id', 'name', 'sceneId']),
  }),
  write({
    name: 'rename_preset',
    description: "Rename one of a scene's presets.",
    input: z.object({ sceneId: id(), presetId: id(), name: name(100) }),
    call: (a) => ({ method: 'PATCH', url: `/api/presets/${a.presetId}`, body: { name: a.name } }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      const preset = presetIn(scene, a.presetId)
      return { undo: { method: 'PATCH', url: `/api/presets/${a.presetId}`, body: { name: preset.name } }, after: (res) => fields(created(res, 'preset'), ['name']), current: fields(preset, ['name']), orgName }
    },
    label: (a) => `Rename preset to "${a.name}"`,
    summarize: (res) => fields(created(res, 'preset'), ['id', 'name']),
  }),
  write({
    name: 'activate_preset',
    description: "Make one of a scene's presets the live one: everyone in the scene sees it straight away.",
    input: z.object({ sceneId: id(), presetId: id() }),
    call: (a) => ({ method: 'POST', url: `/api/presets/${a.presetId}/activate` }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      presetIn(scene, a.presetId)
      const prev = (scene.activePresetId ?? null) as string | null
      const undo: Call | null =
        prev === a.presetId ? null
        : prev ? { method: 'POST', url: `/api/presets/${prev}/activate` }
        : { method: 'PUT', url: `/api/scenes/${a.sceneId}`, body: { activePresetId: null } }
      return { undo, after: (res) => fields(res, ['activePresetId']), current: { activePresetId: prev }, orgName }
    },
    label: () => 'Switch the live preset',
    summarize: (res) => res,
  }),
  write({
    name: 'create_element',
    description: "Add an element (a video screen, image, sound, 3D model, widget…) to one of a scene's presets. It has no placement until add_instance.",
    input: z.object({ sceneId: id(), presetId: id(), type: z.enum(ELEMENT_TYPES), name: name(200), enabled: z.boolean().optional(), properties: props.optional() }),
    call: (a) => ({ method: 'POST', url: `/api/presets/${a.presetId}/elements`, body: pick(a, ['type', 'name', 'enabled', 'properties']) }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      presetIn(scene, a.presetId)
      return {
        undo: (res) => ({ method: 'DELETE', url: `/api/elements/${created(res, 'element').id}` }),
        after: (res) => fields(created(res, 'element'), ['id', 'type', 'name', 'enabled', 'properties']),
        orgName,
      }
    },
    currentOf: async (after, a, ctx) => createdNow(elementsOf((await sceneState(ctx, a.sceneId)).scene), after),
    label: (a) => `Add ${a.type.replace('_', ' ')} "${a.name}"`,
    summarize: (res) => fields(created(res, 'element'), ['id', 'type', 'name', 'enabled', 'properties']),
  }),
  write({
    name: 'update_element',
    description:
      "Change an element: its name, whether it shows (enabled), or some of its properties. `properties` is merged into the element's current properties, so send only the ones that change (a screen's liveSrc, playlist, offImageSrc; an image's textureSrc…).",
    input: z.object({ sceneId: id(), elementId: id(), name: name(200).optional(), enabled: z.boolean().optional(), properties: props.optional() }).refine(atLeastOne(['sceneId', 'elementId']), 'Give something to change.'),
    // The PUT replaces properties whole: the partial ones go over the element's current ones
    call: async (a, ctx) => {
      const body: Obj = pick(a, setKeys(a, ['sceneId', 'elementId', 'properties']))
      if (a.properties) body.properties = { ...(elementIn((await sceneState(ctx, a.sceneId)).scene, a.elementId).properties ?? {}), ...a.properties }
      return { method: 'PUT', url: `/api/elements/${a.elementId}`, body }
    },
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      const el = elementIn(scene, a.elementId)
      const keys = setKeys(a, ['sceneId', 'elementId'])
      return {
        // Only what this write set: a newer hand edit of another field is left alone (and isn't compared)
        undo: { method: 'PUT', url: `/api/elements/${a.elementId}`, body: { ...previous(el, keys), ...(a.properties ? { properties: el.properties ?? {} } : {}) } },
        after: (res) => fields(created(res, 'element'), keys),
        current: fields(el, keys),
        orgName,
      }
    },
    label: (a) => {
      if (a.name !== undefined) return `Rename element to "${a.name}"`
      if (a.properties === undefined) return a.enabled ? 'Show the element' : 'Hide the element'
      return 'Update the element'
    },
    summarize: (res) => fields(created(res, 'element'), ['id', 'type', 'name', 'enabled', 'properties']),
  }),
  write({
    name: 'set_element_live',
    description: "Turn a video screen's live stream on or off (it plays its liveSrc when on).",
    input: z.object({ sceneId: id(), elementId: id(), enabled: z.boolean() }),
    call: (a) => ({ method: 'POST', url: `/api/elements/${a.elementId}/live`, body: { enabled: a.enabled } }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      const el = elementIn(scene, a.elementId)
      return {
        undo: { method: 'POST', url: `/api/elements/${a.elementId}/live`, body: { enabled: !!el.properties?.enableLiveStream } },
        after: (res) => ({ enableLiveStream: created(res, 'element').properties?.enableLiveStream ?? null }),
        current: { enableLiveStream: el.properties?.enableLiveStream ?? null },
        orgName,
      }
    },
    label: (a) => (a.enabled ? 'Turn the live stream on' : 'Turn the live stream off'),
    summarize: (res) => fields(created(res, 'element'), ['id', 'name', 'properties']),
  }),
  write({
    name: 'add_instance',
    description: 'Place an element in the scene (an instance), at a position, rotation and scale in metres and degrees.',
    input: z.object({ sceneId: id(), elementId: id(), position: vec.optional(), rotation: vec.optional(), scale: vec.optional(), enabled: z.boolean().optional() }),
    call: (a) => ({ method: 'POST', url: `/api/elements/${a.elementId}/instances`, body: pick(a, INSTANCE_FIELDS) }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      elementIn(scene, a.elementId)
      return {
        undo: (res) => ({ method: 'DELETE', url: `/api/instances/${created(res, 'instance').id}` }),
        after: (res) => fields(created(res, 'instance'), ['id', ...INSTANCE_FIELDS]),
        orgName,
      }
    },
    currentOf: async (after, a, ctx) => createdNow(instancesOf((await sceneState(ctx, a.sceneId)).scene), after),
    label: () => 'Place the element',
    summarize: (res) => fields(created(res, 'instance'), ['id', 'elementId', ...INSTANCE_FIELDS]),
  }),
  write({
    name: 'update_instance',
    description: "Move, turn, resize, show or hide one placement (instance) of an element.",
    input: z.object({ sceneId: id(), instanceId: id(), position: vec.optional(), rotation: vec.optional(), scale: vec.optional(), enabled: z.boolean().optional() }).refine(atLeastOne(['sceneId', 'instanceId']), 'Give something to change.'),
    call: (a) => ({ method: 'PUT', url: `/api/instances/${a.instanceId}`, body: pick(a, INSTANCE_FIELDS) }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      const inst = instanceIn(scene, a.instanceId)
      const keys = setKeys(a, ['sceneId', 'instanceId'])
      return { undo: { method: 'PUT', url: `/api/instances/${a.instanceId}`, body: previous(inst, keys) }, after: (res) => fields(created(res, 'instance'), keys), current: fields(inst, keys), orgName }
    },
    label: () => 'Update a placement',
    summarize: (res) => fields(created(res, 'instance'), ['id', 'elementId', ...INSTANCE_FIELDS]),
  }),
  write({
    name: 'create_preset_schedule',
    description:
      'Schedule one of a scene\'s presets to go live: once, daily or weekly (weekdays 0 = Sunday), from startDate at startTime in timezone (IANA). durationMinutes then returnToPresetId, or null to stay live until the next switch.',
    input: z.object({ sceneId: id(), ...scheduleFields }),
    call: (a) => ({ method: 'POST', url: `/api/scenes/${a.sceneId}/preset-schedules`, body: pick(a, SCHEDULE_FIELDS) }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      presetIn(scene, a.presetId)
      return {
        undo: (res) => ({ method: 'DELETE', url: `/api/preset-schedules/${created(res, 'schedule').id}` }),
        after: (res) => fields(created(res, 'schedule'), ['id', ...SCHEDULE_FIELDS]),
        orgName,
      }
    },
    currentOf: async (after, a, ctx) => createdNow(list((await get(ctx, `/api/scenes/${a.sceneId}/preset-schedules`)).schedules), after),
    label: (a) => `Schedule a preset (${a.recurrence}, from ${a.startDate} at ${a.startTime} ${a.timezone})`,
    summarize: (res) => fields(created(res, 'schedule'), ['id', ...SCHEDULE_FIELDS, 'nextRuns']),
  }),
  write({
    name: 'update_preset_schedule',
    description: "Change a scene's preset schedule: only the fields given change. enabled false pauses it.",
    input: z
      .object({ sceneId: id(), scheduleId: id(), ...Object.fromEntries(Object.entries(scheduleFields).map(([k, v]) => [k, v.optional()])) })
      .refine(atLeastOne(['sceneId', 'scheduleId']), 'Give something to change.'),
    call: (a) => ({ method: 'PATCH', url: `/api/preset-schedules/${a.scheduleId}`, body: pick(a, setKeys(a, ['sceneId', 'scheduleId'])) }),
    before: async (a, ctx) => {
      const { orgName } = await sceneState(ctx, a.sceneId)
      const schedule = list((await get(ctx, `/api/scenes/${a.sceneId}/preset-schedules`)).schedules).find((s) => s.id === a.scheduleId)
      if (!schedule) throw new ToolError(404, "That schedule isn't in this scene.")
      const keys = setKeys(a, ['sceneId', 'scheduleId'])
      return { undo: { method: 'PATCH', url: `/api/preset-schedules/${a.scheduleId}`, body: previous(schedule, keys) }, after: (res) => fields(created(res, 'schedule'), keys), current: fields(schedule, keys), orgName }
    },
    label: (a: Obj) => (a.enabled === false && setKeys(a, ['sceneId', 'scheduleId']).length === 1 ? 'Pause a preset schedule' : 'Change a preset schedule'),
    summarize: (res) => fields(created(res, 'schedule'), ['id', ...SCHEDULE_FIELDS, 'nextRuns']),
  }),
  write({
    name: 'add_to_library',
    description: "Add one of the user's own files to a scene's library: an image or video (mediaAssetId, from list_media) or a 3D model (assetItemId).",
    input: z.object({ sceneId: id(), mediaAssetId: id().optional(), assetItemId: id().optional() }).refine((a) => !!a.mediaAssetId !== !!a.assetItemId, 'Give exactly one of mediaAssetId or assetItemId.'),
    call: (a) => ({ method: 'POST', url: `/api/scenes/${a.sceneId}/library`, body: pick(a, ['mediaAssetId', 'assetItemId']) }),
    before: async (a, ctx) => {
      const { orgName } = await sceneState(ctx, a.sceneId)
      const had = new Set(list((await get(ctx, `/api/scenes/${a.sceneId}/library`)).items).map((i) => i.id))
      const linkId = (res: unknown) => ((res ?? {}) as Obj).id as string
      // A file already in the library comes back with its existing link: nothing to undo then
      return {
        undo: (res) => (had.has(linkId(res)) ? null : { method: 'DELETE', url: `/api/scenes/${a.sceneId}/library/${linkId(res)}` }),
        after: (res) => ({ id: linkId(res) }),
        orgName,
      }
    },
    currentOf: async (after, a, ctx) => createdNow(list((await get(ctx, `/api/scenes/${a.sceneId}/library`)).items), after),
    label: () => "Add a file to the scene's library",
    summarize: (res) => res,
  }),
  write({
    name: 'rename_library_item',
    description: "Rename a file in a scene's library (its extension is kept).",
    input: z.object({ sceneId: id(), itemId: id(), name: name(120) }),
    call: (a) => ({ method: 'PATCH', url: `/api/scenes/${a.sceneId}/library/${a.itemId}`, body: { name: a.name } }),
    before: async (a, ctx) => {
      const { orgName } = await sceneState(ctx, a.sceneId)
      const item = list((await get(ctx, `/api/scenes/${a.sceneId}/library`)).items).find((i) => i.id === a.itemId)
      if (!item) throw new ToolError(404, "That file isn't in this scene's library.")
      return { undo: { method: 'PATCH', url: `/api/scenes/${a.sceneId}/library/${a.itemId}`, body: { name: item.name } }, after: (res) => fields(created(res, 'item'), ['name']), current: fields(item, ['name']), orgName }
    },
    label: (a) => `Rename file to "${a.name}"`,
    summarize: (res) => fields(created(res, 'item'), ['id', 'kind', 'name', 'url']),
  }),
  write({
    name: 'create_showing',
    description:
      'Schedule a showing on a video screen: a programme of videos (items; a duration in seconds is needed for videos not uploaded to Images & Video) that plays once, daily or weekly from startDate at startTime in timezone.',
    input: z.object({
      sceneId: id(),
      elementId: id(),
      title: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
      items: z.array(z.object({ url: z.url({ protocol: /^https?$/ }), kind: z.enum(['video', 'ad']).optional(), duration: z.number().positive().optional() })).min(1),
      recurrence,
      startDate: date,
      startTime: time,
      weekdays: weekdays.optional(),
      timezone: z.string().min(1),
      enabled: z.boolean().optional(),
      eventId: id().optional(),
    }),
    call: (a) => ({ method: 'POST', url: `/api/elements/${a.elementId}/showings`, body: pick(a, SHOWING_FIELDS) }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      elementIn(scene, a.elementId)
      return {
        undo: (res) => ({ method: 'DELETE', url: `/api/showings/${created(res, 'showing').id}` }),
        after: (res) => fields(created(res, 'showing'), SHOWING_FIELDS),
        orgName,
      }
    },
    currentOf: async (after, a, ctx) => createdNow(list((await get(ctx, `/api/elements/${a.elementId}/showings`)).showings), after),
    label: (a) => `Schedule showing "${a.title ?? 'Untitled'}"`,
    summarize: (res) => fields(created(res, 'showing'), [...SHOWING_FIELDS, 'lengthSeconds', 'nextStarts']),
  }),
]
