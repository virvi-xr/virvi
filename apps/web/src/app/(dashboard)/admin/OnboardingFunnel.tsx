'use client'
import { useEffect, useState } from 'react'
import { useApi, type OnboardingFunnel as Funnel } from '@/lib/api'
import { funnelRows } from '@/lib/onboarding'

/** Admin: where new accounts stop on the getting-started checklist (LIV-37). Counts only. */
export default function OnboardingFunnel() {
  const api = useApi()
  const [data, setData] = useState<Funnel | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.getOnboardingFunnel(90).then(setData, (err) => setError(err?.message ?? "Couldn't load the funnel"))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <section aria-labelledby="onboarding-funnel" className="mt-8 rounded-lg border border-gray-800 bg-gray-900 p-5">
      <h2 id="onboarding-funnel" className="mb-1 text-base font-semibold text-white">Getting started</h2>
      <p className="mb-3 text-xs text-gray-400">Accounts made in the last 90 days (no trials or admins), and how many reached each step.</p>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {data && (
        <ol className="space-y-2">
          {funnelRows(data).map((r) => (
            <li key={r.label} className="text-sm">
              <div className="flex justify-between text-gray-300"><span>{r.label}</span><span>{r.count} ({r.percent})</span></div>
              <div className="mt-1 h-2 rounded bg-gray-800" aria-hidden="true"><div className="h-2 rounded bg-blue-500" style={{ width: r.percent }} /></div>
            </li>
          ))}
          <li className="pt-1 text-xs text-gray-400">Hid the checklist: {data.dismissed}</li>
        </ol>
      )}
    </section>
  )
}
