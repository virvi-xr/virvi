import { useEffect, useState } from 'react'
import { API_URL } from './config'

export type InstanceMode = 'single' | 'scalable' | 'cloud'
export interface InstanceInfo {
  mode: InstanceMode
  version: string
  /** A self-hosted install's own name, logo and favicon (LIV-80); always null on hosted virvi.io. */
  name?: string | null
  logoUrl?: string | null
  faviconUrl?: string | null
}

/** Where self-hosters read about their install. */
export const SELF_HOSTING_DOCS_URL = 'https://github.com/virvi-xr/virvi/blob/main/apps/docs/src/content/docs/self-hosting/overview.md'

/**
 * The label a self-hosted install shows next to the Virvi name; hosted virvi.io (or not known yet) shows none.
 * Under a custom logo or name it also credits Virvi.
 */
export function instanceLabel(mode: InstanceMode | null | undefined, branded = false): string | null {
  const base = mode === 'single' ? 'Self-hosted' : mode === 'scalable' ? 'Self-hosted · Scalable' : null
  return base && branded ? `${base} · Powered by Virvi` : base
}

/** The label's hover text: the mode spelled out and the server version. */
export function instanceTooltip(info: InstanceInfo): string {
  const how = info.mode === 'scalable' ? 'scalable: several servers' : 'single server'
  return `Self-hosted install (${how}), Virvi server ${info.version}`
}

let cached: Promise<InstanceInfo | null> | null = null
const listeners = new Set<(i: InstanceInfo | null) => void>()

/** Fetch again (after branding changes) and update every mounted useInstance(). */
export function refreshInstance(): void {
  cached = null
  void fetchInstance().then((i) => listeners.forEach((l) => l(i)))
}

/** GET /api/instance, once per page load (public, no sign-in). null if the server doesn't answer. */
export function fetchInstance(): Promise<InstanceInfo | null> {
  cached ??= fetch(`${API_URL}/api/instance`)
    .then((r) => (r.ok ? (r.json() as Promise<InstanceInfo>) : null))
    .catch(() => null)
  return cached
}

export function useInstance(): InstanceInfo | null {
  const [info, setInfo] = useState<InstanceInfo | null>(null)
  useEffect(() => {
    let live = true
    void fetchInstance().then((i) => { if (live) setInfo(i) })
    listeners.add(setInfo)
    return () => { live = false; listeners.delete(setInfo) }
  }, [])
  return info
}
