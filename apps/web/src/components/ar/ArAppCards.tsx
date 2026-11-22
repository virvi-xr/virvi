'use client'
// Virvi AR on each platform, as cards, from AR_APPS (packages/shared/src/ar-apps.ts): virvi.io/ar and the dashboard's AR tab.
import { useEffect, useState } from 'react'
import { AR_APPS, arAppLink, arAppStatusLabel, arAppsForDevice, type ArApp, type ArAppStatus } from '@virvixr/shared'

const BADGE: Record<ArAppStatus, string> = {
  store: 'border-accent/60 text-accent',
  preview: 'border-blue-400/40 text-blue-200',
  prototype: 'border-gray-600 text-gray-300',
  coming: 'border-gray-700 text-gray-400',
}

export function ArAppCard({ app }: { app: ArApp }) {
  const link = arAppLink(app)
  return (
    <li className="flex min-w-0 flex-col rounded-lg border border-gray-800 bg-gray-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-white">{app.name} for {app.platform}</h3>
          <p className="text-sm text-gray-400">{app.device}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${BADGE[app.status]}`}>{arAppStatusLabel(app.status)}</span>
      </div>
      <p className="mt-3 flex-1 text-gray-300">{app.role}.</p>
      <p className="mt-4">
        <a href={link.href} className="inline-block rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-white hover:border-accent hover:text-accent">
          {link.label}
        </a>
      </p>
      {link.note && <p className="mt-2 text-xs text-gray-500">{link.note}</p>}
    </li>
  )
}

/** One card per app. The visitor's own device goes first once the page knows it (after load: the page is static). */
export function ArAppCards({ apps }: { apps?: readonly ArApp[] }) {
  const [ordered, setOrdered] = useState<readonly ArApp[]>(apps ?? AR_APPS)
  useEffect(() => {
    if (!apps) setOrdered(arAppsForDevice(navigator.userAgent))
  }, [apps])
  return (
    <ul className="grid gap-4 md:grid-cols-3">
      {ordered.map((app) => <ArAppCard key={app.id} app={app} />)}
    </ul>
  )
}
