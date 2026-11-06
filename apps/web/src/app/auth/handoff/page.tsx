'use client'
import { useEffect, useRef, useState } from 'react'
import { API_URL } from '@/lib/config'
import { runHandoff, type AccountLabel } from '@/lib/handoff'

type Choice = { them: AccountLabel; stored: AccountLabel; resolve: (pick: 'them' | 'stay') => void }

/** The proof (full wallet or masked email) on its own line in monospace, first; the free-text name after it, plainly. */
function Account({ a }: { a: AccountLabel }) {
  return (
    <span className="block">
      <span className={a.kind === 'none' ? 'block' : 'block break-all font-mono text-sm text-white'}>{a.id}</span>
      {a.name && <span className="block text-sm text-gray-400">{a.name}</span>}
    </span>
  )
}

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
          <div className="text-gray-200">
            <p>This link signs you in as:</p>
            <div className="mt-2 rounded-lg border border-gray-700 px-3 py-2"><Account a={choice.them} /></div>
          </div>
          <div className="flex flex-col gap-2">
            <button type="button" className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700" onClick={() => pick('them')}>
              Continue as them
            </button>
            <button type="button" className="w-full rounded-lg border border-gray-600 px-4 py-2 font-medium text-gray-200 hover:bg-gray-800" onClick={() => pick('stay')}>
              <span className="block">Stay signed in as</span>
              <Account a={choice.stored} />
            </button>
          </div>
        </div>
      ) : (
        <p className="text-gray-400">Signing you in...</p>
      )}
    </div>
  )
}
