import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioPromptCredits, studioUsageDays, studioTrialSpendDays, users } from '../db/schema.js'
import { config } from '../config.js'
import { getSubscription } from '../integrations/stripe.js'

/**
 * The Design Studio's daily prompt allowance and the hidden daily cost ceiling, per user and UTC day. A prompt counts
 * when it is accepted and is given back when its job ends in `error` or is lost. The allowance applies even when
 * config.allFeaturesUnlocked: prompts run on Virvi's paid agent keys. Gifted prompts (from gift codes) come next, never
 * expire, and skip the cost ceiling: the code's prompt count is their cap. Bought prompts (credits) are used after
 * those, never expire, and are still stopped by the cost ceiling; a given-back prompt returns to where it came from.
 */

export type PromptSource = 'allowance' | 'gift' | 'credit'

/** A database handle or an open transaction. */
export type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export const utcDay = (now: Date) => now.toISOString().slice(0, 10)

function nextUtcMidnight(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
}

/** Trials keep their usage on this sentinel day, so their allowance is a total, not per day. */
export const TRIAL_DAY = '1970-01-01'

export async function isTrialUser(userId: string, exec: Exec = db): Promise<boolean> {
  const [u] = await exec.select({ isTrial: users.isTrial }).from(users).where(eq(users.id, userId))
  return !!u?.isTrial
}

/**
 * The day a job's cost and give-back go on. A job counted on TRIAL_DAY whose owner is no longer a trial (converted, or
 * merged into an account, while it ran) books on today's row: the account's usage is per day and its trial row is gone.
 */
export async function jobDay(userId: string, countedDay: string | null, now: Date, exec: Exec = db): Promise<string> {
  if (countedDay === TRIAL_DAY) return (await isTrialUser(userId, exec)) ? TRIAL_DAY : utcDay(now)
  return countedDay ?? utcDay(now)
}

/** The usage day a user's prompts and cost are kept on. */
export async function usageDay(userId: string, now: Date): Promise<string> {
  return (await isTrialUser(userId)) ? TRIAL_DAY : utcDay(now)
}

async function limitsFor(userId: string, exec: Exec = db) {
  if (await isTrialUser(userId, exec)) {
    return { trial: true, plan: 'trial', allowance: config.trialPrompts, ceiling: config.trialCostCeilingUsd }
  }
  const sub = await getSubscription(userId)
  return { trial: false, plan: sub.tier as string, allowance: sub.limits.studioPromptsPerDay, ceiling: sub.limits.studioDailyCostCeilingUsd }
}

async function usage(userId: string, day: string, exec: Exec = db) {
  const [row] = await exec.select().from(studioUsageDays)
    .where(and(eq(studioUsageDays.userId, userId), eq(studioUsageDays.day, day)))
  return { prompts: row?.prompts ?? 0, costUsd: row?.costUsd ?? 0 }
}

async function creditBalance(userId: string, exec: Exec = db): Promise<number> {
  const [row] = await exec.select({ balance: studioPromptCredits.balance }).from(studioPromptCredits)
    .where(eq(studioPromptCredits.userId, userId))
  return row?.balance ?? 0
}

async function giftedBalance(userId: string, exec: Exec = db): Promise<number> {
  const [row] = await exec.select({ gifted: studioPromptCredits.gifted }).from(studioPromptCredits)
    .where(eq(studioPromptCredits.userId, userId))
  return row?.gifted ?? 0
}

export async function promptStatus(userId: string, now: Date) {
  const { trial, plan, allowance, ceiling } = await limitsFor(userId)
  const { prompts, costUsd } = await usage(userId, trial ? TRIAL_DAY : utcDay(now))
  // Gifts and credits never apply to a trial
  const credits = trial ? 0 : await creditBalance(userId)
  const gifted = trial ? 0 : await giftedBalance(userId)
  return {
    plan,
    trial,
    allowance,
    used: prompts,
    credits,
    gifted,
    left: Math.max(0, allowance - prompts) + credits + gifted,
    resetsAt: trial ? null : nextUtcMidnight(now),
    overCostCeiling: costUsd >= ceiling && gifted === 0,
  }
}

/**
 * Takes one prompt from today's allowance (when counted) in a single statement, so concurrent reservations never pass
 * it; once the allowance is spent, one gifted prompt, then one credit, each also in a single statement. Every
 * reservation, counted or not, is refused once today's spend reaches the cost ceiling, unless the user has gifted
 * prompts: past the ceiling an uncounted reservation (otherwise free) also takes one gifted prompt, so gifts cannot
 * fund unlimited runs; the job records `from: 'gift'` and the prompt is given back if the job errors.
 */
