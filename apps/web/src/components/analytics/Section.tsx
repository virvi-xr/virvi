import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui'

export type SectionState = 'loading' | 'error' | 'empty' | 'ready'

export function Section({ title, action, state, onRetry, children }: {
  title: string
  action?: ReactNode
  state: SectionState
  onRetry: () => void
  children?: ReactNode
}) {
  return (
    <section className="rounded-lg border border-gray-800 bg-gray-900 p-4" aria-busy={state === 'loading'}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {state === 'loading' && <Skeleton rows={2} className="h-12" />}
      {state === 'error' && (
        <p className="text-sm text-gray-400" role="alert">
          Couldn&apos;t load —{' '}
          <button type="button" onClick={onRetry} className="text-blue-400 hover:text-blue-300 underline-offset-2 underline underline-offset-2">
            Retry
          </button>
        </p>
      )}
      {state === 'empty' && <p className="text-sm text-gray-400">No visits recorded yet</p>}
      {state === 'ready' && children}
    </section>
  )
}
