'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { fill, formatBytes, METRIC_LABEL, metricLine, overNote, STATE_LABEL, targetLabel, textureMemoryLine, type BudgetState, type SceneHealth as Health } from '@/lib/scene-health'

const TONE: Record<BudgetState, { bar: string; text: string }> = {
  within: { bar: 'bg-emerald-500', text: 'text-emerald-300' },
  close: { bar: 'bg-amber-400', text: 'text-amber-300' },
  over: { bar: 'bg-red-500', text: 'text-red-300' },
}

/** The scene's triangles, entities and size against Decentraland's limits, before deploying (LIV-41). */
export function SceneHealth({ sceneId }: { sceneId: string }) {
  const api = useApi()
  const { token } = useAuth()
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    try { setHealth(await api.getSceneHealth(sceneId)); setError(null) } catch (e: any) {
      setError(e?.message === 'Forbidden' ? 'Only the host, co-hosts and editors can see the scene budget.' : e?.message ?? 'Could not load the scene budget')
    }
  }
  // useApi() returns new functions every render; reload when the scene or session changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [sceneId, token])
  // Models are measured in the background on the first look: check back until they're done
  useEffect(() => {
    if (!health?.measuring) return
    const t = setTimeout(() => load(), 5_000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health])

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Performance</h2>
        <button type="button" onClick={() => load()} className="text-xs text-gray-400 hover:text-gray-200">Refresh</button>
      </div>
      <p className="mb-4 text-xs text-gray-400">The live preset&apos;s models against Decentraland&apos;s limits for where the scene deploys. Over the triangle limit, a scene still deploys but may run slowly; over the others, Decentraland refuses it.</p>
      {error && <div role="alert" className="rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{error}</div>}
      {health && (
        <div className="space-y-6">
          <p className={`text-sm font-medium ${TONE[health.state].text}`}>{STATE_LABEL[health.state]}</p>
          {health.measuring > 0 && <p role="status" className="text-xs text-gray-400">Measuring {health.measuring} {health.measuring === 1 ? 'model' : 'models'}… this updates by itself.</p>}
          {textureMemoryLine(health.textureMemory) && <p className="text-sm text-gray-300">{textureMemoryLine(health.textureMemory)}</p>}
          {health.targets.map((t) => (
            <section key={t.id ?? 'none'} aria-label={targetLabel(t)}>
              <h3 className="mb-2 text-sm text-gray-200">{targetLabel(t)}</h3>
              <ul className="space-y-3">
                {t.metrics.map((m) => (
                  <li key={m.key}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-gray-300">{METRIC_LABEL[m.key]}</span>
                      <span className={TONE[m.state].text}>{metricLine(m)}{m.limit === null && <span className="text-gray-400"> (no fixed limit in a World)</span>}</span>
                    </div>
                    {m.limit !== null && (
                      <div role="progressbar" aria-label={`${METRIC_LABEL[m.key]}: ${metricLine(m)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={fill(m)} className="mt-1 h-1.5 rounded-full bg-gray-800">
                        <div className={`h-full rounded-full ${TONE[m.state].bar}`} style={{ width: `${fill(m)}%` }} />
                      </div>
                    )}
                    {overNote(m) && <p className="mt-1 text-xs text-red-300">{overNote(m)}</p>}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {health.suggestions.length > 0 && (
            <section aria-label="What to do">
              <h3 className="mb-2 text-sm text-gray-200">What to do</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-300">{health.suggestions.map((s) => <li key={s}>{s}</li>)}</ul>
            </section>
          )}

          {(health.byTriangles.length > 0 || health.bySize.length > 0 || health.byTextureMemory.length > 0) && (
            <div className="grid gap-6 sm:grid-cols-3">
              <Top title="Most triangles" rows={health.byTriangles.map((c) => ({ id: c.elementId, name: c.name, value: `${((c.triangles ?? 0) * c.copies).toLocaleString('en-US')}${c.copies > 1 ? ` (${c.copies} copies)` : ''}` }))} />
              <Top title="Largest files" rows={health.bySize.map((c) => ({ id: c.elementId || c.name, name: c.name, value: formatBytes(c.bytes ?? 0) }))} />
              <Top title="Most texture memory" rows={health.byTextureMemory.map((c) => ({ id: c.elementId, name: c.name, value: `${formatBytes(c.textureBytes ?? 0)}${c.maxTexturePx ? ` (${c.maxTexturePx} px)` : ''}` }))} />
            </div>
          )}
          {health.unmeasured > 0 && (
            <p className="text-xs text-gray-400">{health.unmeasured} {health.unmeasured === 1 ? "model hasn't" : "models haven't"} been measured yet and {health.unmeasured === 1 ? 'counts' : 'count'} as 0 here.</p>
          )}
        </div>
      )}
    </div>
  )
}

function Top({ title, rows }: { title: string; rows: { id: string; name: string; value: string }[] }) {
  if (!rows.length) return null
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-sm text-gray-200">{title}</h3>
      <ol className="space-y-1 text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex justify-between gap-3"><span className="truncate text-gray-300">{r.name}</span><span className="shrink-0 text-gray-400">{r.value}</span></li>
        ))}
      </ol>
    </section>
  )
}
