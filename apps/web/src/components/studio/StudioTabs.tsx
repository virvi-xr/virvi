'use client'
import Link from 'next/link'
import { useAuth } from '@/lib/auth'
import { useStudioAvailable } from '@/lib/use-studio'
import { visibleStudioTabs, type StudioTab } from '@/lib/studio'

/**
 * Studio's tabs (LIV-200): Scenes, then the design tabs where the Design Studio is on (or for a trial). The designs list
 * is one static page (/studio/ with ?kind=), so the client router can take these links; only a design page needs a full load.
 */
export function StudioTabs({ active }: { active: StudioTab }) {
  const { user } = useAuth()
  const studioOn = useStudioAvailable()
  const tabs = visibleStudioTabs(!!studioOn || !!user?.trial)
  return (
    <nav aria-label="Studio" className="-mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-gray-800 px-1">
      {tabs.map((t) => {
        const on = t.tab === active
        return (
          <Link key={t.tab} href={t.href} aria-current={on ? 'page' : undefined}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${on ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
