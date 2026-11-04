'use client'
// Signing and deploying for one World destination, shared by the deploy page and the publish page.
import { useEffect, useRef, useState } from 'react'
import { useApi, type DclDeployment, type DclDestination } from '@/lib/api'
import { getBrowserWallet } from '@/lib/auth'
import type { SignSession } from '@/lib/dcl-sign'
import { signErrorMessage, signerWallets } from '@/lib/deploy'
import { deployVirvi, publishSigned, RunError, watchDeployment, type Phase, type RunUpdate } from '@/lib/wizard/run'

/** startSignSession authorises its key for 10 minutes; reuse it a little less than that. */
const SESSION_REUSE_MS = 9 * 60_000

export interface DeployView {
  status: 'idle' | 'running' | 'failed' | 'done'
  phase: Phase
  models: number | null
  /** False until the wallet has signed (mode sign): a refusal before then shows no progress. */
  underway: boolean
  deployment: DclDeployment | null
  error: string | null
}

const idle: DeployView = { status: 'idle', phase: 'packing', models: null, underway: false, deployment: null, error: null }

/** A destination to sign for: `signers` (Genesis City parcels) are the wallets any one of which may sign; null: any wallet may try. */
export type SigningDestination = Pick<DclDestination, 'id' | 'ownerWallet' | 'worldName' | 'mode'> & { signers?: string[] | null }

/**
 * One signing session per page visit (one wallet prompt covers a grant and a deploy), started for the World's
 * owner wallet (or any of a parcels destination's signers); and a deploy run with the wizard's progress.
 */
export function useWorldSigning(dest: SigningDestination | null) {
  const api = useApi()
  const [view, setView] = useState<DeployView>(idle)
  const [asking, setAsking] = useState(false)
  const session = useRef<{ session: SignSession; startedAt: number } | null>(null)
  const alive = useRef(true)

  // Set on every mount: React's dev Strict Mode unmounts and remounts once.
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  /** The session for a wallet that may sign, asking the wallet only when there is none yet. */
  const signer = async (): Promise<SignSession> => {
    if (!dest) throw new RunError('This World is still loading.')
    const allowed = signerWallets(dest)
    const s = session.current
    if (s && (!allowed || allowed.some((a) => a.toLowerCase() === s.session.address)) && Date.now() - s.startedAt < SESSION_REUSE_MS) return s.session
    const wallet = getBrowserWallet()
    if (!wallet) throw new RunError('No browser wallet found. Install MetaMask or another Ethereum wallet, then try again.')
    setAsking(true)
    try {
      const { startSignSession } = await import('@/lib/dcl-sign')
      const started = await startSignSession(wallet, { expectedAddress: allowed ?? undefined })
      session.current = { session: started, startedAt: Date.now() }
      return started
    } finally {
      if (alive.current) setAsking(false)
    }
  }

  const update = (u: RunUpdate) => {
    if (!alive.current) return
    setView((v) => ({
      ...v,
      ...(u.phase ? { phase: u.phase } : {}),
      ...(u.models !== undefined ? { models: u.models } : {}),
      deployment: u.deployment ?? v.deployment,
    }))
  }

  /** Mode virvi: Virvi signs. Mode sign: the owner signs once, then the same progress until live. */
  const deploy = async (): Promise<boolean> => {
    if (!dest) return false
    setView({ ...idle, status: 'running' })
    try {
      let deploymentId: string
      let settled: DclDeployment | null = null
      if (dest.mode === 'virvi') {
        setView((v) => ({ ...v, underway: true }))
        deploymentId = await deployVirvi(dest.id, api)
      } else {
        const s = await signer()
        if (alive.current) setView((v) => ({ ...v, underway: true }))
        ;({ deploymentId, settled } = await publishSigned(dest.id, s, api, update))
      }
      await watchDeployment(deploymentId, settled, {
        api,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        cancelled: () => !alive.current,
      }, update)
      if (alive.current) setView((v) => ({ ...v, status: 'done', phase: 'live' }))
      return true
    } catch (err) {
      if (alive.current) setView((v) => ({ ...v, status: 'failed', error: signErrorMessage(err, dest) }))
      return false
    }
  }

  /** True while the wallet is asked to sign. */
  return { view, deploy, signer, asking, reset: () => setView(idle) }
}
