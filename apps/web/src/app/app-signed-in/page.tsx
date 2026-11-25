import type { Metadata } from 'next'
import { APP_SIGNED_IN_MESSAGE } from '@/lib/app-sign-in'

// The address carries a one-time sign-in code: never pass it on as a Referer
export const metadata: Metadata = { title: 'Signed in', referrer: 'no-referrer', robots: { index: false } }

/** Where the Virvi app's sign-in lands. The app claims this address, so it normally opens straight away; this page only
 *  shows when it didn't. It never shows or uses the code in the address. */
export default function AppSignedInPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <div className="w-full rounded-xl border border-gray-800 bg-gray-900 p-6 text-center">
        <h1 className="mb-2 text-lg font-semibold text-gray-100">You&apos;re signed in</h1>
        <p className="text-sm text-gray-300">{APP_SIGNED_IN_MESSAGE}</p>
      </div>
    </main>
  )
}
