'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ConfirmAction } from '@/components/ui'
import { areaFields, areaFromFields, areaLine, blankArea, type AreaFields, type EditArea } from '@/lib/edit-areas'

type Role = 'cohost' | 'editor' | 'viewer'
const LABEL: Record<Role, string> = { cohost: 'Co-host', editor: 'Editor', viewer: 'Viewer' }
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const ERRORS: Record<string, string> = {
  Forbidden: 'Only the host and co-hosts can manage roles.',
  is_host: 'That wallet is the host.',
  not_a_signed_in_cohost: 'They need to sign in to Virvi with that wallet before they can become host.',
  host_has_no_wallet: 'Link your wallet in Settings before transferring host.',
}
const friendly = (err: any): string => ERRORS[err?.message] ?? err?.message ?? 'Something went wrong'

const AXES: Array<[keyof AreaFields, string]> = [['minX', 'Min x'], ['maxX', 'Max x'], ['minZ', 'Min z'], ['maxZ', 'Max z']]

/** The four bounds of an editor's area, in metres in the scene's coordinates (LIV-32). */
function AreaInputs({ value, onChange, label }: { value: AreaFields; onChange: (v: AreaFields) => void; label: string }) {
  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="sr-only">{label}</legend>
      {AXES.map(([k, name]) => (
        <label key={k} className="flex items-center gap-1 text-xs text-gray-400">
          {name}
          <input type="number" step="any" inputMode="decimal" value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value })}
            className="w-20 rounded bg-gray-950 px-2 py-1 text-xs text-white border border-gray-700" />
        </label>
      ))}
    </fieldset>
  )
}

/** Host and co-hosts manage who can run this scene. Roles go to wallet addresses. */
export function SceneRoles({ sceneId }: { sceneId: string }) {
  const { token, user } = useAuth()
  const api = useApi()
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getSceneRoles>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wallet, setWallet] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [busy, setBusy] = useState(false)
  /** Add form: limit the new editor to an area */
  const [limited, setLimited] = useState(false)
  const [newArea, setNewArea] = useState<AreaFields>(blankArea())
  /** The editor whose area is being set, and the fields */
  const [areaFor, setAreaFor] = useState<string | null>(null)
  const [areaEdit, setAreaEdit] = useState<AreaFields>(blankArea())

  const load = async () => {
    try {
      setData(await api.getSceneRoles(sceneId))
      setError(null)
    } catch (err: any) {
      setError(friendly(err))
    }
  }
  // useApi() returns new functions every render; reload when the scene or session changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [sceneId, token])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn(); await load() } catch (err: any) { setError(friendly(err)) } finally { setBusy(false) }
  }
  const isHost = !!data && data.host.userId === user?.id

  const saveArea = (wallet: string, fields: AreaFields) => {
    const a = areaFromFields(fields)
    if (!a.ok) return setError(a.error)
    run(async () => { await api.addSceneRole(sceneId, wallet, 'editor', a.value); setAreaFor(null) })
  }
  const openArea = (wallet: string, area: EditArea | null) => {
    setAreaFor(areaFor === wallet ? null : wallet)
    setAreaEdit(area ? areaFields(area) : blankArea())
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h2 className="text-sm font-medium text-gray-300 mb-1">Roles</h2>
      <p className="text-xs text-gray-400 mb-4">Co-hosts can do everything except change the host or delete the scene. Editors manage content, everywhere or only inside an area you set (for tenants). Viewers see analytics. <a href="/docs/dashboard/roles-and-permissions/" className="text-blue-400 underline underline-offset-2 hover:text-blue-300">What each role can do</a></p>
      {error && <div className="mb-3 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>}
      {data && (
        <>
          <ul className="mb-4 space-y-2">
            <li className="flex items-center justify-between rounded-md bg-gray-800 px-4 py-2 text-sm">
              <span className="text-gray-200">{data.host.displayName || (data.host.wallets[0] ? short(data.host.wallets[0]) : 'Host')}</span>
              <span className="text-xs text-orange-400">Host</span>
            </li>
            {data.roles.map((r) => (
              <li key={r.wallet} className="rounded-md bg-gray-800 px-4 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="block font-mono text-gray-200" title={r.wallet}>{r.displayName || short(r.wallet)}</span>
                  {r.role === 'editor' && r.area && <span className="block text-xs text-gray-400">{areaLine(r.area)}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <select aria-label={`Role for ${r.displayName || short(r.wallet)}`} value={r.role} disabled={busy} onChange={(e) => run(() => api.addSceneRole(sceneId, r.wallet, e.target.value as Role))}
                    className="rounded bg-gray-700 px-2 py-1 text-xs text-white">
                    {(Object.keys(LABEL) as Role[]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}
                  </select>
                  {isHost && r.role === 'cohost' && r.userId && (
                    <ConfirmAction disabled={busy} danger={false} confirmLabel="Make host"
                      prompt={`Make ${r.displayName || short(r.wallet)} the host? You'll become a co-host.`}
                      onConfirm={() => run(() => api.transferHost(sceneId, r.wallet))}
                      className="text-xs text-orange-400 hover:underline">Make host</ConfirmAction>
                  )}
                  {r.role === 'editor' && (
                    <button type="button" disabled={busy} onClick={() => openArea(r.wallet, r.area)} aria-expanded={areaFor === r.wallet}
                      className="text-xs text-blue-400 underline underline-offset-2 hover:text-blue-300">{r.area ? 'Change area' : 'Limit to an area'}</button>
                  )}
                  <button disabled={busy} onClick={() => run(() => api.removeSceneRole(sceneId, r.wallet))} className="text-xs text-red-400 hover:underline">Remove</button>
                </span>
              </div>
              {areaFor === r.wallet && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <AreaInputs label={`Area for ${r.displayName || short(r.wallet)}`} value={areaEdit} onChange={setAreaEdit} />
                  <button type="button" disabled={busy} onClick={() => saveArea(r.wallet, areaEdit)} className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium hover:bg-blue-700 disabled:opacity-50">Save area</button>
                  {r.area && (
                    <button type="button" disabled={busy} onClick={() => run(async () => { await api.addSceneRole(sceneId, r.wallet, 'editor', null); setAreaFor(null) })}
                      className="text-xs text-gray-300 hover:underline">Edit everywhere</button>
                  )}
                </div>
              )}
              </li>
            ))}
          </ul>
          <form className="flex flex-wrap gap-2" onSubmit={(e) => {
            e.preventDefault()
            const a = role === 'editor' && limited ? areaFromFields(newArea) : null
            if (a && !a.ok) return setError(a.error)
            run(async () => { await api.addSceneRole(sceneId, wallet.trim(), role, a ? a.value : undefined); setWallet(''); setLimited(false); setNewArea(blankArea()) })
          }}>
            <input aria-label="Wallet address (0x…)" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Wallet address (0x…)" pattern="^0x[0-9a-fA-F]{40}$" required
              className="flex-1 rounded-md bg-gray-950 px-4 py-2 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} className="rounded-md bg-gray-800 px-3 py-2 text-sm text-white">
              {(Object.keys(LABEL) as Role[]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}
            </select>
            <button type="submit" disabled={busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">Add</button>
            {role === 'editor' && (
              <div className="basis-full space-y-2">
                <label className="flex items-center gap-2 text-xs text-gray-300">
                  <input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} />
                  Only inside an area (x and z in metres, as positions in the editor)
                </label>
                {limited && <AreaInputs label="Area for the new editor" value={newArea} onChange={setNewArea} />}
              </div>
            )}
          </form>
        </>
      )}
    </div>
  )
}
