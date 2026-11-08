'use client'
import '@/styles/globals.css'
import { CrashScreen } from '@/components/CrashScreen'

/** The crash screen when the root layout itself fails (LIV-66): it replaces the whole page, so it has its own html. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 font-sans text-white antialiased">
        <CrashScreen error={error} reset={reset} fullPage />
      </body>
    </html>
  )
}
