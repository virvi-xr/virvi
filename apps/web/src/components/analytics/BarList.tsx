import { barLabel, topWithOther } from '@/lib/analytics/breakdown'
import { compact, full } from './format'

export function BarList({ title, counts, labels }: { title: string; counts: Record<string, number>; labels?: Record<string, string> }) {
  const rows = topWithOther(counts)
  const max = Math.max(0, ...rows.map((r) => r.value))
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-gray-300">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">None yet</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key} title={`${barLabel(r.key, labels)}${barLabel(r.key, labels) === r.key ? '' : ` (${r.key})`}: ${full(r.value)}`}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate text-gray-100">{barLabel(r.key, labels)}</span>
                <span className="shrink-0 text-gray-400 tabular-nums">{compact(r.value)}</span>
              </div>
              <div className="mt-1 h-2 w-full" aria-hidden="true">
                <div
                  className="h-2 rounded-r"
                  style={{ width: `${max ? Math.max(1, (r.value / max) * 100) : 0}%`, background: 'var(--chart-1)' }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
