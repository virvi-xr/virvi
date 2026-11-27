import { eq } from 'drizzle-orm'
import { dclBudget, DCL_MAX_FILE_BYTES } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { dclWorldDestinations } from '../db/schema.js'
import { frameEntitiesInScene, modelsInScene, type ModelNeed } from '../services/dcl/assemble.js'
import { PARCEL_MAX_BYTES_PER_PARCEL } from '../services/dcl/world-deployer.js'

/**
 * A scene's performance budget (LIV-41): its triangles, entities and file size against Decentraland's limits for each
 * place it deploys to, with the biggest contributors and what to do about them. The numbers are the same ones the deploy
 * check uses (sceneLimitProblem, sceneTriangleWarning, the parcel size limit), so the page and a deploy agree.
 */

export type BudgetState = 'within' | 'close' | 'over'
/** From this share of a limit on, a metric is close to it. */
export const CLOSE_AT = 0.8

export interface BudgetMetric {
  key: 'triangles' | 'entities' | 'bytes'
  used: number
  /** null: no fixed limit here (a World's storage is per wallet, checked when deploying) */
  limit: number | null
  state: BudgetState
  /** Over this limit, a deploy is refused (entities, parcel size); triangles only warn */
  blocks: boolean
}

export interface BudgetContributor { elementId: string; name: string; copies: number; triangles: number | null; bytes: number | null }
export interface BudgetTarget { id: string | null; name: string; kind: 'world' | 'parcels' | 'none'; parcels: number; state: BudgetState; metrics: BudgetMetric[] }
export interface SceneHealth {
  state: BudgetState
  targets: BudgetTarget[]
  byTriangles: BudgetContributor[]
  bySize: BudgetContributor[]
  /** Models with no triangle count or size yet, counted as 0 */
  unmeasured: number
  frames: number
  suggestions: string[]
}

const stateOf = (used: number, limit: number | null): BudgetState =>
  limit === null ? 'within' : used > limit ? 'over' : used >= limit * CLOSE_AT ? 'close' : 'within'
const worst = (states: BudgetState[]): BudgetState => (states.includes('over') ? 'over' : states.includes('close') ? 'close' : 'within')

/** The budget of one place: `parcels` parcels, a World or Genesis City parcels. */
export function budgetFor(models: ModelNeed[], frames: number, target: { kind: BudgetTarget['kind']; parcels: number }): { state: BudgetState; metrics: BudgetMetric[] } {
  const budget = dclBudget(Math.max(1, target.parcels))
  const triangles = models.reduce((n, m) => n + (m.triangles ?? 0) * m.instances, 0)
  const entities = models.reduce((n, m) => n + m.instances, 0) + frames
  const bytes = models.reduce((n, m) => n + (m.bytes ?? 0), 0)
  const sizeLimit = target.kind === 'world' ? null : PARCEL_MAX_BYTES_PER_PARCEL * Math.max(1, target.parcels)
  const metrics: BudgetMetric[] = [
    { key: 'triangles', used: triangles, limit: budget.triangles, state: stateOf(triangles, budget.triangles), blocks: false },
    { key: 'entities', used: entities, limit: budget.entities, state: stateOf(entities, budget.entities), blocks: true },
    { key: 'bytes', used: bytes, limit: sizeLimit, state: stateOf(bytes, sizeLimit), blocks: sizeLimit !== null },
  ]
  return { state: worst(metrics.map((m) => m.state)), metrics }
}

const TOP = 5
const MB = 1024 * 1024

/** What to do about it, in plain words: only for the metrics that are close or over. */
export function suggestionsFor(targets: BudgetTarget[], models: ModelNeed[], frames: number): string[] {
  const out: string[] = []
  const hot = (key: BudgetMetric['key']) => targets.some((t) => t.metrics.some((m) => m.key === key && m.state !== 'within'))
  if (hot('triangles')) {
    const heavy = [...models].filter((m) => m.triangles).sort((a, b) => b.triangles! * b.instances - a.triangles! * a.instances)[0]
    out.push(heavy
      ? `Use a lower-detail version of "${heavy.name}" (${heavy.triangles!.toLocaleString('en-US')} triangles${heavy.instances > 1 ? ` × ${heavy.instances} copies` : ''}), or place fewer copies of it.`
      : 'Use lower-detail models, or place fewer copies of the heaviest ones.')
  }
  if (hot('entities')) {
    out.push(frames > 0
      ? 'Remove copies you don\'t need, or turn off frames on images and screens (each framed copy adds 4 to 8 entities).'
      : 'Remove copies you don\'t need: every placed copy is an entity.')
  }
  if (hot('bytes')) {
    const big = [...models].filter((m) => m.bytes).sort((a, b) => b.bytes! - a.bytes!)[0]
    out.push(big
      ? `Make "${big.name}" smaller (${(big.bytes! / MB).toFixed(1)} MB): most of a model's size is usually its textures, so resize them to 1024 px or less and compress them.`
      : 'Make your largest models smaller: resize and compress their textures.')
  }
  const tooBig = models.find((m) => (m.bytes ?? 0) > DCL_MAX_FILE_BYTES)
  if (tooBig) out.push(`"${tooBig.name}" is over Decentraland's ${DCL_MAX_FILE_BYTES / MB} MB limit for one file, so it can't deploy until it's smaller.`)
  return out
}

const contributor = (m: ModelNeed): BudgetContributor => ({ elementId: m.elementId, name: m.name, copies: m.instances, triangles: m.triangles, bytes: m.bytes })

export async function sceneHealth(sceneId: string): Promise<SceneHealth> {
  const [all, frames, dests] = await Promise.all([
    modelsInScene(sceneId),
    frameEntitiesInScene(sceneId),
    db.query.dclWorldDestinations.findMany({ where: eq(dclWorldDestinations.sceneId, sceneId), columns: { id: true, kind: true, worldName: true, base: true, parcels: true } }),
  ])
  const targets: BudgetTarget[] = dests.length
    ? dests.map((d) => ({ id: d.id, name: d.worldName ?? `Parcels at ${d.base}`, kind: d.kind, parcels: d.parcels.length, ...budgetFor(all, frames, { kind: d.kind, parcels: d.parcels.length }) }))
    : [{ id: null, name: 'One parcel', kind: 'none', parcels: 1, ...budgetFor(all, frames, { kind: 'none', parcels: 1 }) }]
  const models = all.filter((m) => m.kind !== 'thumbnail')
  return {
    state: worst(targets.map((t) => t.state)),
    targets,
    byTriangles: models.filter((m) => m.triangles).sort((a, b) => b.triangles! * b.instances - a.triangles! * a.instances).slice(0, TOP).map(contributor),
    bySize: all.filter((m) => m.bytes).sort((a, b) => b.bytes! - a.bytes!).slice(0, TOP).map(contributor),
    unmeasured: models.filter((m) => m.triangles == null || m.bytes == null).length,
    frames,
    suggestions: suggestionsFor(targets, all, frames),
  }
}
