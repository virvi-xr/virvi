'use client'
import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { reporter } from '@/lib/errors/reporter'
import { reportingModeFor } from '@/lib/errors/consent'
import { usePrivacyStatus } from '@/lib/privacy'

/**
 * Starts error reporting (LIV-66) once, keeps its bearer current and records each page visited. Renders nothing.
 * Reporting follows the account's privacy decision (GDPR notice): it holds everything until the account decides, and
 * records nothing for an account that declined. Accounts the notice doesn't ask (signed out, trials, scene passes)
 * report as before.
 */
export function ErrorReporting() {
  const { token, user, loading, scenePass } = useAuth()
  const api = useApi()
  const tokenRef = useRef(token)
  tokenRef.current = token
  const pathname = usePathname()
  const asked = !!user?.id && !user.trial && !scenePass
  const status = usePrivacyStatus(asked ? user!.id : null, () => api.getPrivacyStatus())
  const mode = reportingModeFor({ authLoading: loading, signedIn: !!user?.id, asked, status })
  // Effects run in order: the mode is set before a page is recorded
  useEffect(() => { reporter.setMode(mode) }, [mode])
  useEffect(() => {
    reporter.setToken(() => tokenRef.current)
    reporter.install()
  }, [])
  useEffect(() => {
    if (pathname) reporter.nav(pathname)
  }, [pathname])
  return null
}
