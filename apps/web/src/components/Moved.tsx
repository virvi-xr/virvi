'use client'
import Link from 'next/link'
import { useMovedTo } from '@/lib/redirect'

/** A moved page's old address: forwards to `to` (keeping query and hash), with a link for when that doesn't happen. */
export function Moved({ to, label }: { to: string; label: string }) {
  useMovedTo(to)
  return (
    <p className="p-6 text-sm text-gray-400">
      Moved to <Link href={to} className="text-blue-400 hover:text-blue-300">{label}</Link>.
    </p>
  )
}
