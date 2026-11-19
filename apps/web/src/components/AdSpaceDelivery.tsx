'use client'

import { useEffect, useState } from 'react'
import type { OwnerAdSpaceReport } from '@virvixr/shared'
import type { useApi } from '@/lib/api'
import { clickRate, guestViews } from '@/lib/ads'

const RANGES = [7, 30, 90] as const

/**
 * LIV-38: what this ad space delivered, per ad, for the scene's owner. Views are verified wallets, counted once per
 * person per level per day (what campaigns are measured by); guests without a verified wallet are a separate line.
 */
export default function AdSpaceDelivery({ elementId, api }: { elementId: string; api: ReturnType<typeof useApi> }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30)
  const [report, setReport] = useState<OwnerAdSpaceReport | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setFailed(false)
    api.getAdSpaceReport(elementId, days).then((d) => { if (live) setReport(d.report) }, () => { if (live) setFailed(true) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elementId, days])

  const guests = report ? guestViews(report.totals) : 0
  return (
    <div className="space-y-2 border-t border-gray-800 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-gray-500">What this space delivered</span>
        <select aria-label="Delivery period" value={days} onChange={(e) => setDays(Number(e.target.value) as typeof days)}
          className="rounded border border-gray-800 bg-gray-950 px-2 py-1 text-xs text-white outline-none focus:border-blue-400">
          {RANGES.map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>
      {failed && <p className="text-xs text-red-400">Couldn’t load the delivery numbers.</p>}
      {report && report.ads.length === 0 && <p className="text-sm text-gray-500">No ad has shown here in the last {report.days} days.</p>}
      {report && report.ads.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th scope="col" className="py-1 pr-3 font-normal">Ad</th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">In scene</th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">On screen</th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">Looked at</th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">Clicked</th>
                <th scope="col" className="py-1 text-right font-normal">Click rate</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {report.ads.map((a) => (
                <tr key={a.adId} className="border-t border-gray-800">
                  <td className="py-1.5 pr-3">
                    <span className="text-white">{a.name}</span>
                    {a.house && <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-400">Virvi</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-right">{a.scene}</td>
                  <td className="py-1.5 pr-3 text-right">{a.screen}</td>
                  <td className="py-1.5 pr-3 text-right">{a.look}</td>
                  <td className="py-1.5 pr-3 text-right">{a.click}</td>
                  <td className="py-1.5 text-right">{clickRate(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report && (
        <p className="text-xs text-gray-500">
          Verified wallets, each counted once a day.{guests > 0 && ` Guests without a verified wallet added ${guests} more ${guests === 1 ? 'view' : 'views'}, which campaigns don’t count.`}
        </p>
      )}
    </div>
  )
}
