'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useApi } from '@/lib/api'
import { BellIcon } from '@/components/icons'
import { badgeText, inviteActionable, notificationText, type NotificationItem } from '@/lib/notifications'
import { acceptRefusal, peopleRefusal, roleLabel } from '@/lib/studio-people'
import { relativeTime } from '@/lib/studio'

const POLL_MS = 60_000

/**
 * The bell (LIV-159): invites, new prompts, packages ready and new ownership. The count is polled every minute while
 * the tab is visible and on focus; the list loads when it opens. Signed-in accounts only: the layout leaves it out
 * for trials and scene passes.
 */
export function NotificationBell({ align = 'left' }: { align?: 'left' | 'right' }) {
  const api = useApi()
  const router = useRouter()
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[] | null>(null)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const refreshCount = useCallback(() => {
    api.getUnreadNotifications().then((r) => setCount(r.count)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => { if (!timer) timer = setInterval(refreshCount, POLL_MS) }
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const onVisibility = () => { if (document.hidden) stop(); else { refreshCount(); start() } }
    const onFocus = () => refreshCount()
    if (!document.hidden) { refreshCount(); start() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('focus', onFocus) }
  }, [refreshCount])

  const load = useCallback(async (before?: string) => {
    setLoading(true)
    setFailed(false)
    try {
      const r = await api.getNotifications(before)
      setItems((prev) => (before && prev ? [...prev, ...r.items] : r.items))
      setMore(r.more)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!open) return
    load()
    refreshCount()
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, load, refreshCount])

  const go = (href: string) => {
    setOpen(false)
    // A design's page is one static page for every id: load it in full, as the Studio page does
    if (href.startsWith('/studio/')) window.location.assign(`${href}/`)
    else router.push(href)
  }

  const openItem = (n: NotificationItem) => {
    const { href } = notificationText(n)
    if (!n.readAt) {
      setItems((prev) => prev?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? prev)
      setCount((c) => Math.max(0, c - 1))
      api.markNotificationRead(n.id).catch(() => {}).finally(refreshCount)
    }
    if (href) go(href)
  }

  const markAll = () => {
    const now = new Date().toISOString()
    setItems((prev) => prev?.map((x) => (x.readAt ? x : { ...x, readAt: now })) ?? prev)
    setCount(0)
    api.markAllNotificationsRead().catch(() => {}).finally(refreshCount)
  }

  const answer = async (n: NotificationItem, accept: boolean) => {
    const inviteId = String(n.data.inviteId ?? '')
    setBusy(n.id)
    setErrors((e) => { const { [n.id]: _, ...rest } = e; return rest })
    try {
      if (accept) {
        const r = await api.acceptStudioInvite(inviteId)
        go(`/studio/${r.designId}`)
        return
      }
      await api.declineStudioInvite(inviteId)
      setItems((prev) => prev?.filter((x) => x.id !== n.id) ?? prev)
      refreshCount()
    } catch (err) {
      const text = accept ? acceptRefusal(err as never).text : peopleRefusal(err as never)
      setErrors((e) => ({ ...e, [n.id]: text }))
    } finally {
      setBusy(null)
    }
  }

  const badge = badgeText(count)
  const now = new Date()
  const unread = items?.some((n) => !n.readAt) ?? false

  return (
    <div ref={root} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}
        aria-label={badge ? `Notifications, ${count} unread` : 'Notifications'}
        className="relative rounded-md p-1.5 text-gray-400 transition-colors hover:bg-white/[0.05] hover:text-white">
        <BellIcon size={20} />
        {badge && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-ink">{badge}</span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications"
          className={`fixed inset-x-3 top-16 z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-gray-800 bg-gray-950 shadow-xl md:absolute md:inset-x-auto md:top-full md:mt-2 md:w-80 ${align === 'right' ? 'md:right-0' : 'md:left-0'}`}>
          <div className="flex items-center justify-between gap-3 border-b border-gray-800 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-gray-100">Notifications</h2>
            {unread && <button type="button" onClick={markAll} className="text-xs text-gray-400 hover:text-white">Mark all read</button>}
          </div>
          {items === null ? (
            <p className="px-4 py-6 text-center text-sm text-gray-500">{failed ? 'Couldn’t load your notifications.' : 'Loading…'}</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-500">Nothing new.</p>
          ) : (
            <ul>
              {items.map((n) => {
                const { text, href } = notificationText(n)
                const invite = inviteActionable(n)
                return (
                  <li key={n.id} className="border-b border-gray-900 last:border-b-0">
                    <div className="flex items-start gap-2 px-4 py-3">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-accent'}`} aria-label={n.readAt ? undefined : 'Unread'} />
                      <div className="min-w-0 flex-1">
                        {href ? (
                          <button type="button" onClick={() => openItem(n)} className={`block w-full text-left text-sm hover:text-white ${n.readAt ? 'text-gray-400' : 'text-gray-100'}`}>{text}</button>
                        ) : (
                          <p className="text-sm text-gray-500">{text}</p>
                        )}
                        <p className="mt-0.5 text-xs text-gray-500">
                          {invite && <>As {roleLabel(String(n.data.role ?? 'viewer'))} · </>}{relativeTime(n.updatedAt, now)}
                        </p>
                        {invite && (
                          <div className="mt-2 flex gap-2">
                            <button type="button" disabled={busy === n.id} onClick={() => answer(n, true)}
                              className="clip-corner bg-accent px-3 py-1 text-xs font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50">Accept</button>
                            <button type="button" disabled={busy === n.id} onClick={() => answer(n, false)}
                              className="rounded border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:text-white disabled:opacity-50">Decline</button>
                          </div>
                        )}
                        {errors[n.id] && <p className="mt-1.5 text-xs text-red-300" role="alert">{errors[n.id]}</p>}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {more && items && (
            <div className="border-t border-gray-800 px-4 py-2.5 text-center">
              <button type="button" disabled={loading} onClick={() => load(items[items.length - 1].updatedAt)}
                className="text-xs text-gray-400 hover:text-white disabled:opacity-50">{loading ? 'Loading…' : 'More'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
