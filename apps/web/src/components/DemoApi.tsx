'use client'
import { useMemo, type ReactNode } from 'react'
import { DemoApiContext } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { createDemoApi } from '@/lib/demo/store'
import { openSignUp } from '@/lib/trial'

export const DEMO_BANNER = 'Demo with sample data. Changes stay in this browser and are never sent anywhere.'

/**
 * The guest demos (`/demo/*`): the real pages render inside this, and `useApi()` answers from sample data kept in this
 * browser. Anything the demo doesn't do is refused without a request, and a trial gets the sign-up sheet for it.
 */
export function DemoApiProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const owner = user?.id ?? 'guest'
  const trial = !!user?.trial
  const value = useMemo(() => {
    let storage: Storage | undefined
    try { storage = typeof window === 'undefined' ? undefined : window.localStorage } catch {}
    return {
      api: createDemoApi({ trialId: owner, now: () => Date.now(), storage }),
      onRefused: (action: string) => { if (trial) openSignUp({ action, ctx: {} }).catch(() => {}) },
    }
  }, [owner, trial])
  return (
    <DemoApiContext.Provider value={value}>
      <p role="note" className="mx-auto mb-4 max-w-7xl rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-sm text-blue-100">
        {DEMO_BANNER}
      </p>
      {children}
    </DemoApiContext.Provider>
  )
}
