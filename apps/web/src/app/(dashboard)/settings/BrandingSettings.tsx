'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { brandingFileProblem, fileToBase64 } from '@/lib/branding'
import { refreshInstance, useInstance } from '@/lib/instance'

const INPUT = 'w-full rounded-md border border-gray-800 bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400'
const FILE = 'block w-full text-sm text-gray-400 file:mr-3 file:rounded-md file:border-0 file:bg-gray-800 file:px-3 file:py-1.5 file:text-sm file:text-gray-200 hover:file:bg-gray-700'

/** A picked file and its preview URL; `null` file = remove the saved one; undefined = unchanged. */
type FilePick = { file: File | null; preview: string | null } | undefined

/** Settings → Branding (LIV-80): a self-hosted install's own logo, name and favicon. Instance admins only. */
export function BrandingSettings() {
  const api = useApi()
  const instance = useInstance()
  const [name, setName] = useState('')
  const [logo, setLogo] = useState<FilePick>(undefined)
  const [favicon, setFavicon] = useState<FilePick>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => { setName(instance?.name ?? '') }, [instance?.name])
  useEffect(() => () => { if (logo?.preview) URL.revokeObjectURL(logo.preview) }, [logo])
  useEffect(() => () => { if (favicon?.preview) URL.revokeObjectURL(favicon.preview) }, [favicon])

  const pick = (kind: 'logo' | 'favicon', set: (p: FilePick) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const problem = brandingFileProblem(file, kind)
    if (problem) { setMessage({ tone: 'error', text: problem }); return }
    setMessage(null)
    set({ file, preview: URL.createObjectURL(file) })
  }

  const shownLogo = logo === undefined ? instance?.logoUrl ?? null : logo.preview
  const shownFavicon = favicon === undefined ? instance?.faviconUrl ?? null : favicon.preview
  const nameChanged = name.trim() !== (instance?.name ?? '')
  const dirty = nameChanged || logo !== undefined || favicon !== undefined

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      await api.updateBranding({
        ...(nameChanged ? { name: name.trim() || null } : {}),
        ...(logo !== undefined ? { logo: logo.file ? await fileToBase64(logo.file) : null } : {}),
        ...(favicon !== undefined ? { favicon: favicon.file ? await fileToBase64(favicon.file) : null } : {}),
      })
      setLogo(undefined)
      setFavicon(undefined)
      refreshInstance()
      setMessage({ tone: 'ok', text: 'Branding saved.' })
    } catch (e: any) {
      setMessage({ tone: 'error', text: e?.body?.message || e?.message || 'Could not save branding.' })
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    setBusy(true)
    setMessage(null)
    try {
      await api.resetBranding()
      setLogo(undefined)
      setFavicon(undefined)
      setConfirmReset(false)
      refreshInstance()
      setMessage({ tone: 'ok', text: 'Back to the Virvi look.' })
    } catch (e: any) {
      setMessage({ tone: 'error', text: e?.body?.message || e?.message || 'Could not reset branding.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10">
      <h2 className="mb-1 text-lg font-semibold">Branding</h2>
      <p className="mb-4 text-sm text-gray-400">Your logo and name in the sidebar, on the sign-in page and in the browser tab. &quot;Powered by Virvi&quot; stays under your logo.</p>
      <div className="space-y-6 rounded-lg border border-gray-800 bg-gray-900 p-6">
        <div>
          <label htmlFor="brand-name" className="mb-2 block text-sm font-medium text-gray-300">Name <span className="text-gray-500">(optional)</span></label>
          <input id="brand-name" type="text" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Events" className={INPUT} />
          <p className="mt-1 text-xs text-gray-500">Up to 32 characters. Used in the browser tab and as the logo&apos;s alt text.</p>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-gray-300">Logo</p>
          <div className="mb-3 flex h-16 w-48 items-center justify-center rounded-md border border-dashed border-gray-700 bg-gray-950 px-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {shownLogo ? <img src={shownLogo} alt="Logo preview" className="max-h-10 max-w-[160px] object-contain" /> : <span className="text-xl font-bold text-white">Virvi</span>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input type="file" accept="image/png,image/webp,image/svg+xml" onChange={pick('logo', setLogo)} className={FILE} aria-label="Upload a logo" />
            {shownLogo && <button type="button" onClick={() => setLogo({ file: null, preview: null })} className="text-sm text-gray-400 hover:text-white">Remove logo</button>}
          </div>
          <p className="mt-1 text-xs text-gray-500">PNG, WebP or SVG, up to 512 KB. Shown at up to 160 × 40 px.</p>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-gray-300">Favicon <span className="text-gray-500">(optional)</span></p>
          <div className="flex flex-wrap items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {shownFavicon && <img src={shownFavicon} alt="Favicon preview" className="h-8 w-8 rounded" />}
            <input type="file" accept="image/png" onChange={pick('favicon', setFavicon)} className={FILE} aria-label="Upload a favicon" />
            {shownFavicon && <button type="button" onClick={() => setFavicon({ file: null, preview: null })} className="text-sm text-gray-400 hover:text-white">Remove favicon</button>}
          </div>
          <p className="mt-1 text-xs text-gray-500">A square PNG, at least 64 × 64 px.</p>
        </div>

        {message && <p role={message.tone === 'error' ? 'alert' : 'status'} className={`text-sm ${message.tone === 'error' ? 'text-red-400' : 'text-green-400'}`}>{message.text}</p>}

        <div className="flex flex-wrap items-center gap-3 border-t border-gray-800 pt-4">
          <button type="button" onClick={save} disabled={!dirty || busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium transition-colors hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save branding'}
          </button>
          {confirmReset ? (
            <span className="flex items-center gap-2 text-sm text-gray-300">
              Remove your logo, name and favicon?
              <button type="button" onClick={reset} disabled={busy} className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium hover:bg-red-700 disabled:opacity-50">Reset</button>
              <button type="button" onClick={() => setConfirmReset(false)} className="text-gray-400 hover:text-white">Cancel</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmReset(true)} disabled={busy} className="rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-gray-500 hover:text-white">Reset to Virvi</button>
          )}
        </div>
      </div>
    </section>
  )
}
