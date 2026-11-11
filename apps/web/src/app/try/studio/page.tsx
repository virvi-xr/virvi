'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { BrandMark } from '@/components/BrandMark'
import { KindPicker } from '@/components/KindPicker'
import { PrimaryButton } from '@/components/ui'
import { Turnstile, type TurnstileHandle } from '@/components/Turnstile'
import { beginTrial } from '@/lib/trial'
import { keepUnsent, refusalMessage, type StudioKind } from '@/lib/studio'
import { startingAgent } from '@/lib/studio-ratings'

const MAX_PROMPT = 4000
const PLACEHOLDERS: Record<StudioKind, string> = {
  wearable: 'A neon bomber jacket with glowing seams',
  emote: 'A victory dance with a spin and a fist pump',
  scene: 'A small ramen shop with a paper lantern sign',
}

/** The public way in: describe something, and the first prompt starts a trial (no account, no sign-in redirect). */
export default function TryStudioPage() {
  const { user, token, loading, startTrial } = useAuth()
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const router = useRouter()
  const [kind, setKind] = useState<StudioKind>('wearable')
  const [text, setText] = useState('')
  const [botToken, setBotToken] = useState<string | null>(null)
  const turnstile = useRef<TurnstileHandle>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set once the trial session exists: the effect below runs with an api that carries its token
  const [go, setGo] = useState<{ kind: StudioKind; text: string } | null>(null)

  // A signed-in account has the real Studio
  useEffect(() => {
    if (!loading && user && !user.trial) router.replace('/studio')
  }, [loading, user, router])

  useEffect(() => {
    if (!go || !token || !user?.trial) return
    setGo(null)
    ;(async () => {
      try {
        // An admin's default agent for the kind (LIV-142), else Claude Code, as trials always started on
        const defaults = await apiRef.current.getStudioDefaults().then((r) => r.agents).catch(() => null)
        const d = await apiRef.current.createStudioDesign({ kind: go.kind, agent: startingAgent(go.kind, defaults, 'claude') })
        // The design page is one static page for every id, loaded in full (as the Studio's own links do)
        try {
          await apiRef.current.sendStudioPrompt(d.id, { text: go.text })
        } catch (err) {
          // The design exists: go to it (its composer has the prompt again) so a retry doesn't start a second design
          let store: Storage | null = null
          try { store = sessionStorage } catch { /* blocked storage */ }
          keepUnsent(store, d.id, go.text, refusalMessage(err as never, new Date()).text || "Your prompt didn't send. Press Send to try again.")
          window.location.assign(`/studio/${d.id}/`)
          return
        }
        window.location.assign(`/studio/${d.id}/`)
      } catch (err) {
        setError(refusalMessage(err as never, new Date()).text || (err as Error).message)
        setBusy(false)
      }
    })()
  }, [go, token, user?.trial])

  const start = async (e: React.FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t || busy || loading) return
    setBusy(true)
    setError(null)
    const began = await beginTrial({
      signedIn: !!user,
      botToken,
      startTrial,
      // The bot-check token was spent on the refused start: get a fresh one for the retry
      resetBotCheck: () => { setBotToken(null); turnstile.current?.reset() },
    })
    if (began.ok) setGo({ kind, text: t })
    else {
      setError(began.error)
      setBusy(false)
    }
  }

  const needsCheck = !loading && !user
  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <BrandMark href="/" />
          <a href="/signin/" className="text-sm text-gray-400 hover:text-white">Sign in</a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 md:py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Try the Design Studio</h1>
        <p className="mt-3 max-w-xl text-gray-400">
          Describe a wearable, an emote or a building and an agent builds it for Decentraland. No account needed: you get 3 free prompts.
        </p>
        <form onSubmit={start} className="mt-8 space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-4 sm:p-6">
          <fieldset>
            <legend className="mb-2 text-sm text-gray-400">What are you making?</legend>
            <KindPicker value={kind} onChange={setKind} />
          </fieldset>
          <label className="block">
            <span className="mb-2 block text-sm text-gray-400">Describe it</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={MAX_PROMPT} placeholder={PLACEHOLDERS[kind]}
              className="w-full resize-y rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400" />
          </label>
          {needsCheck && <Turnstile onToken={setBotToken} handle={turnstile} />}
          {error && <p className="text-sm text-amber-300" role="alert">{error}</p>}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-gray-500">Your work is kept for 14 days. Create an account any time to save it.</p>
            <PrimaryButton type="submit" disabled={busy || loading || !text.trim() || (needsCheck && botToken === null)}>
              {busy ? 'Starting…' : 'Start'}
            </PrimaryButton>
          </div>
        </form>
      </main>
    </div>
  )
}
