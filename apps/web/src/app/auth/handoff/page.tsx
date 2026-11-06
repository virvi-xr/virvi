'use client'
import { useEffect, useRef, useState } from 'react'
import { API_URL } from '@/lib/config'
import { runHandoff } from '@/lib/handoff'

type Choice = { them: string; stored: string; resolve: (pick: 'them' | 'stay') => void }

export default function HandoffPage() {
  const started = useRef(false)
  const [choice, setChoice] = useState<Choice | null>(null)

  useEffect(() => {
    // Strict mode runs effects twice in dev; a code can only be exchanged once.
    if (started.current) return
    started.current = true
    void runHandoff({
      href: window.location.href,
      replaceUrl: (u) => history.replaceState(null, '', u),
      exchange: (code) =>
        fetch(`${API_URL}/api/auth/handoff/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json() : undefined })),
      saveSession: (s) => localStorage.setItem('virvi_auth', JSON.stringify(s)),
      go: (u) => { window.location.href = u },
      storedSession: () => localStorage.getItem('virvi_auth'),
      // The exchanged session stays inside runHandoff (memory only) until a button is pressed.
      choose: (c) => new Promise((resolve) => setChoice({ ...c, resolve })),
    })
  }, [])

  const pick = (p: 'them' | 'stay') => {
    choice?.resolve(p)
    setChoice(null)
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <meta name="referrer" content="no-referrer" />
      {choice ? (
        <div className="max-w-sm space-y-4 text-center">
          <p className="text-gray-200">This link signs you in as {choice.them}.</p>
          <div className="flex flex-col gap-2">
            <button type="button" className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700" onClick={() => pick('them')}>
              Continue as them
            </button>
            <button type="button" className="w-full rounded-lg border border-gray-600 px-4 py-2 font-medium text-gray-200 hover:bg-gray-800" onClick={() => pick('stay')}>
              Stay signed in as {choice.stored}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-gray-400">Signing you in...</p>
      )}
    </div>
  )
}
