'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { nextStep, progressLine, showChecklist, stepView, type Onboarding } from '@/lib/onboarding'
import { CheckIcon } from '@/components/icons'

/**
 * The getting-started checklist (LIV-37) at the top of Scenes: four steps from signing up to a live scene, ticked from
 * what the account has done. Hidden once they're all done, or when dismissed; trials and scene passes get none.
 */
export function GettingStarted() {
  const { token } = useAuth()
  const api = useApi()
  const [data, setData] = useState<Onboarding | null>(null)

  useEffect(() => {
    let live = true
    api.getOnboarding().then((d) => { if (live) setData(d) }, () => { if (live) setData(null) })
    return () => { live = false }
    // useApi() returns new functions every render; reload only when the session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  if (!showChecklist(data)) return null
  const next = nextStep(data)
  const dismiss = async () => {
    try { setData(await api.dismissOnboarding(true)) } catch { setData({ ...data, dismissedAt: new Date().toISOString() }) }
  }

  return (
    <section aria-labelledby="getting-started" className="mb-6 rounded-lg border border-blue-500/30 bg-gray-900 p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="getting-started" className="text-base font-semibold text-white">Getting started</h2>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span>{progressLine(data)}</span>
          <button type="button" onClick={dismiss} className="text-gray-300 underline underline-offset-2 hover:text-white">Hide</button>
        </div>
      </div>
      <ol className="grid gap-3 md:grid-cols-4">
        {data.steps.map((s, i) => {
          const v = stepView(s.id, data.sceneId)
          const current = s.id === next
          return (
            <li key={s.id} className={`rounded-md border p-3 text-sm ${current ? 'border-blue-500/60 bg-blue-500/10' : 'border-gray-800 bg-gray-950'}`}>
              <div className="mb-1 flex items-center gap-2">
                <span aria-hidden="true" className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${s.done ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-300'}`}>
                  {s.done ? <CheckIcon size={12} /> : i + 1}
                </span>
                <span className={s.done ? 'text-gray-400 line-through' : 'font-medium text-gray-100'}>{v.title}</span>
                <span className="sr-only">{s.done ? '(done)' : '(to do)'}</span>
              </div>
              {!s.done && <p className="mb-2 text-xs text-gray-400">{v.body}</p>}
              {!s.done && (
                <div className="flex flex-wrap gap-3 text-xs">
                  {current && <Link href={v.href} className="font-medium text-blue-300 underline underline-offset-2 hover:text-blue-200">{v.action}</Link>}
                  <a href={v.docs} className="text-gray-300 underline underline-offset-2 hover:text-white">How</a>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
