'use client'
/** Pages that moved: their old address forwards to the new one, keeping the query and the hash. */
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/** The new address for a moved page: `to` plus the old `search` and `hash` (with or without their `?`/`#`). */
export function movedHref(to: string, search: string, hash: string): string {
  const q = search.replace(/^\?/, '')
  const h = hash.replace(/^#/, '')
  return to + (q ? `?${q}` : '') + (h ? `#${h}` : '')
}

/** On mount, replace the current address with `to`, keeping its query and hash. */
export function useMovedTo(to: string): void {
  const router = useRouter()
  useEffect(() => {
    router.replace(movedHref(to, window.location.search, window.location.hash))
  }, [router, to])
}
