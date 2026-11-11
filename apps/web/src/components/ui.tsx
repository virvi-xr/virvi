// Shared dashboard pieces for the graphite + cyan look.
import Link from 'next/link'
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { ChevronDownIcon, MoreIcon, PencilIcon, SearchIcon } from './icons'

/** The page's main call to action: bright cyan with a clipped corner. Use one per page. */
export function PrimaryButton({ className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      {...rest}
      className={`clip-corner inline-flex items-center gap-1.5 bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  )
}

/** A breadcrumb step: plain text, or a link back up to that page. */
export type Crumb = string | { label: string; href: string }

/** Breadcrumb, title with an optional count badge, subtitle, and the page's actions on the right. Detail pages link their parent crumb instead of a back link. */
export function PageHeader({ crumbs, title, count, subtitle, actions }: { crumbs?: Crumb[]; title: ReactNode; count?: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 border-b border-gray-800 pb-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-3 text-sm text-gray-500">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1
            return (
              <span key={i}>
                {i > 0 && <span className="mx-2 text-gray-600">/</span>}
                {typeof c === 'string'
                  ? <span className={last ? 'text-gray-200' : ''} aria-current={last ? 'page' : undefined}>{c}</span>
                  : <Link href={c.href} className="text-gray-400 hover:text-blue-300">{c.label}</Link>}
              </span>
            )
          })}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="break-words text-3xl font-bold tracking-tight md:text-4xl">{title}</h1>
            {count !== undefined && <span className="rounded bg-gray-800 px-2 py-1 font-mono text-sm text-blue-300">{count}</span>}
          </div>
          {subtitle && <div className="mt-2 text-gray-400">{subtitle}</div>}
        </div>
        {actions}
      </div>
    </header>
  )
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'violet'

const TONES: Record<Tone, string> = {
  neutral: 'bg-gray-800 text-gray-300',
  info: 'bg-blue-400/15 text-blue-300',
  success: 'bg-green-400/15 text-green-300',
  warning: 'bg-yellow-400/15 text-yellow-300',
  danger: 'bg-red-400/15 text-red-300',
  violet: 'bg-purple-400/15 text-purple-300',
}

/** Classes for a status pill, for the odd button that has to look like one. */
export function badgeClass(tone: Tone = 'neutral') {
  return `inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`
}

/** A small status or category pill. */
export function Badge({ tone = 'neutral', className = '', children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={`${badgeClass(tone)} ${className}`}>{children}</span>
}

const PLATFORMS: Record<string, [string, Tone]> = {
  decentraland: ['Decentraland', 'violet'],
  hyperfy: ['Hyperfy', 'info'],
  ar: ['AR', 'neutral'],
}

/** Which platform a scene or world runs on, coloured the same everywhere. */
export function PlatformBadge({ platform, className }: { platform: string | null; className?: string }) {
  const [name, tone] = (platform && PLATFORMS[platform]) || [platform || 'Unknown', 'neutral']
  return <Badge tone={tone} className={className}>{name}</Badge>
}

/** A coloured dot and label for something's live state, like a deploy or a server. `dot` is the dot's background class. */
export function StatusDot({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

/** A table's header row, in the Events list style: small uppercase mono. Add `tableHeadBand` when the table sits in its own bordered box. */
export const tableHead = 'text-left font-mono text-xs uppercase tracking-wider text-gray-400 [&_th]:font-normal'
export const tableHeadBand = `${tableHead} border-b border-gray-800 bg-gray-950/40`

/** The toolbar's search box. */
export function SearchField({ value, onChange, placeholder, label, className = '' }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string }) {
  return (
    <label className={`relative min-w-56 flex-1 ${className}`}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"><SearchIcon size={18} /></span>
      <span className="sr-only">{label}</span>
      <input type="search" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full rounded-md border border-gray-800 bg-gray-900 py-2.5 pl-10 pr-3 text-sm outline-none placeholder:text-gray-500 focus:border-blue-400" />
    </label>
  )
}

/** A toolbar dropdown matching the search box. */
export function SelectField({ value, onChange, label, children, className = '' }: { value: string; onChange: (v: string) => void; label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`relative ${className}`}>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full appearance-none rounded-md border border-gray-800 bg-gray-900 py-2.5 pl-3 pr-9 text-sm text-gray-200 outline-none focus:border-blue-400">
        {children}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"><ChevronDownIcon size={16} /></span>
    </label>
  )
}

/** Segmented icon buttons for switching between a page's views. */
export function ViewToggle<V extends string>({ value, onChange, options }: { value: V; onChange: (v: V) => void; options: readonly (readonly [V, (p: { size?: number }) => ReactNode, string])[] }) {
  return (
    <div className="flex rounded-md border border-gray-800 bg-gray-900 p-0.5" role="group" aria-label="View">
      {options.map(([v, ViewIcon, label]) => (
        <button key={v} onClick={() => onChange(v)} aria-label={label} aria-pressed={value === v}
          className={`rounded p-2 transition-colors ${value === v ? 'bg-blue-400/15 text-blue-300' : 'text-gray-500 hover:text-white'}`}>
          <ViewIcon size={18} />
        </button>
      ))}
    </div>
  )
}

/** The page's chosen view, remembered in this browser under `key`. */
export function useStoredView<V extends string>(key: string, views: readonly V[], fallback: V): [V, (v: V) => void] {
  const [view, setView] = useState<V>(fallback)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key) as V | null
      if (saved && views.includes(saved)) setView(saved)
    } catch {
      // no storage: the fallback
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const choose = (v: V) => {
    setView(v)
    try { localStorage.setItem(key, v) } catch { /* not remembered */ }
  }
  return [view, choose]
}

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; /** Asks again with this label before running. */ confirm?: string }

/** A "⋯" button that opens a small menu of actions for one row or card. */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [arming, setArming] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) { setOpen(false); setArming(null) }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => { setOpen(!open); setArming(null) }} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        className="rounded p-2 text-gray-400 hover:bg-white/[0.05] hover:text-white">
        <MoreIcon size={20} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 min-w-44 rounded-md border border-gray-800 bg-gray-900 py-1 shadow-lg shadow-black/40">
          {items.map(item => (
            <button key={item.label} role="menuitem"
              onClick={() => {
                if (item.confirm && arming !== item.label) { setArming(item.label); return }
                setOpen(false)
                setArming(null)
                item.onSelect()
              }}
              className={`block w-full px-3 py-2 text-left text-sm hover:bg-white/[0.05] ${item.danger ? 'text-red-400' : 'text-gray-200'}`}>
              {item.confirm && arming === item.label ? item.confirm : item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** What a list shows before it has anything in it. */
export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-gray-800 px-6 py-16 text-center">
      <span className="mb-4 text-gray-600">{icon}</span>
      <p className="text-lg font-medium">{title}</p>
      <p className={`mt-1 text-sm text-gray-400 ${action ? 'mb-6' : ''}`}>{body}</p>
      {action}
    </div>
  )
}

/** A description, or (for those who can edit it) an "Add description" action that edits in place. */
export function InlineDescription({ value, canEdit, onSave, label, placeholder, spacing = 'mt-3' }: { value?: string | null; canEdit: boolean; onSave: (description: string) => Promise<void>; label: string; placeholder: string; spacing?: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (editing) {
    const save = async (e: React.FormEvent) => {
      e.preventDefault()
      setSaving(true)
      setError(null)
      try {
        await onSave(draft.trim())
        setEditing(false)
      } catch {
        setError("Couldn't save the description")
      } finally {
        setSaving(false)
      }
    }
    return (
      <form onSubmit={save} className={spacing}>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} autoFocus maxLength={500}
          aria-label={label} placeholder={placeholder}
          className="w-full resize-none rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-400" />
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
        <div className="mt-2 flex gap-2">
          <button type="submit" disabled={saving} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => setEditing(false)} className="rounded-md bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700">Cancel</button>
        </div>
      </form>
    )
  }
  if (value) {
    return (
      <p className={`group ${spacing} line-clamp-2 text-sm text-gray-400`}>
        {value}
        {canEdit && (
          <button onClick={() => { setDraft(value); setEditing(true) }} aria-label="Edit description"
            className="ml-2 inline-flex align-middle text-gray-600 opacity-0 hover:text-white group-hover:opacity-100 focus:opacity-100">
            <PencilIcon size={14} />
          </button>
        )}
      </p>
    )
  }
  if (!canEdit) return <p className={`${spacing} text-sm text-gray-500`}>No description</p>
  return (
    <button onClick={() => { setDraft(''); setEditing(true) }} className={`${spacing} flex items-center gap-2 text-sm text-gray-400 hover:text-white`}>
      <PencilIcon size={16} /> Add description
    </button>
  )
}

/** Pulsing placeholder blocks while something loads. Pages use the default; sections inside a page pass fewer, shorter rows. */
export function Skeleton({ rows = 3, className = 'h-20' }: { rows?: number; className?: string }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className={`animate-pulse rounded-lg border border-gray-800 bg-gray-900 ${className}`} />
      ))}
    </div>
  )
}

/** A button that asks inline before it acts: the prompt says what will happen, then Confirm or Cancel. */
export function ConfirmAction({ prompt, confirmLabel = 'Confirm', danger = true, onConfirm, disabled, title, className = '', children }: {
  prompt: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; disabled?: boolean; title?: string; className?: string; children: ReactNode
}) {
  const [asking, setAsking] = useState(false)
  if (asking) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-sm" role="alertdialog" aria-label={prompt}>
        <span className="text-gray-300">{prompt}</span>
        <button type="button" autoFocus onClick={() => { setAsking(false); onConfirm() }}
          className={`rounded-md px-3 py-1.5 text-xs font-medium text-white ${danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-700'}`}>
          {confirmLabel}
        </button>
        <button type="button" onClick={() => setAsking(false)} className="rounded-md bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700">Cancel</button>
      </span>
    )
  }
  return <button type="button" disabled={disabled} title={title} onClick={() => setAsking(true)} className={className}>{children}</button>
}
