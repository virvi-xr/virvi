'use client'
import { useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { otherDecision, privacyChoiceLabel, setPrivacyStatus, usePrivacyStatus } from '@/lib/privacy'

/**
 * Privacy (GDPR notice): the account's choice on browser error reporting, from the dashboard notice, and changing it.
 * Each change is recorded as a new decision. Only for the accounts the notice asks.
 */
export function PrivacySetting() {
  const api = useApi()
  const { user, scenePass } = useAuth()
  const userId = user?.id && !user.trial && !scenePass ? user.id : null
  const status = usePrivacyStatus(userId, () => api.getPrivacyStatus())
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!userId) return null
  const next = otherDecision(status?.decision ?? null)
  const change = async () => {
    setSaving(true)
    setFailed(false)
    try { setPrivacyStatus(userId, await api.decidePrivacy(next, 'settings')) } catch { setFailed(true) } finally { setSaving(false) }
  }
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-gray-300">Privacy</h3>
          <p className="mt-1 text-sm text-gray-500">
            With your OK, Virvi records errors in your browser and the pages you visited just before them, to fix bugs faster.
            Your account details and what you build are stored either way, to run the service (see the{' '}
            <a href="/privacy/" target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-gray-300">Privacy Policy</a>).
          </p>
          <p className="mt-2 text-sm text-gray-300">{privacyChoiceLabel(status)}</p>
          {failed && <p className="mt-2 text-xs text-red-400">That didn't save. Try again in a moment.</p>}
        </div>
        <button type="button" disabled={!status || saving} onClick={change}
          className="mt-1 shrink-0 rounded-md border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:border-gray-500 disabled:opacity-50">
          {saving ? '...' : next === 'accept' ? 'Allow' : 'Turn off'}
        </button>
      </div>
    </div>
  )
}
