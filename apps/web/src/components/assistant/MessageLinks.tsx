import type { AssistantMessageView } from '@virvixr/shared'

/** A reply's links: one button each, with the link's `detail` (a Finalize total, why prompts ran out) under it. */
export function MessageLinks({ links, onOpen }: { links: AssistantMessageView['links']; onOpen: (href: string) => void }) {
  if (links.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((l) => (
        <div key={l.href + l.label} className={l.detail ? 'w-full' : ''}>
          <button type="button" onClick={() => onOpen(l.href)} className="rounded border border-gray-700 px-2.5 py-1 text-xs text-blue-400 underline hover:text-blue-300">{l.label}</button>
          {l.detail && <p className="mt-1 text-xs text-gray-400">{l.detail}</p>}
        </div>
      ))}
    </div>
  )
}
