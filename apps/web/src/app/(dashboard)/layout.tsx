'use client'
import { useAuth } from '@/lib/auth'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { useApi } from '@/lib/api'
import { scenePassAllows, trialAllows } from '@/lib/session'
import { openSignUp, signedInNote } from '@/lib/trial'
import { signinPath } from '@/lib/landing-route'
import { useStudioAvailable } from '@/lib/use-studio'
import Link from 'next/link'
import { BrandMark } from '@/components/BrandMark'
import {
  BroadcastIcon, CalendarIcon, ChartIcon, CubeIcon, GearIcon, GiftIcon, HomeIcon, LayersIcon, LockIcon, LogoutIcon, MediaIcon,
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
  const [signedIn, setSignedIn] = useState<string | null>(null)
  const router = useRouter()
  const pathname = usePathname()

  // A trial has the Design Studio only: everything else stays visible but locked. It calls no account-only route from here
  // (no scene title, org or notification fetches), and the studio probe is on a route trials may use.
  const trial = !!user?.trial
  const studioOn = useStudioAvailable()
  const navSections = useMemo(() => {
    if (scenePass) return []
    return baseNavSections.map((s) => {
      if (s.label === 'Workspace' && (studioOn || trial)) return { ...s, items: [...s.items, STUDIO_ITEM] }
      if (s.label === 'System' && user?.role === 'admin') return { ...s, items: [...s.items, ADMIN_ITEM] }
      return s
    })
  }, [user?.role, scenePass, studioOn, trial])

  useEffect(() => {
    if (!loading && !user) {
      const here = window.location.pathname + window.location.search
      router.push(signinPath(here))
    }
  }, [user, loading, router])

  // Back from Google or Discord sign-in: say so once, naming the action that was blocked
  useEffect(() => {
    if (!user || user.trial) return
    try {
      const from = sessionStorage.getItem('virvi.signedInFrom')
      if (from === null) return
      sessionStorage.removeItem('virvi.signedInFrom')
      setSignedIn(signedInNote(from))
    } catch {}
  }, [user])

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
  const locked = trial && !trialAllows(pathname)
  const askSignUp = (action: string, label?: string, tab?: 'create' | 'signin') => { openSignUp({ action, ctx: { label }, tab }).catch(() => {}) }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex w-full shrink-0 flex-col border-b border-gray-800 bg-gray-950 md:sticky md:top-0 md:h-screen md:w-64 md:border-b-0 md:border-r">
        <div className="px-4 pt-4 md:px-6 md:pt-7">
          <BrandMark href={trial ? '/studio' : '/scenes'} />
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 py-3 md:block md:flex-1 md:overflow-y-auto md:px-3 md:py-6">
          {navSections.map((section, i) => (
            <div key={section.label} className={`flex gap-1 md:block ${i > 0 ? 'md:mt-5 md:border-t md:border-gray-800 md:pt-5' : ''}`}>
              <p className="hidden px-3 pb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-gray-500 md:block">{section.label}</p>
              {section.items.map(({ href, label, icon: NavIcon }) => {
                const active = pathname.startsWith(href) || Object.entries(NAV_PARENT).some(([child, parent]) => parent === href && pathname.startsWith(child))
                if (trial && href !== '/studio') {
                  return (
                    <button key={href} type="button" onClick={() => askSignUp(`nav:${href}`, label)}
                      className="relative flex shrink-0 items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm text-gray-500 transition-colors hover:bg-white/[0.03] hover:text-gray-300 md:mb-0.5">
                      <span className="text-gray-600"><NavIcon size={18} /></span>
                      {label}
                      <span className="ml-auto text-gray-600"><LockIcon size={14} /></span>
                      <span className="sr-only">(needs a free account)</span>
                    </button>
                  )
                }
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
            {trial ? (
              <p className="text-xs text-gray-500">
                <button type="button" onClick={() => askSignUp('signup')} className="hover:text-white">Sign up</button>
                {' · '}
                <button type="button" onClick={() => askSignUp('signin', undefined, 'signin')} className="hover:text-white">Sign in</button>
              </p>
            ) : (
              <button onClick={logout} className="text-xs text-gray-500 hover:text-white">Sign Out</button>
            )}
          </div>
          {!trial && (
            <button onClick={logout} aria-label="Sign out" className="rounded-md p-1.5 text-gray-500 hover:bg-white/[0.05] hover:text-white">
              <LogoutIcon size={18} />
            </button>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-5 md:px-10 md:py-8">
        {scenePass && (
          <div className="mb-4 rounded-md border border-gray-800 bg-gray-900 px-4 py-2 text-sm text-gray-300">
            Signed in from {sceneTitle} — <Link className="underline" href={signinPath(here)} onClick={logout}>sign in for full access</Link>
          </div>
        )}
        {trial && (
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-sm text-blue-100" role="status">
            <span>You're trying Virvi. Create an account to save your work</span>
            {user.expiresAt && <span className="text-blue-200/70">Your trial is kept until {new Date(user.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>}
            <button type="button" onClick={() => askSignUp('signup')} className="ml-auto font-medium underline underline-offset-2 hover:text-white">Create account</button>
          </div>
        )}
        {signedIn && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-emerald-500/40 px-4 py-2 text-sm text-emerald-200" role="status">
            <span>{signedIn}</span>
            <button type="button" onClick={() => setSignedIn(null)} aria-label="Dismiss" className="text-emerald-300 hover:text-white">✕</button>
          </div>
        )}
        {locked ? (
          <div className="mx-auto mt-10 max-w-md text-center">
            <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-900 text-gray-400"><LockIcon size={22} /></span>
            <h1 className="text-xl font-semibold">This needs a free account</h1>
            <p className="mt-2 text-sm text-gray-400">You're trying the Design Studio. Create an account to open the rest of Virvi. Your trial designs come with you.</p>
            <div className="mt-5 flex items-center justify-center gap-3">
              <button type="button" onClick={() => askSignUp(`nav:${pathname}`, 'this page')}
                className="clip-corner bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover">Sign up</button>
              <Link href="/studio" className="text-sm text-blue-300 underline">Back to the Design Studio</Link>
            </div>
          </div>
        ) : children}
      </main>
    </div>
  )
}