export async function reservePrompt(
  userId: string,
  now: Date,
  opts: { counted: boolean },
  exec: Exec = db,
): Promise<{ ok: true; day: string; from: PromptSource | null } | { ok: false; reason: 'allowance' | 'cost_ceiling' | 'trial_busy' }> {
  const { trial, allowance, ceiling } = await limitsFor(userId, exec)
  const day = trial ? TRIAL_DAY : utcDay(now)
  if (trial) {
    // All trials together are capped per UTC day; accounts are never stopped by it
    const [spend] = await exec.select().from(studioTrialSpendDays).where(eq(studioTrialSpendDays.day, utcDay(now)))
    if ((spend?.costUsd ?? 0) >= config.trialDailyBudgetUsd) return { ok: false, reason: 'trial_busy' }
  }
  const inc = opts.counted ? 1 : 0
  const rows = await exec.execute(sql`
    INSERT INTO studio_usage_days (user_id, day, prompts, cost_usd)
    SELECT ${userId}, ${day}, ${inc}, 0 WHERE ${inc} <= ${allowance} AND 0 < ${ceiling}
    ON CONFLICT (user_id, day) DO UPDATE SET prompts = studio_usage_days.prompts + EXCLUDED.prompts
    WHERE studio_usage_days.cost_usd < ${ceiling}
      AND (EXCLUDED.prompts = 0 OR studio_usage_days.prompts < ${allowance})
    RETURNING prompts`)
  if ((rows as unknown as unknown[]).length) return { ok: true, day, from: opts.counted ? 'allowance' : null }
  const { costUsd } = await usage(userId, day, exec)
  if (trial) return { ok: false, reason: costUsd >= ceiling ? 'cost_ceiling' : 'allowance' }
  if (opts.counted || costUsd >= ceiling) {
    const gift = await exec.execute(sql`
      UPDATE studio_prompt_credits SET gifted = gifted - 1, updated_at = now()
      WHERE user_id = ${userId} AND gifted > 0
      RETURNING gifted`)
    if ((gift as unknown as unknown[]).length) return { ok: true, day, from: 'gift' }
  }
  if (costUsd >= ceiling) return { ok: false, reason: 'cost_ceiling' }
  const credit = await exec.execute(sql`
    UPDATE studio_prompt_credits SET balance = balance - 1, updated_at = now()
    WHERE user_id = ${userId} AND balance > 0
    RETURNING balance`)
  if ((credit as unknown as unknown[]).length) return { ok: true, day, from: 'credit' }
  return { ok: false, reason: 'allowance' }
}

/**
 * Gives a counted prompt back: to the day's allowance, to the gifted balance, or as a credit when a credit paid for it.
 * Pass the job's counted day, not `jobDay`: a trial prompt whose owner has since become an account was dropped with
 * the trial's allowance at conversion, so there is nothing to give back (giving it to today would be a free prompt).
 */
export async function refundPrompt(userId: string, day: string, from: PromptSource | null, exec: Exec = db): Promise<void> {
  if (day === TRIAL_DAY && from === 'allowance' && !(await isTrialUser(userId, exec))) return
  if (from === 'credit') {
    await exec.insert(studioPromptCredits).values({ userId, balance: 1 })
      .onConflictDoUpdate({ target: studioPromptCredits.userId, set: { balance: sql`${studioPromptCredits.balance} + 1`, updatedAt: new Date() } })
    return
  }
  if (from === 'gift') {
    await exec.insert(studioPromptCredits).values({ userId, gifted: 1 })
      .onConflictDoUpdate({ target: studioPromptCredits.userId, set: { gifted: sql`${studioPromptCredits.gifted} + 1`, updatedAt: new Date() } })
    return
  }
  await exec.update(studioUsageDays)
    .set({ prompts: sql`GREATEST(${studioUsageDays.prompts} - 1, 0)` })
    .where(and(eq(studioUsageDays.userId, userId), eq(studioUsageDays.day, day)))
}

export async function recordCost(userId: string, day: string, costUsd: number, exec: Exec = db): Promise<void> {
  if (!(costUsd > 0)) return
  if (await isTrialUser(userId, exec)) {
    day = TRIAL_DAY
    await exec.insert(studioTrialSpendDays).values({ day: utcDay(new Date()), costUsd })
      .onConflictDoUpdate({ target: studioTrialSpendDays.day, set: { costUsd: sql`${studioTrialSpendDays.costUsd} + ${costUsd}` } })
  }
  await exec.insert(studioUsageDays).values({ userId, day, prompts: 0, costUsd })
    .onConflictDoUpdate({
      target: [studioUsageDays.userId, studioUsageDays.day],
      set: { costUsd: sql`${studioUsageDays.costUsd} + ${costUsd}` },
    })
}
