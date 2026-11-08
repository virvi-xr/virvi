'use client'
import { useEffect, useState, type Dispatch } from 'react'
import Link from 'next/link'
import { useApi, type DclWorld, type RoomScanSummary, type WizardOptions } from '@/lib/api'
import { getBrowserWallet, signWalletChallenge, useAuth } from '@/lib/auth'
import { openSignUp } from '@/lib/trial'
import { headsetPairHref } from '@/lib/pairing'
import { wizardErrorMessage } from '@/lib/wizard/run'
import { hostingChoice, normalizeWorldName, plotLabel, shortAddress } from '@/lib/wizard/helpers'
import type { WizardAction, WizardState } from '@/lib/wizard/state'
import { Badge } from '@/components/ui'
import { WorldInUseNotice } from '../WorldInUseNotice'
import { LockIcon } from '@/components/icons'

export type NamesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; wallets: Array<{ address: string; names: DclWorld[] }> }

/** A trial's Decentraland choice: the World is picked at Deploy, when the wallet that owns it is connected. */
export const DCL_LATER_LABEL = "Decentraland World — you'll connect the wallet that owns it when you deploy."

export const CONTRACT_WALLET_MESSAGE =
  "Contract wallets (like Safe) can't sign Decentraland World deploys yet. Connect an ordinary wallet that owns the name."

const inputClass = 'w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400'

