// Deploy tools (phase 2c): what happened to a deploy and why, from the deploy routes' own words.
import { z } from 'zod'
import { id, pick } from './read.js'
import { inject, routeError } from './http.js'
import { get, sceneState } from './write.js'
import { ToolError, type Before, type Call, type ToolCtx, type ToolDef } from './types.js'

type Obj = Record<string, any>
const list = <T = Obj>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/** A destination as people name it: the World, or the Genesis City parcels. */
export function destinationName(d: { kind: string; worldName: string | null; base: string; parcels: string[] }): string {
  if (d.kind === 'world' && d.worldName) return `World "${d.worldName}"`
  const n = d.parcels.length
  return `Genesis City parcels at ${d.base} (${n} ${n === 1 ? 'parcel' : 'parcels'})`
}

const RUNNING = ['pending', 'building', 'built', 'deploying']

/** The next thing to try for a deploy, in plain words: deployment status first, then the destination, then the message. */
export function nextStep(d: { status: string; errorMessage: string | null }, dest: { status: string; statusDetail: string | null } | null): string {
  if (d.status === 'deployed') return "It's live. Nothing to do."
  if (d.status === 'awaiting_signature') return 'It is waiting for your signature on its deploy page.'
  if (RUNNING.includes(d.status)) return 'It is still running. Check again in a minute.'
  if (dest?.status === 'over_budget') return `The scene is over the size limit: ${dest.statusDetail ?? 'it has too much in it'}. Remove or shrink models, then redeploy.`
  if (dest?.status === 'needs_review') return `${dest.statusDetail ?? 'Something in the scene needs a look'}. Check the models on the deploy page, then redeploy.`
  if (dest?.status === 'unreachable') return "Decentraland couldn't be reached. Redeploy in a few minutes."
  const m = d.errorMessage ?? ''
  if (m.startsWith('Cancelled')) return 'It was cancelled. Redeploy when you are ready.'
  if (m.startsWith("Couldn't reach")) return "Decentraland couldn't be reached. Redeploy in a few minutes."
  if (m.startsWith('Decentraland rejected')) return 'Decentraland refused it. Open the deploy page to check the destination, then redeploy.'
  return 'Redeploy in a few minutes. If it fails again, ask for help with the Help button.'
}

const destOf = (d: Obj | null | undefined) => (d ? { name: destinationName({ kind: d.kind, worldName: d.worldName ?? null, base: d.base, parcels: list<string>(d.parcels) }), status: d.status, statusDetail: d.statusDetail ?? null } : null)

function explain(dep: Obj, dest: Obj | null) {
  const status = destOf(dest)
  return {
    ...pick(dep, ['id', 'status', 'platform', 'errorMessage', 'createdAt', 'deployedAt']),
    destination: status ? status.name : null,
    next: nextStep({ status: dep.status, errorMessage: dep.errorMessage ?? null }, status),
  }
}

const NOT_THIS_SCENES = "That destination isn't one of this scene's."
const ALL_SIGN = 'Each of these destinations needs your signature: open their deploy pages to redeploy.'
const REDEPLOY_REFUSALS: Record<string, string> = {
  not_world_owner: "Only the World's owner can deploy it.",
  not_parcel_controller: 'None of your wallets can deploy to these parcels.',
  world_unreachable: "Decentraland couldn't be reached. Try again in a few minutes.",
  catalyst_unreachable: "Decentraland couldn't be reached. Try again in a few minutes.",
  not_found: "That destination wasn't found.",
}

const nameOfDest = (d: Obj) => destinationName({ kind: d.kind, worldName: d.worldName ?? null, base: d.base, parcels: list<string>(d.parcels) })

const sceneDestinations = async (ctx: ToolCtx, sceneId: string) => list<Obj>((await get(ctx, `/api/scenes/${sceneId}/dcl/destinations`)).destinations)

