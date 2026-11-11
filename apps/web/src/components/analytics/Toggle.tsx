'use client'

export function Toggle<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap rounded-lg bg-gray-800 p-1">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`rounded-md px-3 py-1 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
            value === v ? 'bg-blue-600 text-white' : 'text-gray-300 hover:text-white'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}
