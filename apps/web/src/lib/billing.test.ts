import { describe, it, expect } from 'vitest'
import { checkoutReturnNote, planFeatures, priceLabel, upgradesFrom, type Plan, type PlanLimits } from './billing'

const free: PlanLimits = {
  scenes: null, storageBytes: 500 * 1024 * 1024, deploymentsPerMonth: 0, customAssetUploads: 0, hyperfyInstances: 1, streamMinutes: 0,
  apiKeys: 0, analyticsRetentionDays: 7, analyticsHeatmap3d: false, giveawayCredits: 100, recording: false, crossWorldBroadcast: false,
  customDomain: false, studioPromptsPerDay: 3, studioOpenDesigns: 1,
}
const studio: PlanLimits = {
  ...free, storageBytes: 500 * 1024 ** 3, deploymentsPerMonth: null, customAssetUploads: null, hyperfyInstances: 10, streamMinutes: null,
  apiKeys: null, analyticsRetentionDays: 365, analyticsHeatmap3d: true, recording: true, crossWorldBroadcast: true, customDomain: true,
  studioPromptsPerDay: 100, studioOpenDesigns: null,
}

describe('billing plans', () => {
  it('says what a plan gives from its limits, never "unlimited scenes", and skips what it lacks', () => {
    const f = planFeatures(free)
    expect(f).toEqual(['500 MB storage', '1 hosted Hyperfy world', 'Analytics kept 7 days', '3 Design Studio prompts a day'])
    expect(f.join(' ')).not.toMatch(/scene/i)
    const s = planFeatures(studio)
    expect(s).toContain('500 GB storage')
    expect(s).toContain('Unlimited deployments')
    expect(s).toContain('Unlimited 3D model uploads')
    expect(s).toContain('Unlimited streaming')
    expect(s).toContain('Custom domain')
    expect(s).toContain('100 Design Studio prompts a day')
  })
  it('prices read as money and period', () => {
    expect(priceLabel({ amountCents: 1900, currency: 'usd', interval: 'month' })).toBe('$19 / month')
    expect(priceLabel({ amountCents: 1999, currency: 'usd', interval: null })).toBe('$19.99')
    expect(priceLabel(null)).toBeNull()
  })
  it('offers only the plans above your own', () => {
    const plans = (['free', 'creator', 'pro', 'studio', 'enterprise'] as const).map((tier) => ({ tier, limits: free, price: null, available: true }) as Plan)
    expect(upgradesFrom('free', plans).map((p) => p.tier)).toEqual(['creator', 'pro', 'studio', 'enterprise'])
    expect(upgradesFrom('pro', plans).map((p) => p.tier)).toEqual(['studio', 'enterprise'])
    expect(upgradesFrom('enterprise', plans)).toEqual([])
  })
  it('says what happened when coming back from checkout', () => {
    expect(checkoutReturnNote('success')).toMatch(/being updated/)
    expect(checkoutReturnNote('canceled')).toMatch(/Nothing was charged/)
    expect(checkoutReturnNote(null)).toBeNull()
  })
})
