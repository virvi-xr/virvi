'use client'
import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/lib/auth'
import { reporter } from '@/lib/errors/reporter'

/** Starts error reporting (LIV-66) once, keeps its bearer current and records each page visited. Renders nothing. */
export function ErrorReporting() {
  const { token } = useAuth()
  const tokenRef = useRef(token)
  tokenRef.current = token
  const pathname = usePathname()
  useEffect(() => {
    reporter.setToken(() => tokenRef.current)
    reporter.install()
  }, [])
  useEffect(() => {
    if (pathname) reporter.nav(pathname)
  }, [pathname])
  return null
}
