'use client'
import { useEffect, useRef } from 'react'
import { TRY_NOTE, TRY_OPTIONS } from '@/lib/try-options'

/** "Try now" from the header: pick the Design Studio or the scene builder, both open without an account. */
export function TryNowModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const firstRef = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    if (!open) return
    firstRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="try-now-title"
        className="relative corner-notch max-h-full w-full max-w-2xl overflow-y-auto rounded-xl border border-blue-700 bg-gray-900 p-6 sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={onClose} aria-label="Close" className="absolute right-4 top-4 text-gray-500 hover:text-white">✕</button>
        <p className="mb-2 text-sm font-medium text-blue-300">No account needed</p>
        <h2 id="try-now-title" className="mb-6 text-2xl font-bold text-white">What do you want to try?</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {TRY_OPTIONS.map((o, i) => (
            <a
              key={o.key}
              ref={i === 0 ? firstRef : undefined}
              href={o.href}
              className="group flex flex-col rounded-lg border border-gray-700 bg-gray-950 p-5 hover:border-blue-500 hover:bg-gray-900 focus-visible:border-blue-400 focus-visible:outline-none"
            >
              <span className="text-lg font-semibold text-white">{o.title}</span>
              <span className="mt-2 flex-1 text-sm leading-relaxed text-gray-400">{o.blurb}</span>
              <span className="mt-4 text-sm font-semibold text-blue-300 group-hover:text-blue-200">{o.cta} →</span>
            </a>
          ))}
        </div>
        <p className="mt-5 text-xs text-gray-500">{TRY_NOTE}</p>
      </div>
    </div>
  )
}
