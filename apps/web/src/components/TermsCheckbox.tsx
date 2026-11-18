'use client'

/** The sign-up forms' required "I agree to the Terms" box. The links open in a new tab so the form keeps what was typed. */
export function TermsCheckbox({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  const link = 'text-blue-400 hover:underline'
  return (
    <label className="flex items-start gap-2 text-sm text-gray-400">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} required
        aria-label="I agree to the Terms of Service and the Privacy Policy" className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600" />
      <span>
        I agree to the <a href="/terms/" target="_blank" rel="noopener" className={link}>Terms of Service</a> and the{' '}
        <a href="/privacy/" target="_blank" rel="noopener" className={link}>Privacy Policy</a>.
      </span>
    </label>
  )
}
