'use client'
import { useEffect, useState } from 'react'
import { useApi } from './api'
import { useAuth } from './auth'
import type { BeatAvailability } from './beats'

// One probe per page load, as the studio's: BEATs are on, off, or (for a failed probe) treated as off
let known: BeatAvailability | null = null
let probe: Promise<BeatAvailability> | null = null
const OFF: BeatAvailability = { enabled: false, chain: 'polygon-amoy', test: true, canCreate: false }

/**
 * The server's BEAT availability: null until it answers. A trial or a scene pass never probes (the route is account-only,
 * and a trial would be asked to sign up), so it reads as off for them.
 */
export function useBeatAvailability(): BeatAvailability | null {
  const { token, scenePass, user } = useAuth()
  const trial = !!user?.trial
  const api = useApi()
  const [a, setA] = useState<BeatAvailability | null>(known)
  useEffect(() => {
    if (!token) return
    if (scenePass || trial) { setA(OFF); return }
    if (known) { setA(known); return }
    let cancelled = false
    probe ??= api.getBeatAvailability().catch(() => OFF).then((v) => { known = v; return v })
    probe.then((v) => { if (!cancelled) setA(v) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, scenePass, trial])
  return a
}