/** The scene's destinations the card named, in the card's order; a destination that isn't the scene's is refused. */
async function namedDestinations(ctx: ToolCtx, sceneId: string, ids: string[]): Promise<Obj[]> {
  const all = await sceneDestinations(ctx, sceneId)
  return ids.map((destId) => {
    const d = all.find((x) => x.id === destId)
    if (!d) throw new ToolError(400, NOT_THIS_SCENES)
    return d
  })
}

type Named = { destinationId: string; name: string }
/**
 * What `call` found at press time, for `summarize`: who was deployed, who is left to sign, who is gone. Keyed by the
 * args object: runTool passes the same parsed args object to `call` and `summarize`.
 */
const pressed = new WeakMap<object, { posted: Named[]; toSign: Named[]; missing: string[] }>()

/** Who deployed, who was refused (in the route's words) and who is left to sign: what `call` found, with the responses. */
function outcome(res: Array<{ status: number; json: unknown }>, a: object) {
  const seen = pressed.get(a)
  if (!seen) throw new Error('redeploy_scene: summarize ran without call')
  const { posted, toSign, missing } = seen
  const deployed: Obj[] = []
  const failed: Obj[] = []
  for (const [i, r] of res.entries()) {
    const p = posted[i]
    if (r.status < 400) deployed.push({ ...p, deploymentId: (r.json as Obj | null)?.deployment?.id ?? null })
    else failed.push({ ...p, error: routeError(r.status, r.json, REDEPLOY_REFUSALS) })
  }
  for (const destinationId of missing) failed.push({ destinationId, name: null, error: REDEPLOY_REFUSALS.not_found })
  return { deployed, failed, toSign }
}

/** Virvi deploys it at the press: in Virvi mode, and named by the card as Virvi's (an older card names none). */
const deploysNow = (d: Obj, a: { deployIds?: string[] }) => d.mode === 'virvi' && (!a.deployIds || a.deployIds.includes(d.id))

const MESSAGE_NOTE = "errorMessage is Decentraland's or Virvi's own words: explain it plainly in your own words, and tell the user `next`."