export function WhereStep({ state, dispatch, names, reloadNames, options, replaceOk, setReplaceOk, contractBlocked, setContractBlocked }: {
  state: WizardState
  dispatch: Dispatch<WizardAction>
  names: NamesState
  reloadNames: () => void
  options: WizardOptions | null
  replaceOk: boolean
  setReplaceOk: (v: boolean) => void
  contractBlocked: boolean
  setContractBlocked: (v: boolean) => void
}) {
  const api = useApi()
  // A trial looks up no names and links no wallet: it picks "Decentraland World" and connects the wallet at Deploy
  const trial = !!useAuth().user?.trial
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState('')
  const [typed, setTyped] = useState('')
  const [typedBusy, setTypedBusy] = useState(false)
  const [typedError, setTypedError] = useState('')
  const [checking, setChecking] = useState<string | null>(null)
  const [slots, setSlots] = useState<{ used: number; limit: number | null; hostingAvailable: boolean } | null>(null)
  const [scans, setScans] = useState<RoomScanSummary[] | null | 'error'>(null)
  useEffect(() => {
    api.getRoomScans().then((r) => setScans(r.scans)).catch(() => setScans('error'))
  }, [])
  const { dcl, hyperfy, ar } = state.destinations
  const wallets = names.status === 'ready' ? names.wallets : []

  const hyperfyAllowed = !!options?.hyperfy.allowed
  useEffect(() => {
    if (!hyperfy || !hyperfyAllowed || slots || trial) return
    api.getHyperfySlots().then(setSlots).catch(() => setSlots({ used: 0, limit: 0, hostingAvailable: false }))
  }, [hyperfy, hyperfyAllowed, trial])
  // Hosting is account-only: a trial sees it locked, whatever the slots say
  const hosting = hostingChoice(trial, slots)
  const canHost = hosting === 'available'


  const connect = async () => {
    setLinking(true)
    setLinkError('')
    try {
      await api.linkWallet(await signWalletChallenge())
      reloadNames()
    } catch (err) {
      setLinkError(wizardErrorMessage(err))
    }
    setLinking(false)
  }

  const pick = async (world: DclWorld, wallet: string) => {
    setReplaceOk(false)
    setContractBlocked(false)
    setChecking(world.world)
    const provider = getBrowserWallet()
    let contract = false
    if (provider && wallet) {
      try {
        contract = await (await import('@/lib/dcl-sign')).isContractWallet(provider, wallet)
      } catch {
        // The check is a courtesy; Decentraland's own answer comes at deploy.
      }
    }
    setChecking(null)
    if (contract) {
      setContractBlocked(true)
      dispatch({ type: 'setDcl', dcl: null })
      return
    }
    dispatch({ type: 'setDcl', dcl: {
      world: world.world, wallet, hasScene: world.hasScene, footprint: world.footprint, storage: world.storage ?? undefined, connectedScene: world.connectedScene ?? null,
    } })
  }

  /** The World is free now: the replace question comes next, and the list no longer shows it connected. */
  const disconnected = () => {
    if (dcl) dispatch({ type: 'setDcl', dcl: { ...dcl, connectedScene: null } })
    reloadNames()
  }

  const checkTyped = async (e: React.FormEvent) => {
    e.preventDefault()
    const world = normalizeWorldName(typed)
    if (!world) return
    setTypedBusy(true)
    setTypedError('')
    try {
      const found = await api.getDclWorld(world)
      if (!found.owner) {
        setTypedError(`${world} isn't owned by a wallet linked to your account. Connect the wallet that owns it, then try again.`)
      } else {
        // The lookup doesn't say which linked wallet owns it; with one wallet it's that one.
        await pick(found, wallets.length === 1 ? wallets[0].address : '')
        setTyped('')
      }
    } catch (err) {
      setTypedError(wizardErrorMessage(err))
    }
    setTypedBusy(false)
  }

  const listed = wallets.flatMap((w) => w.names.map((n) => ({ ...n, wallet: w.address })))
  const typedPick = dcl && !listed.some((n) => n.world === dcl.world) ? dcl : null

  return (
    <div className="space-y-5">
      <label className="block space-y-1">
        <span className="text-sm font-medium text-gray-200">Scene name</span>
        <input value={state.name} onChange={(e) => dispatch({ type: 'setName', name: e.target.value })}
          placeholder="Name your scene" aria-label="Scene name" required maxLength={120} autoFocus className={inputClass} />
      </label>

      <RoomScanPicker scans={scans} chosen={state.roomSet?.scanId ?? null} dispatch={dispatch} trial={trial} />

      {trial ? (
        <section className="space-y-3 border-t border-gray-800 pt-4">
          <h3 className="text-sm font-medium text-gray-200">Decentraland</h3>
          <label className="flex items-start gap-2 text-sm text-gray-200">
            <input type="checkbox" className="mt-0.5" checked={state.dclLater} onChange={(e) => dispatch({ type: 'setDclLater', on: e.target.checked })} />
            <span>{DCL_LATER_LABEL}</span>
          </label>
        </section>
      ) : (
      <section className="space-y-3 border-t border-gray-800 pt-4">
        <h3 className="text-sm font-medium text-gray-200">Your Decentraland World</h3>
        {state.dclLater && (
          <p className="rounded-md border border-blue-400/40 bg-blue-400/10 px-3 py-2 text-sm text-blue-100">
            You chose Decentraland while trying Virvi: pick the World for this scene below.
            <button type="button" onClick={() => dispatch({ type: 'setDclLater', on: false })} className="ml-2 text-xs text-gray-400 hover:text-white">Skip Decentraland</button>
          </p>
        )}
        {names.status === 'loading' && <p className="text-sm text-gray-500">Looking up your names…</p>}
        {names.status === 'error' && (
          <div className="space-y-2">
            <p className="text-sm text-red-300" role="alert">{names.message}</p>
            <button type="button" onClick={reloadNames} className="text-sm text-blue-400 hover:text-blue-300">Try again</button>
          </div>
        )}
        {names.status === 'ready' && wallets.length === 0 && (
          <div className="space-y-2 rounded-md border border-gray-800 bg-gray-950 p-3">
            <p className="text-sm text-gray-300">Connect the wallet that owns your Decentraland NAME. You sign a message to prove it&apos;s yours; nothing is sent on-chain.</p>
            <button type="button" onClick={connect} disabled={linking}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {linking ? 'Check your wallet…' : 'Connect your wallet'}
            </button>
            {linkError && <p className="text-sm text-red-300" role="alert">{linkError}</p>}
          </div>
        )}
        {names.status === 'ready' && wallets.length > 0 && listed.length === 0 && (
          <p className="text-sm text-gray-400">Your linked wallets don&apos;t own a Decentraland NAME yet. Use an ENS name or another World below, or skip Decentraland and pick Hyperfy or Virvi AR.</p>
        )}
        {listed.length > 0 && (
          <ul className="space-y-2" role="radiogroup" aria-label="Your Worlds">
            {listed.map((n) => {
              const chosen = dcl?.world === n.world
              return (
                <li key={n.world}>
                  <button type="button" role="radio" aria-checked={chosen} onClick={() => (chosen ? dispatch({ type: 'setDcl', dcl: null }) : pick(n, n.wallet))}
                    className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left text-sm ${chosen ? 'border-blue-400 bg-blue-400/10' : 'border-gray-800 bg-gray-950 hover:border-gray-700'}`}>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-white">{n.world}</span>
                      <span className="block font-mono text-xs text-gray-500">{shortAddress(n.wallet)}</span>
                    </span>
                    {checking === n.world ? <span className="text-xs text-gray-500">Checking…</span> : n.hasScene && <Badge tone="warning">has a scene</Badge>}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {typedPick && (
          <p className="rounded-md border border-blue-400 bg-blue-400/10 px-3 py-2.5 text-sm text-white">
            {typedPick.world} {typedPick.hasScene && <Badge tone="warning" className="ml-2">has a scene</Badge>}
            <button type="button" onClick={() => dispatch({ type: 'setDcl', dcl: null })} className="ml-3 text-xs text-gray-400 hover:text-white">Remove</button>
          </p>
        )}
        {names.status === 'ready' && wallets.length > 0 && (
          <details className="text-sm" open={!!typedError}>
            <summary className="cursor-pointer text-gray-400 hover:text-gray-200">Use an ENS name or another World</summary>
            <form onSubmit={checkTyped} className="mt-2 flex gap-2">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="name.dcl.eth or name.eth" aria-label="World name" className={inputClass} />
              <button type="submit" disabled={typedBusy || !typed.trim()} className="shrink-0 rounded-md bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700 disabled:opacity-50">
                {typedBusy ? 'Checking…' : 'Use it'}
              </button>
            </form>
            {typedError && <p className="mt-2 text-sm text-red-300" role="alert">{typedError}</p>}
          </details>
        )}
        {contractBlocked && <p className="rounded-md border border-yellow-700/60 bg-yellow-950/30 px-3 py-2 text-sm text-yellow-200" role="alert">{CONTRACT_WALLET_MESSAGE}</p>}
        {dcl?.connectedScene && <WorldInUseNotice world={dcl.world} connected={dcl.connectedScene} onDisconnected={disconnected} />}
        {dcl?.hasScene && !dcl.connectedScene && (
          <div className="space-y-2 rounded-md border border-yellow-700/60 bg-yellow-950/30 px-3 py-2.5 text-sm text-yellow-100">
            <p>Your World already has a scene on {dcl.footprint?.parcels.length ?? 1} {(dcl.footprint?.parcels.length ?? 1) === 1 ? 'parcel' : 'parcels'}. Deploying will replace it.</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={replaceOk} onChange={(e) => setReplaceOk(e.target.checked)} />
              Replace the scene that&apos;s there now
            </label>
          </div>
        )}
      </section>
      )}

      <section className="space-y-3 border-t border-gray-800 pt-4">
        <h3 className="text-sm font-medium text-gray-200">Also put it in</h3>
        <div className="space-y-2">
          <label className={`flex items-center gap-2 text-sm ${hyperfyAllowed ? 'text-gray-200' : 'text-gray-500'}`}>
            <input type="checkbox" disabled={!hyperfyAllowed} checked={!!hyperfy}
              onChange={(e) => dispatch({ type: 'setHyperfy', hyperfy: e.target.checked ? { kind: 'self', name: '' } : null })} />
            A Hyperfy world
            {!hyperfyAllowed && options && (
              <Link href="/settings" className="ml-1 text-blue-400 hover:text-blue-300">Upgrade to Creator</Link>
            )}
          </label>
          {hyperfy && (
            <div className="ml-6 space-y-2">
              <div className="flex flex-wrap gap-3 text-sm text-gray-300">
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="hyperfy-kind" checked={hyperfy.kind === 'self'} onChange={() => dispatch({ type: 'setHyperfy', hyperfy: { ...hyperfy, kind: 'self' } })} />
                  One I run myself
                </label>
                {hosting === 'needs_account' ? (
                  <button type="button" onClick={() => { openSignUp({ action: 'hyperfy_hosting', ctx: {} }).catch(() => {}) }}
                    className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300">
                    <LockIcon size={14} />
                    Hosted by Virvi
                    <span className="text-xs">(needs a free account)</span>
                  </button>
                ) : (
                  <label className={`flex items-center gap-1.5 ${canHost ? '' : 'text-gray-500'}`}>
                    <input type="radio" name="hyperfy-kind" disabled={!canHost} checked={hyperfy.kind === 'hosted'} onChange={() => dispatch({ type: 'setHyperfy', hyperfy: { ...hyperfy, kind: 'hosted' } })} />
                    Hosted by Virvi
                  </label>
                )}
              </div>
              {(hosting === 'used_up' || hosting === 'unavailable') && (
                <p className="text-xs text-gray-500">
                  {hosting === 'used_up' ? "You've used all your hosted worlds." : "Hosted worlds aren't available right now."}
                </p>
              )}
              <input value={hyperfy.name} onChange={(e) => dispatch({ type: 'setHyperfyName', name: e.target.value })}
                placeholder="Name for the Hyperfy world" aria-label="Hyperfy world name" maxLength={100} className={inputClass} />
            </div>
          )}
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-gray-200">
            <input type="checkbox" checked={!!ar} onChange={(e) => dispatch({ type: 'setAr', ar: e.target.checked ? { name: '' } : null })} />
            Virvi AR
          </label>
          {ar && (
            <div className="ml-6 space-y-1">
              <input value={ar.name} onChange={(e) => dispatch({ type: 'setArName', name: e.target.value })}
                placeholder="Name for the AR space" aria-label="AR space name" maxLength={100} className={inputClass} />
              <p className="text-xs text-gray-500">Printing and aligning its rings happens later, in the scene&apos;s AR tab.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

const metres = (v: number) => `${v.toFixed(1)} m`

/** "Start from a room scan": one of the person's scans fixes the plot and becomes the scene's room. */
function RoomScanPicker({ scans, chosen, dispatch, trial }: { scans: RoomScanSummary[] | null | 'error'; chosen: string | null; dispatch: Dispatch<WizardAction>; trial: boolean }) {
  if (scans === null) return null
  return (
    <section className="space-y-3 border-t border-gray-800 pt-4">
      <h3 className="text-sm font-medium text-gray-200">Start from a room scan</h3>
      {scans === 'error' && <p className="text-sm text-gray-500">Your room scans couldn&apos;t be loaded just now.</p>}
      {scans !== 'error' && scans.length === 0 && (trial ? <PairQuest /> : (
        <p className="text-sm text-gray-400">Scanning a room needs the Virvi AR app on a personal Quest.</p>
      ))}
      {scans !== 'error' && scans.length > 0 && (
        <ul className="space-y-2" role="radiogroup" aria-label="Your room scans">
          {scans.map((scan) => {
            const on = chosen === scan.id
            const plot = scan.plot
            const size = `${metres(scan.footprint.maxX - scan.footprint.minX)} × ${metres(scan.footprint.maxZ - scan.footprint.minZ)}`
            const rooms = `${scan.roomCount} ${scan.roomCount === 1 ? 'room' : 'rooms'}`
            return (
              <li key={scan.id}>
                <button type="button" role="radio" aria-checked={on} disabled={!plot}
                  onClick={() => (on ? dispatch({ type: 'clearRoomSet' }) : plot && dispatch({ type: 'setRoomSet', scanId: scan.id, plot }))}
                  className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${on ? 'border-blue-400 bg-blue-400/10' : 'border-gray-800 bg-gray-950 hover:border-gray-700'}`}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-white">{scan.name}</span>
                    <span className="block text-xs text-gray-500">{rooms} · {size}</span>
                  </span>
                  <span className="shrink-0 text-xs text-gray-400">{plot ? plotLabel(plot) : 'Too big for a plot'}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** A trial with no scans: the headset's pairing code opens the pairing page (a full load: it is one static page). */
function PairQuest() {
  const [code, setCode] = useState('')
  const href = headsetPairHref(code)
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (href) window.location.assign(href) }} className="space-y-2">
      <p className="text-sm text-gray-400">Pair your Quest to scan a room: open Virvi AR on the headset, then enter its code</p>
      <div className="flex gap-2">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Headset code" aria-label="Headset code"
          autoCapitalize="characters" autoComplete="off" spellCheck={false} className={inputClass} />
        <button type="submit" disabled={!href} className="shrink-0 rounded-md bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700 disabled:opacity-50">Pair</button>
      </div>
    </form>
  )
}
