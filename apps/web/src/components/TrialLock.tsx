'use client'
// A part of a page a trial can't use: a lock, what it is, and the sign-up sheet on click. Its data is never fetched.
import { LockIcon } from '@/components/icons'
import { openSignUp } from '@/lib/trial'
import { sceneLockRequest, TRIAL_LOCK_LABELS } from '@/lib/trial-scene'

export function askSceneSignUp(tab: string, label: string) {
  openSignUp(sceneLockRequest(tab, label)).catch(() => {})
}

/** A locked section: shown where the account-only one would be. */
export function LockedSection({ tab, label, detail }: { tab: string; label: string; detail?: string }) {
  return (
    <button type="button" onClick={() => askSceneSignUp(tab, label)}
      className="flex w-full items-center gap-3 rounded-lg border border-dashed border-gray-800 bg-gray-900/60 px-4 py-3 text-left text-sm text-gray-400 hover:border-gray-700 hover:text-gray-200">
      <span className="text-gray-500"><LockIcon size={16} /></span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-gray-300">{label}</span>
        <span className="block text-xs text-gray-500">{detail ?? 'This needs a free account.'}</span>
      </span>
      <span className="shrink-0 text-xs text-blue-300">Sign up</span>
    </button>
  )
}

/** A locked button in place of an account-only one (Upload, Media Library): a lock, its own text, the sheet on click. */
export function LockedButton({ tab, children, className }: { tab: keyof typeof TRIAL_LOCK_LABELS; children: React.ReactNode; className: string }) {
  return (
    <button type="button" onClick={() => askSceneSignUp(tab, TRIAL_LOCK_LABELS[tab])} className={`${className} inline-flex items-center gap-1.5`}>
      <LockIcon size={13} /> {children}<span className="sr-only">(needs a free account)</span>
    </button>
  )
}
