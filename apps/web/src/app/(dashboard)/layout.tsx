'use client'
import { useAuth } from '@/lib/auth'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { useApi } from '@/lib/api'
import { scenePassAllows } from '@/lib/session'
import { signinPath } from '@/lib/landing-route'
import { useStudioAvailable } from '@/lib/use-studio'
import Link from 'next/link'
import { InstanceBadge } from '@/components/InstanceBadge'
import {
  BroadcastIcon, CalendarIcon, ChartIcon, CubeIcon, GearIcon, GiftIcon, HomeIcon, LayersIcon, LogoutIcon, MediaIcon,
  ScenesIcon, ShieldIcon, SparkleIcon,
} from '@/components/icons'

type NavItem = { href: string; label: string; icon: (p: { size?: number }) => React.ReactElement }
type NavSection = { label: string; items: NavItem[] }

const baseNavSections: NavSection[] = [
  {
    label: 'Workspace',
    items: [
      { href: '/command-center', label: 'Command Center', icon: HomeIcon },
      { href: '/scenes', label: 'Scenes', icon: ScenesIcon },
      { href: '/events', label: 'Events', icon: CalendarIcon },
      { href: '/giveaways', label: 'Giveaways', icon: GiftIcon },
    ],
  },
  {
    label: 'Tools',
    items: [
      { href: '/media', label: 'Media', icon: MediaIcon },
      { href: '/assets', label: 'Assets', icon: LayersIcon },
      { href: '/streaming', label: 'Streaming', icon: BroadcastIcon },
      { href: '/deploy', label: 'Deploy', icon: CubeIcon },
      { href: '/analytics', label: 'Analytics', icon: ChartIcon },
    ],
  },
  { label: 'System', items: [{ href: '/settings', label: 'Settings', icon: GearIcon }] },
]
// Pages reached from another tab, which stays highlighted while they are open
const NAV_PARENT: Record<string, string> = { '/import': '/scenes' }
const ADMIN_ITEM: NavItem = { href: '/admin', label: 'Admin', icon: ShieldIcon }
// Shown only where the studio is on (the server's studio routes answer)
const STUDIO_ITEM: NavItem = { href: '/studio', label: 'Design Studio', icon: SparkleIcon }

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout, scenePass } = useAuth()
  const apiNow = useApi()
  const [sceneTitle, setSceneTitle] = useState('this scene')
  const router = useRouter()
  const pathname = usePathname()

  const studioOn = useStudioAvailable()
  const navSections = useMemo(() => {
    if (scenePass) return []
    return baseNavSections.map((s) => {
      if (s.label === 'Workspace' && studioOn) return { ...s, items: [...s.items, STUDIO_ITEM] }
      if (s.label === 'System' && user?.role === 'admin') return { ...s, items: [...s.items, ADMIN_ITEM] }
      return s
    })
  }, [user?.role, scenePass, studioOn])

  useEffect(() => {
    if (!loading && !user) {
      const here = window.location.pathname + window.location.search
      router.push(signinPath(here))
    }
  }, [user, loading, router])

  // A scene pass may only open its own scene's analytics; anything else goes to sign-in.
  useEffect(() => {
    if (!loading && user && scenePass && !scenePassAllows(window.location.pathname, window.location.search, scenePass)) {
      router.push(signinPath(window.location.pathname + window.location.search))
    }
  }, [user, loading, scenePass, pathname, router])

  // The pass's only scene is the one it was minted for; its name goes in the banner.
  const passSceneId = scenePass?.sceneId
  useEffect(() => {
    if (!passSceneId) return
    let cancelled = false
    apiNow.getScenes()
      .then((r) => { if (!cancelled) setSceneTitle(r.scenes?.[0]?.name ?? 'this scene') })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passSceneId])

  if (loading) return <div className="flex h-screen items-center justify-center"><p>Loading...</p></div>
  if (!user) return null

  const here = typeof window === 'undefined' ? pathname : window.location.pathname + window.location.search

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex w-full shrink-0 flex-col border-b border-gray-800 bg-gray-950 md:sticky md:top-0 md:h-screen md:w-64 md:border-b-0 md:border-r">
        <div className="px-4 pt-4 md:px-6 md:pt-7">
          <div className="flex items-center gap-2">
            <Link href="/scenes" className="text-xl font-bold tracking-tight text-white">Virvi</Link>
            <InstanceBadge />
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 py-3 md:block md:flex-1 md:overflow-y-auto md:px-3 md:py-6">
          {navSections.map((section, i) => (
            <div key={section.label} className={`flex gap-1 md:block ${i > 0 ? 'md:mt-5 md:border-t md:border-gray-800 md:pt-5' : ''}`}>
              <p className="hidden px-3 pb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-gray-500 md:block">{section.label}</p>
              {section.items.map(({ href, label, icon: NavIcon }) => {
                const active = pathname.startsWith(href) || Object.entries(NAV_PARENT).some(([child, parent]) => parent === href && pathname.startsWith(child))
                return (
                  <Link key={href} href={href} aria-current={active ? 'page' : undefined}
                    className={`relative flex shrink-0 items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors md:mb-0.5 ${active ? 'bg-white/[0.05] text-white' : 'text-gray-400 hover:bg-white/[0.03] hover:text-white'}`}>
                    {active && <span className="absolute inset-y-1.5 left-0 hidden w-0.5 rounded-full bg-accent md:block" />}
                    <span className={active ? 'text-accent' : 'text-gray-500'}><NavIcon size={18} /></span>
                    {label}
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-3 border-t border-gray-800 px-4 py-3 md:px-6 md:py-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-800 text-sm font-semibold text-gray-200">
            {(user.displayName || '?').trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-100">{user.displayName}</p>
            <button onClick={logout} className="text-xs text-gray-500 hover:text-white">Sign Out</button>
          </div>
          <button onClick={logout} aria-label="Sign out" className="rounded-md p-1.5 text-gray-500 hover:bg-white/[0.05] hover:text-white">
            <LogoutIcon size={18} />
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-5 md:px-10 md:py-8">
        {scenePass && (
          <div className="mb-4 rounded-md border border-gray-800 bg-gray-900 px-4 py-2 text-sm text-gray-300">
            Signed in from {sceneTitle} — <Link className="underline" href={signinPath(here)} onClick={logout}>sign in for full access</Link>
          </div>
        )}
        {children}
      </main>
    </div>
  )
}