export const DEPLOY_TOOLS: ToolDef<any>[] = [
  {
    name: 'get_deploy_status',
    effect: 'read',
    description: `One deploy: its status, where it went (World or parcels), any error message, and the next step. ${MESSAGE_NOTE}`,
    input: z.object({ deploymentId: id() }),
    call: async (a, ctx): Promise<Call[]> => {
      const first: Call = { method: 'GET', url: `/api/deploy/${a.deploymentId}` }
      const res = await inject(ctx, first)
      const destinationId = (res.json as Obj | null)?.deployment?.destinationId
      // A refusal is left to the runner, which reports the route's own words
      return res.status < 400 && typeof destinationId === 'string' ? [first, { method: 'GET', url: `/api/dcl/destinations/${destinationId}` }] : [first]
    },
    label: () => 'Check the deploy',
    summarize: (res) => {
      const [dep, dest] = res as [Obj, Obj | undefined]
      return explain(dep?.deployment ?? {}, dest?.destination ?? null)
    },
  },
  {
    name: 'explain_deploy_failure',
    effect: 'read',
    description: `Why a scene's deploy failed: the newest failed one, or the one named by deploymentId, with its destination and the next step. ${MESSAGE_NOTE}`,
    input: z.object({ sceneId: id(), deploymentId: id().optional() }),
    call: (a) => [{ method: 'GET', url: `/api/deploy/scene/${a.sceneId}` }, { method: 'GET', url: `/api/scenes/${a.sceneId}/dcl/destinations` }],
    label: () => 'Find out why the deploy failed',
    summarize: (res, a) => {
      const [deploys, dests] = res as [Obj, Obj]
      const all = list<Obj>(deploys?.deployments)
      const dep = a.deploymentId ? all.find((d) => d.id === a.deploymentId) : all.find((d) => d.status === 'failed')
      if (a.deploymentId && !dep) throw new ToolError(404, "That deploy isn't one of this scene's recent deploys.")
      if (!dep) return { failed: null, message: 'No deploy of this scene has failed recently.' }
      const dest = list<Obj>(dests?.destinations).find((d) => d.id === dep.destinationId) ?? null
      const newerDeployed = all.slice(0, all.indexOf(dep)).some((d) => d.status === 'deployed')
      return { ...explain(dep, dest), ...(newerDeployed ? { newerDeployed: true } : {}) }
    },
  },
  {
    name: 'redeploy_scene',
    effect: 'public',
    keepGoing: true,
    description:
      "Redeploy a scene to some of its destinations (destinationIds, from get_scene_publishing) so visitors see the current version. One card names each destination and how it deploys: Virvi deploys a destination in Virvi mode itself; one that needs the user's signature is left to its deploy page. Say which destinations you mean.",
    input: z.object({
      sceneId: id(),
      destinationIds: z.array(id()).min(1).max(10).refine((a) => new Set(a).size === a.length, 'destinationIds must be different'),
      // Set by the card, never by the model: the destinations the card said Virvi deploys
      deployIds: z.array(id()).min(1).max(10).optional().describe('Leave this out: the card fills it in.'),
    }),
    refusals: REDEPLOY_REFUSALS,
    before: async (a, ctx): Promise<Before> => {
      const { orgName } = await sceneState(ctx, a.sceneId)
      // Lenient about a destination removed since the card (the runner calls this at press time too): `preview` is the
      // strict check at card time, and `call` reports the missing one. Only when none is found is it refused here.
      const all = await sceneDestinations(ctx, a.sceneId)
      const named = a.destinationIds.map((i: string) => all.find((x) => x.id === i)).filter((d: Obj | undefined): d is Obj => !!d)
      if (!named.length) throw new ToolError(400, NOT_THIS_SCENES)
      if (!named.some((d) => deploysNow(d, a))) throw new ToolError(400, ALL_SIGN)
      return { undo: null, after: () => null, orgName }
    },
    preview: async (a, ctx) => {
      const { scene } = await sceneState(ctx, a.sceneId)
      const named = await namedDestinations(ctx, a.sceneId, a.destinationIds)
      const lines = named.map((d) => `- ${nameOfDest(d)}: ${d.mode === 'virvi' ? 'Virvi deploys it now' : 'you sign it on its deploy page'}`)
      const deployIds = named.filter((d) => d.mode === 'virvi').map((d) => d.id as string)
      return { detail: [`Redeploy "${scene.name}":`, ...lines].join('\n'), bind: { deployIds } }
    },
    // Read again at press time: only a destination the card said Virvi deploys, and still in Virvi mode, is deployed.
    // One switched either way since the card is left to its deploy page.
    call: async (a, ctx) => {
      // Lenient: a destination removed since the card is reported, and the rest still deploy
      const all = await sceneDestinations(ctx, a.sceneId)
      const named = a.destinationIds.map((i: string) => all.find((x) => x.id === i)).filter((d: Obj | undefined): d is Obj => !!d)
      const missing = a.destinationIds.filter((i: string) => !all.some((x) => x.id === i))
      const posted = named.filter((d) => deploysNow(d, a)).map((d) => ({ destinationId: d.id as string, name: nameOfDest(d) }))
      const toSign = named.filter((d) => !deploysNow(d, a)).map((d) => ({ destinationId: d.id as string, name: nameOfDest(d) }))
      pressed.set(a, { posted, toSign, missing })
      return posted.map((p) => ({ method: 'POST' as const, url: `/api/dcl/destinations/${p.destinationId}/deploy`, body: {} }))
    },
    label: (a) => `Redeploy the scene to ${a.destinationIds.length} ${a.destinationIds.length === 1 ? 'destination' : 'destinations'}`,
    // Every deploy refused: each destination with its own refusal, and what's left to sign
    failure: (res, a) => {
      const { failed, toSign } = outcome(res, a)
      const lines = failed.map((f) => (f.name ? `${f.name}: ${f.error}` : f.error))
      if (toSign.length) lines.push(`Still to sign on their deploy pages: ${toSign.map((t) => t.name).join(', ')}.`)
      return lines.join('\n')
    },
    summarize: (res, a) => outcome(res as Array<{ status: number; json: unknown }>, a),
  },
]
