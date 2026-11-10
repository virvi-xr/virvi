'use client'
import { useAuth } from '@/lib/auth'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { useApi } from '@/lib/api'
import { scenePassAllows, trialAllows } from '@/lib/session'
import { openSignUp, signedInNote, takeMovedHeadsetNotice, trialNav } from '@/lib/trial'
import { signinPath } from '@/lib/landing-route'
import { isInvitePath } from '@/lib/studio-people'
import { useStudioAvailable } from '@/lib/use-studio'
import Link from 'next/link'
import { BrandMark } from '@/components/BrandMark'
import { NotificationBell } from '@/components/NotificationBell'
import { ASSET_LIBRARY, MEDIA_LIBRARY } from '@/lib/libraries'
import {
  BroadcastIcon, CalendarIcon, ChartIcon, CubeIcon, GearIcon, GiftIcon, HomeIcon, LayersIcon, LockIcon, LogoutIcon, MediaIcon,
  ScenesIcon, ShieldIcon, SparkleIcon, BugIcon, BookIcon,
} from '@/components/icons'
import { siteLinks } from '@/lib/site'
import { reporter } from '@/lib/errors/reporter'

/** `description` shows as the item's tooltip (what the page is for, where the label alone is ambiguous). */
type NavItem = { href: string; label: string; icon: (p: { size?: number }) => React.ReactElement; description?: string }
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
      { href: '/media', label: MEDIA_LIBRARY.name, icon: MediaIcon, description: MEDIA_LIBRARY.subtitle },
      { href: '/assets', label: ASSET_LIBRARY.name, icon: LayersIcon, description: ASSET_LIBRARY.subtitle },
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
  const { user, loading, logout, signOut, scenePass } = useAuth()
  const apiNow = useApi()
  const [sceneTitle, setSceneTitle] = useState('this scene')
  const [signedIn, setSignedIn] = useState<string | null>(null)
  const [headsetMoved, setHeadsetMoved] = useState<string | null>(null)
  const router = useRouter()
  const pathname = usePathname()

  // A trial has the Design Studio and Scenes; Analytics, Events and Giveaways open their demos; everything else stays visible
  // but locked. It calls no account-only route from here (no scene title, org or notification fetches), and the studio probe
  // is on a route trials may use.
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
      // A design's invite link is often someone's first visit: it opens on sign-up (sign in is beside it)
      router.push(signinPath(here, isInvitePath(window.location.pathname) ? 'register' : undefined))
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

  // A sign-in that moved the trial's paired headset onto the account: say so once
  useEffect(() => {
    if (!user || user.trial) return
    try {
      const note = takeMovedHeadsetNotice(localStorage)
      if (note) setHeadsetMoved(note)
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
        <div className="flex items-center justify-between gap-3 px-4 pt-4 md:px-6 md:pt-7">
          <BrandMark href={trial ? '/studio' : '/scenes'} />
          {/* The bell: signed-in accounts only (a trial has no notifications, and a scene pass may call nothing else) */}
          {!trial && !scenePass && <NotificationBell />}
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 py-3 md:block md:flex-1 md:overflow-y-auto md:px-3 md:py-6">
          {navSections.map((section, i) => (
            <div key={section.label} className={`flex gap-1 md:block ${i > 0 ? 'md:mt-5 md:border-t md:border-gray-800 md:pt-5' : ''}`}>
              <p className="hidden px-3 pb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-gray-500 md:block">{section.label}</p>
              {section.items.map(({ href, label, icon: NavIcon, description }) => {
                const open = trial ? trialNav(href) : { href, demo: false }
                if (!open) {
                  return (
                    <button key={href} type="button" title={description} onClick={() => askSignUp(`nav:${href}`, label)}
                      className="relative flex shrink-0 items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm text-gray-500 transition-colors hover:bg-white/[0.03] hover:text-gray-300 md:mb-0.5">
                      <span className="text-gray-600"><NavIcon size={18} /></span>
                      {label}
                      <span className="ml-auto text-gray-600"><LockIcon size={14} /></span>
                      <span className="sr-only">(needs a free account)</span>
                    </button>
                  )
                }
                const active = pathname.startsWith(open.href) || Object.entries(NAV_PARENT).some(([child, parent]) => parent === open.href && pathname.startsWith(child))
                return (
                  <Link key={href} href={open.href} title={description} aria-current={active ? 'page' : undefined}
                    className={`relative flex shrink-0 items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors md:mb-0.5 ${active ? 'bg-white/[0.05] text-white' : 'text-gray-400 hover:bg-white/[0.03] hover:text-white'}`}>
                    {active && <span className="absolute inset-y-1.5 left-0 hidden w-0.5 rounded-full bg-accent md:block" />}
                    <span className={active ? 'text-accent' : 'text-gray-500'}><NavIcon size={18} /></span>
                    {label}
                    {open.demo && <span className="ml-auto rounded border border-gray-700 px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-gray-400">Demo</span>}
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>
        {/* Help: always here, whatever the session (LIV-66 §4) */}
        <div className="border-t border-gray-800 px-3 py-2 md:px-3">
          <p className="hidden px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.2em] text-gray-500 md:block">Help</p>
          <a href={siteLinks().docs} target="_blank" rel="noopener"
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-gray-400 transition-colors hover:bg-white/[0.03] hover:text-white">
            <span className="text-gray-500"><BookIcon size={18} /></span>
            Docs
          </a>
          <button type="button" onClick={() => reporter.openReport()}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-gray-400 transition-colors hover:bg-white/[0.03] hover:text-white">
            <span className="text-gray-500"><BugIcon size={18} /></span>
            Report a bug
          </button>
        </div>
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
              <button onClick={signOut} className="text-xs text-gray-500 hover:text-white">Sign Out</button>
            )}
          </div>
          {!trial && (
            <button onClick={signOut} aria-label="Sign out" className="rounded-md p-1.5 text-gray-500 hover:bg-white/[0.05] hover:text-white">
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
            <span className="ml-auto flex items-center gap-3">
              <button type="button" onClick={() => askSignUp('signin', undefined, 'signin')} className="text-blue-200/80 underline underline-offset-2 hover:text-white">Sign in</button>
              <button type="button" onClick={() => askSignUp('signup')} className="clip-corner bg-accent px-3 py-1 font-semibold text-accent-ink hover:bg-accent-hover">Sign up</button>
            </span>
          </div>
        )}
        {signedIn && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-emerald-500/40 px-4 py-2 text-sm text-emerald-200" role="status">
            <span>{signedIn}</span>
            <button type="button" onClick={() => setSignedIn(null)} aria-label="Dismiss" className="text-emerald-300 hover:text-white">✕</button>
          </div>
        )}
        {headsetMoved && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-emerald-500/40 px-4 py-2 text-sm text-emerald-200" role="status">
            <span>{headsetMoved}</span>
            <button type="button" onClick={() => setHeadsetMoved(null)} aria-label="Dismiss" className="text-emerald-300 hover:text-white">✕</button>
          </div>
        )}
        {locked ? (
          <div className="mx-auto mt-10 max-w-md text-center">
            <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-900 text-gray-400"><LockIcon size={22} /></span>
            <h1 className="text-xl font-semibold">This needs a free account</h1>
            <p className="mt-2 text-sm text-gray-400">You're trying Virvi. Create an account to open the rest of it. Your trial designs and scenes come with you.</p>
            <div className="mt-5 flex items-center justify-center gap-3">
              <button type="button" onClick={() => askSignUp(`nav:${pathname}`, 'this page')}
                className="clip-corner bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover">Sign up</button>
              <Link href="/scenes" className="text-sm text-blue-300 underline">Back to your scenes</Link>
            </div>
          </div>
        ) : children}
      </main>
    </div>
  )
}
