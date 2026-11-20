import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { AssistantAccess } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assistantUsage } from '../db/schema.js'
import { config } from '../config.js'
import { getSubscription, planPrices, PAID_TIERS, type PaidTier } from '../integrations/stripe.js'
import { isVirviAdmin } from '../auth/admin.js'
import { utcDay } from '../studio/quota.js'
import type { AuthUser } from '../middleware/auth.js'
import type { CallUsage } from './pricing.js'

/** The share of what a plan costs that the assistant may spend per month. */
export const BUDGET_SHARE = 0.7
const WARN_AT = 0.8

export type AssistantWindow = { start: Date; end: Date }
export type AssistantAccessResult = AssistantAccess & { budgetUsd?: number; spentUsd?: number; window?: AssistantWindow }

/** periodStart moved forward by n months, keeping its day of month (clamped to the month's last day) and time of day. */
function addMonthsClamped(base: Date, n: number): Date {
  const first = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + n, 1)
  const target = new Date(first)
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  return new Date(Date.UTC(
    target.getUTCFullYear(), target.getUTCMonth(), Math.min(base.getUTCDate(), lastDay),
    base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds(),
  ))
}

/**
 * The span a budget covers. Monthly plans: the billing period. Annual plans pay once a year but the budget is a twelfth
 * of it per month: the month slice of the year (anchored on the period start's day) that contains `now`. A `now`
 * outside the period gets the nearest slice inside it.
 */
export function budgetWindow(periodStart: Date, periodEnd: Date, interval: 'month' | 'year', now: Date): AssistantWindow {
  if (interval === 'month') return { start: periodStart, end: periodEnd }
  let last = 0
  while (last < 120 && addMonthsClamped(periodStart, last + 1) < periodEnd) last++
  let k = 0
  while (k < last && addMonthsClamped(periodStart, k + 1) <= now) k++
  const end = addMonthsClamped(periodStart, k + 1)
  return { start: addMonthsClamped(periodStart, k), end: end > periodEnd ? periodEnd : end }
}

/** 70% of what the plan costs per month; an annual price is spread over 12 months. */
export function monthlyBudgetUsd(amountCents: number, interval: 'month' | 'year'): number {
  const perMonth = interval === 'year' ? amountCents / 12 : amountCents
  return BUDGET_SHARE * perMonth / 100
}

function utcMonth(now: Date): AssistantWindow {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  }
}

/** What the user has spent over the window's UTC days (the end day belongs to the next window). */
async function spentIn(userId: string, window: AssistantWindow): Promise<number> {
  const [row] = await db.select({ total: sql<number>`coalesce(sum(${assistantUsage.costUsd}), 0)` }).from(assistantUsage)
    .where(and(eq(assistantUsage.userId, userId), gte(assistantUsage.day, utcDay(window.start)), lt(assistantUsage.day, utcDay(window.end))))
  return Number(row?.total ?? 0)
}

async function capped(userId: string, budgetUsd: number, window: AssistantWindow): Promise<AssistantAccessResult> {
  const spentUsd = await spentIn(userId, window)
  return {
    state: 'ok',
    budget: {
      percentLeft: Math.max(0, Math.floor(100 * (1 - spentUsd / budgetUsd))),
      warn: spentUsd >= WARN_AT * budgetUsd,
      resetsAt: window.end.toISOString(),
    },
    budgetUsd, spentUsd, window,
  }
}

export async function assistantAccess(user: AuthUser, now: Date = new Date()): Promise<AssistantAccessResult> {
  if (!config.assistantEnabled) return { state: 'hidden' }
  if (user.kind === 'trial' || user.trial) return { state: 'locked', reason: 'trial' }
  if (await isVirviAdmin(user.id)) return capped(user.id, config.assistantAdminBudgetUsd, utcMonth(now))
  if (config.assistantAudience === 'admins') return { state: 'hidden' }
  if (!config.billingEnabled) return { state: 'ok', budget: { percentLeft: 100, warn: false, resetsAt: null } }

  const locked: AssistantAccessResult = { state: 'locked', reason: 'plan' }
  const sub = await getSubscription(user.id)
  if (sub.tier === 'free' || sub.status !== 'active') return locked
  if (!(PAID_TIERS as readonly string[]).includes(sub.tier)) return locked
  const price = (await planPrices())[sub.tier as PaidTier]
  if (!price || !(price.amountCents > 0) || (price.interval !== 'month' && price.interval !== 'year')) return locked

  const start = 'currentPeriodStart' in sub ? sub.currentPeriodStart : null
  const end = 'currentPeriodEnd' in sub ? sub.currentPeriodEnd : null
  // A paid row without period dates is a data gap, not a reason to lock someone out: budget the UTC calendar month
  const window = start && end ? budgetWindow(start, end, price.interval, now) : utcMonth(now)
  return capped(user.id, monthlyBudgetUsd(price.amountCents, price.interval), window)
}

/** True when there is no cap, or the estimate still fits in what is left. */
export function affordable(access: AssistantAccessResult, estimateUsd: number): boolean {
  if (access.state !== 'ok') return false
  if (access.budgetUsd === undefined) return true
  return (access.spentUsd ?? 0) + estimateUsd <= access.budgetUsd
}

/** Adds one model call to the user's UTC-day row. `newMessage` is true for the first call of a user message. */
export async function recordAssistantUsage(userId: string, now: Date, usage: CallUsage, costUsd: number, newMessage: boolean): Promise<void> {
  const tokensIn = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  const messages = newMessage ? 1 : 0
  await db.insert(assistantUsage).values({ userId, day: utcDay(now), messages, tokensIn, tokensOut: usage.output_tokens, costUsd })
    .onConflictDoUpdate({
      target: [assistantUsage.userId, assistantUsage.day],
      set: {
        messages: sql`${assistantUsage.messages} + ${messages}`,
        tokensIn: sql`${assistantUsage.tokensIn} + ${tokensIn}`,
        tokensOut: sql`${assistantUsage.tokensOut} + ${usage.output_tokens}`,
        costUsd: sql`${assistantUsage.costUsd} + ${costUsd}`,
      },
    })
}
