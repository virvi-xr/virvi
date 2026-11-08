'use client'
import { CrashScreen } from '@/components/CrashScreen'

/** This section's crash screen (LIV-66): Try again and Report. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <CrashScreen error={error} reset={reset} />
}
