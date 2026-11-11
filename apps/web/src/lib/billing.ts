import { formatBytes } from './format'

/** Settings → Billing & Usage: the plans as the server has them (GET /api/billing/plans), in the page's words. */

export type PlanTier = 'free' | 'creator' | 'pro' | 'studio' | 'enterprise'
/** A plan's limits; unlimited is null. */
export type PlanLimits = {
  scenes: number | null; storageBytes: number | null; deploymentsPerMonth: number | null; customAssetUploads: number | null
  hyperfyInstances: number | null; streamMinutes: number | null; apiKeys: number | null; analyticsRetentionDays: number | null
  analyticsHeatmap3d: boolean; giveawayCredits: number | null; recording: boolean; crossWorldBroadcast: boolean; customDomain: boolean
  studioPromptsPerDay: number | null; studioOpenDesigns: number | null
}
export type Plan = { tier: PlanTier; limits: PlanLimits; price: { amountCents: number; currency: string; interval: string | null } | null; available: boolean }

export const TIER_ORDER: PlanTier[] = ['free', 'creator', 'pro', 'studio', 'enterprise']
export const tierName = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/** "$19 / month", "$190 / year", "€9"; null without a price. */
export function priceLabel(price: Plan['price']): string | null {
  if (!price) return null
  const amount = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: price.currency.toUpperCase(), minimumFractionDigits: price.amountCents % 100 ? 2 : 0,
  }).format(price.amountCents / 100)
  return price.interval ? `${amount} / ${price.interval}` : amount
}

const count = (n: number | null, one: string, many = `${one}s`) => n === null ? `Unlimited ${many}` : `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/**
 * What a plan gives, line by line, from its limits. Scenes are left out: every plan has unlimited scenes, so they
 * aren't what anyone pays for. Lines that are "none" are left out too (a free plan doesn't list 0 deployments).
 */
export function planFeatures(l: PlanLimits): string[] {
  const out: string[] = []
  out.push(`${l.storageBytes === null ? 'Unlimited' : formatBytes(l.storageBytes)} storage`)
  if (l.deploymentsPerMonth !== 0) out.push(l.deploymentsPerMonth === null ? 'Unlimited deployments' : `${count(l.deploymentsPerMonth, 'deployment')} a month`)
  if (l.customAssetUploads !== 0) out.push(count(l.customAssetUploads, '3D model upload'))
  if (l.hyperfyInstances !== 0) out.push(count(l.hyperfyInstances, 'hosted Hyperfy world'))
  if (l.streamMinutes !== 0) out.push(l.streamMinutes === null ? 'Unlimited streaming' : `${count(l.streamMinutes, 'streaming minute')} a month`)
  if (l.apiKeys !== 0) out.push(count(l.apiKeys, 'API key'))
  out.push(l.analyticsRetentionDays === null ? 'Analytics kept forever' : `Analytics kept ${l.analyticsRetentionDays} days`)
  if (l.analyticsHeatmap3d) out.push('3D analytics heatmap')
  if (l.recording) out.push('Stream recording')
  if (l.crossWorldBroadcast) out.push('Cross-world broadcast')
  if (l.customDomain) out.push('Custom domain')
  out.push(l.studioPromptsPerDay === null ? 'Unlimited Design Studio prompts' : `${count(l.studioPromptsPerDay, 'Design Studio prompt')} a day`)
  return out
}

/** The plans above the reader's own: what they could move up to. */
export function upgradesFrom(current: string, plans: Plan[]): Plan[] {
  const at = TIER_ORDER.indexOf(current as PlanTier)
  return plans.filter((p) => TIER_ORDER.indexOf(p.tier) > Math.max(at, 0))
}

/** The line after coming back from Stripe Checkout (?billing=success | canceled). */
export function checkoutReturnNote(param: string | null): string | null {
  if (param === 'success') return 'Thanks! Your plan is being updated; it can take a minute to show here.'
  if (param === 'canceled') return 'Checkout was canceled. Nothing was charged.'
  return null
}
