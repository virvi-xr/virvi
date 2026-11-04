'use client'
import { useState } from 'react'
import { instanceLabel, instanceTooltip, SELF_HOSTING_DOCS_URL, useInstance } from '@/lib/instance'
import { hasCustomBrand } from '@/lib/branding'

/**
 * A quiet "Self-hosted" / "Self-hosted · Scalable" label (plus "Powered by Virvi" under a custom brand); nothing on
 * hosted virvi.io. Hover or tap for details.
 */
export function InstanceBadge({ className = '' }: { className?: string }) {
  const info = useInstance()
  const [open, setOpen] = useState(false)
  const label = instanceLabel(info?.mode, hasCustomBrand(info))
  if (!info || !label) return null
  return (
    <span className={`relative inline-flex ${className}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} title={instanceTooltip(info)} aria-expanded={open}
        className="whitespace-nowrap rounded border border-gray-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-400 hover:border-gray-500 hover:text-gray-200">
        {label}
      </button>
      {open && (
        <span role="dialog" aria-label="About this install"
          className="absolute left-0 top-full z-50 mt-1 w-60 rounded-md border border-gray-700 bg-gray-900 p-3 text-xs text-gray-300 shadow-xl">
          {instanceTooltip(info)}.{' '}
          <a href={SELF_HOSTING_DOCS_URL} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">Self-hosting docs</a>
        </span>
      )}
    </span>
  )
}
