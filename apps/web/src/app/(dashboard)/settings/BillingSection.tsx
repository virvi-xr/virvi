'use client'
import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/lib/api'
import { Badge, PrimaryButton, Skeleton, type Tone } from '@/components/ui'
import { instanceLabel, useInstance } from '@/lib/instance'
import { formatBytes } from '@/lib/format'
import { checkoutReturnNote, planFeatures, priceLabel, tierName, upgradesFrom, type Plan, type PlanLimits } from '@/lib/billing'

const TIER_TONE: Record<string, Tone> = { free: 'neutral', creator: 'info', pro: 'violet', studio: 'warning', enterprise: 'success' }

type Usage = { tier: string; usage: { scenes: number; storageBytes: number; streamMinutes: number }; limits: Partial<PlanLimits> | null }

function UsageBar({ label, current, limit, formatValue }: { label: string; current: number; limit: number | null | undefined; formatValue: (v: number) => string }) {
  const unlimited = limit === null || limit === undefined
  const pct = unlimited || !limit ? 0 : Math.min((current / limit) * 100, 100)
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-sm">
        <span className="text-gray-400">{label}</span>
        <span className="text-right text-gray-300">{formatValue(current)} / {unlimited ? 'Unlimited' : formatValue(limit)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-gray-800">
        {unlimited ? <div className="h-full w-full rounded-full bg-green-500/30" /> : <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  )
}

/** Settings → Billing & Usage: your plan and usage, and the plans above it as the server has them. */
export function BillingSection() {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const instance = useInstance()
  // Back from Stripe Checkout: read once on the client (useSearchParams would need a Suspense boundary)
  const [returned, setReturned] = useState<string | null>(null)
  useEffect(() => { setReturned(checkoutReturnNote(new URLSearchParams(window.location.search).get('billing'))) }, [])
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(true)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [usageError, setUsageError] = useState(false)
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const a = apiRef.current
    Promise.allSettled([a.getBillingSubscription(), a.getBillingUsage(), a.getBillingPlans()]).then(([sub, u, p]) => {
      if (sub.status === 'fulfilled' && sub.value.billingEnabled === false) setEnabled(false)
      if (u.status === 'fulfilled') setUsage(u.value as Usage); else setUsageError(true)
      if (p.status === 'fulfilled') setPlans(p.value.plans)
      setLoading(false)
    })
  }, [])

  const tier = usage?.tier ?? null
  const run = async (key: string, fn: () => Promise<{ url: string }>) => {
    setBusy(key)
    setError(null)
    try { window.location.href = (await fn()).url } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setBusy(null)
    }
  }

  return (
    <section className="mt-10">
      <h2 className="mb-4 text-lg font-semibold">Billing & Usage</h2>
      {loading ? <Skeleton rows={2} className="h-12" /> : !enabled ? (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
          <div className="mb-2 flex items-center gap-3"><Badge tone="success">{instanceLabel(instance?.mode) ?? 'Billing off'}</Badge></div>
          <p className="text-gray-300">All features unlocked. Billing is not enabled on this instance.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {returned && <p className="rounded-md border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-300" role="status">{returned}</p>}
          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-400">Current plan</span>
                {tier && <Badge tone={TIER_TONE[tier] ?? 'neutral'}>{tierName(tier)}</Badge>}
              </div>
              {tier && tier !== 'free' && (
                <button type="button" disabled={busy === 'portal'} onClick={() => run('portal', () => api.getPortalUrl())}
                  className="rounded-md bg-gray-700 px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-600 disabled:opacity-50">
                  {busy === 'portal' ? 'Redirecting…' : 'Manage subscription'}
                </button>
              )}
            </div>
            {usageError || !usage ? (
              <p className="text-sm text-amber-300" role="alert">Your usage couldn’t be loaded. Refresh the page to try again.</p>
            ) : (
              <div className="space-y-3">
                <UsageBar label="Storage" current={usage.usage.storageBytes} limit={usage.limits?.storageBytes} formatValue={formatBytes} />
                {usage.limits?.streamMinutes !== 0 && (
                  <UsageBar label="Streaming minutes this month" current={usage.usage.streamMinutes} limit={usage.limits?.streamMinutes} formatValue={(v) => v.toLocaleString('en-US')} />
                )}
                <p className="text-sm text-gray-400">{usage.usage.scenes.toLocaleString('en-US')} {usage.usage.scenes === 1 ? 'scene' : 'scenes'}. Every plan has unlimited scenes.</p>
              </div>
            )}
          </div>

          {tier && plans && upgradesFrom(tier, plans).length > 0 && (
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 sm:p-6">
              <h3 className="mb-3 text-sm font-medium text-gray-300">Upgrade your plan</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {upgradesFrom(tier, plans).map((p) => {
                  const enterprise = p.tier === 'enterprise'
                  const price = priceLabel(p.price)
                  return (
                    <div key={p.tier} className="flex flex-col rounded-lg border border-gray-800 bg-gray-950 p-4">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-base font-semibold text-white">{tierName(p.tier)}</span>
                        <span className="text-sm text-gray-300">{enterprise ? 'Custom' : price ?? (p.available ? '' : 'Price coming soon')}</span>
                      </div>
                      {enterprise ? (
                        <p className="mt-2 flex-1 text-sm text-gray-400">Limits set for you, and dedicated support.</p>
                      ) : (
                        <ul className="mt-2 flex-1 space-y-1 text-sm text-gray-400">
                          {planFeatures(p.limits).map((f) => <li key={f}>{f}</li>)}
                        </ul>
                      )}
                      <div className="mt-4">
                        {enterprise ? (
                          <a href="mailto:sales@virvi.io?subject=Enterprise%20plan" className="inline-block rounded-md border border-gray-700 px-4 py-2 text-sm font-medium text-gray-200 hover:border-gray-600">Contact sales</a>
                        ) : p.available ? (
                          <PrimaryButton type="button" disabled={busy === p.tier} onClick={() => run(p.tier, () => api.createCheckout(p.tier as 'creator' | 'pro' | 'studio'))}>
                            {busy === p.tier ? 'Redirecting…' : `Upgrade to ${tierName(p.tier)}`}
                          </PrimaryButton>
                        ) : (
                          <p className="text-xs text-gray-500">Not available to buy yet.</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
