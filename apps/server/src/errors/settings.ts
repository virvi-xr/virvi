import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { errorSettings } from '../db/schema.js'
import { config } from '../config.js'

/** The filing thresholds: config.errorThresholds, with what admins changed on the Errors page on top. */
export type Thresholds = { -readonly [K in keyof typeof config.errorThresholds]: (typeof config.errorThresholds)[K] extends boolean ? boolean : number }

type Rule = { min: number; max: number; int: boolean }
const RULES: Record<Exclude<keyof Thresholds, 'filing'>, Rule> = {
  newMinUsers: { min: 1, max: 10_000, int: true },
  severeMinUsers: { min: 1, max: 10_000, int: true },
  severeMinCount: { min: 1, max: 1_000_000, int: true },
  spikeFactor: { min: 1.5, max: 100, int: false },
  spikeMinBaseline: { min: 0, max: 10_000, int: false },
  spikeMinCount: { min: 1, max: 1_000_000, int: true },
  spikeHistoryWeeks: { min: 1, max: 8, int: true },
  quietDays: { min: 1, max: 90, int: true },
  maxIssuesPerPass: { min: 1, max: 50, int: true },
  maxIssuesPerDay: { min: 1, max: 500, int: true },
}

export function checkThresholds(input: unknown): { ok: true; value: Partial<Thresholds> } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'thresholds must be an object' }
  const out: Partial<Thresholds> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === 'filing') {
      if (typeof v !== 'boolean') return { ok: false, error: 'filing must be true or false' }
      out.filing = v
      continue
    }
    const rule = RULES[k as keyof typeof RULES]
    if (!rule) return { ok: false, error: `unknown threshold: ${k}` }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < rule.min || v > rule.max || (rule.int && !Number.isInteger(v))) {
      return { ok: false, error: `${k} must be ${rule.int ? 'a whole number' : 'a number'} from ${rule.min} to ${rule.max}` }
    }
    ;(out as Record<string, number>)[k] = v
  }
  return { ok: true, value: out }
}

export async function getThresholds(): Promise<Thresholds> {
  const [row] = await db.select().from(errorSettings).where(eq(errorSettings.id, 'default'))
  const saved = checkThresholds(row?.thresholds ?? {})
  return { ...config.errorThresholds, ...(saved.ok ? saved.value : {}) }
}

export async function saveThresholds(change: Partial<Thresholds>, by: string): Promise<Thresholds> {
  const current = await getThresholds()
  const next = { ...current, ...change }
  // Only what differs from config is stored, so a later config change still reaches untouched keys
  const stored = Object.fromEntries(Object.entries(next).filter(([k, v]) => (config.errorThresholds as Record<string, unknown>)[k] !== v))
  await db.insert(errorSettings).values({ id: 'default', thresholds: stored, updatedBy: by, updatedAt: new Date() })
    .onConflictDoUpdate({ target: errorSettings.id, set: { thresholds: stored, updatedBy: by, updatedAt: new Date() } })
  return next
}
