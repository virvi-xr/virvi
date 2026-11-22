// Deploy tools (phase 2c): what happened to a deploy and why, from the deploy routes' own words.
import { z } from 'zod'
import { id, pick } from './read.js'
import { inject } from './http.js'
import { ToolError, type Call, type ToolDef } from './types.js'

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
]
