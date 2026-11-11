'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'

/** "Ask me about errors" (LIV-66 §4): the account's switch for the report toast. Errors are still recorded either way. */
export function ErrorPromptSetting() {
  const api = useApi()
  const [ask, setAsk] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { api.getErrorPromptSettings().then((r) => setAsk(r.askAboutErrors), () => setFailed(true)) }, [api])
  const toggle = async () => {
    if (ask === null) return
    setSaving(true)
    setFailed(false)
    try { setAsk((await api.setErrorPromptSettings(!ask)).askAboutErrors) } catch { setFailed(true) } finally { setSaving(false) }
  }
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-gray-300">Ask me about errors</h3>
          <p className="mt-1 text-sm text-gray-500">
            When something you're doing fails and we need more detail, we may ask you what happened, at most once a day.
            Errors are recorded either way. You can always use Report a bug in the menu.
          </p>
          {failed && <p className="mt-2 text-xs text-red-400">That didn't save. Try again in a moment.</p>}
        </div>
        <button type="button" role="switch" aria-checked={!!ask} aria-label="Ask me about errors" disabled={ask === null || saving} onClick={toggle}
          className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${ask ? 'bg-accent' : 'bg-gray-700'}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${ask ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>
    </div>
  )
}
