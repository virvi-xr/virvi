import { describe, expect, it, vi } from 'vitest'
import type { DclWorld } from '../api'
import { trialEndedOutcome, sendRecovering } from '../trial'
import { autoPickWorld, connectForDeploy, connectOutcome, deployGate, DEPLOY_LINE, NO_WORLD_MESSAGE, noWorldMessage, WALLET_PROMPT } from './trial-deploy'

const world = (name: string, hasScene = false): DclWorld => ({ world: name, hasScene, footprint: null, storage: null })

describe('connectForDeploy', () => {
  it("connects once, then lists the new account's Worlds", async () => {
    const wallets = [{ address: '0xabc', names: [world('me.dcl.eth')] }]
    const loginWithWallet = vi.fn(async () => 'account-token')
    const names = vi.fn(async () => ({ wallets }))
    await expect(connectForDeploy({ loginWithWallet, names })).resolves.toEqual({ wallets })
    expect(loginWithWallet).toHaveBeenCalledTimes(1)
    expect(loginWithWallet).toHaveBeenCalledWith('deploy')
    expect(names).toHaveBeenCalledTimes(1)
    expect(names).toHaveBeenCalledWith('account-token')
  })

  it('a wallet sign-in that fails stops before listing', async () => {
    const refused = new Error('User rejected the request')
    const names = vi.fn(async () => ({ wallets: [] }))
    await expect(connectForDeploy({ loginWithWallet: async () => { throw refused }, names })).rejects.toBe(refused)
    expect(names).not.toHaveBeenCalled()
  })
})

describe('autoPickWorld', () => {
  it('picks a lone empty World', () => {
    expect(autoPickWorld([{ address: '0x1', names: [] }, { address: '0x2', names: [world('solo.dcl.eth')] }]))
      .toEqual({ world: world('solo.dcl.eth'), wallet: '0x2' })
  })
  it('returns null for two Worlds, even across wallets', () => {
    expect(autoPickWorld([{ address: '0x1', names: [world('a.dcl.eth'), world('b.dcl.eth')] }])).toBeNull()
    expect(autoPickWorld([{ address: '0x1', names: [world('a.dcl.eth')] }, { address: '0x2', names: [world('b.dcl.eth')] }])).toBeNull()
  })
  it('returns null for one World that already has a scene', () => {
    expect(autoPickWorld([{ address: '0x1', names: [world('busy.dcl.eth', true)] }])).toBeNull()
  })
  it('returns null with no Worlds', () => {
    expect(autoPickWorld([])).toBeNull()
  })
})

describe('noWorldMessage', () => {
  it('gives the no-NAME line when no wallet owns a World', () => {
    const line = "This wallet doesn't own a Decentraland NAME. Your account is ready: connect the wallet that owns your World, or pick Hyperfy or Virvi AR instead."
    expect(NO_WORLD_MESSAGE).toBe(line)
    expect(noWorldMessage([{ address: '0x1', names: [] }])).toBe(line)
    expect(noWorldMessage([])).toBe(line)
  })
  it('is null when a wallet owns a World', () => {
    expect(noWorldMessage([{ address: '0x1', names: [] }, { address: '0x2', names: [world('a.dcl.eth')] }])).toBeNull()
  })
})

describe('copy', () => {
  it('says the deploy also creates the account, and that the wallet signs twice', () => {
    expect(DEPLOY_LINE).toBe('Connect your wallet to deploy. This also creates your Virvi account.')
    expect(WALLET_PROMPT).toBe('Check your wallet: sign once to create your account, then once more to deploy.')
  })
})

describe('deployGate', () => {
  const dcl = { world: 'me.dcl.eth' }
  it('a trial that chose Decentraland connects its wallet first', () => {
    expect(deployGate({ trial: true, dclLater: true, dcl: null })).toBe('wallet')
  })
  it('a trial without Decentraland deploys as usual (the save asks it to sign up)', () => {
    expect(deployGate({ trial: true, dclLater: false, dcl: null })).toBe('deploy')
  })
  it('an account that carried "Decentraland World" over picks the World (or skips Decentraland) before deploying', () => {
    expect(deployGate({ trial: false, dclLater: true, dcl: null })).toBe('world')
  })
  it('a World picked, or no Decentraland at all, deploys', () => {
    expect(deployGate({ trial: false, dclLater: false, dcl })).toBe('deploy')
    expect(deployGate({ trial: false, dclLater: false, dcl: null })).toBe('deploy')
  })
})

describe('after the wallet turns the trial into an account', () => {
  it('a call still holding the trial token is answered as the account (trial_ended swap)', async () => {
    // The wallet sign-in stored the account session; the page's request still carries the trial's token
    const storage = { token: 'account-token', user: { id: 'acct', trial: false } }
    const sent: Array<string | null> = []
    const send = vi.fn(async (bearer: string | null) => {
      sent.push(bearer)
      return bearer === 'trial-token'
        ? new Response(JSON.stringify({ error: 'trial_ended' }), { status: 401 })
        : new Response(JSON.stringify({ wallets: [] }), { status: 200 })
    })
    const renew = vi.fn(async () => null)
    const swapToStoredAccount = (stale: string) => (trialEndedOutcome(storage, stale) === 'swap' ? storage.token : null)
    const res = await sendRecovering(send, 'trial-token', { swapToStoredAccount, renew })
    expect(res.status).toBe(200)
    expect(sent).toEqual(['trial-token', 'account-token'])
    expect(renew).not.toHaveBeenCalled()
  })

  it('an ordinary expired token is renewed and sent once more', async () => {
    const send = vi.fn(async (bearer: string | null) => new Response('{}', { status: bearer === 'old' ? 401 : 200 }))
    const res = await sendRecovering(send, 'old', { swapToStoredAccount: () => null, renew: async () => 'new' })
    expect(res.status).toBe(200)
    expect(send).toHaveBeenLastCalledWith('new')
  })

  it('without a session to follow, the 401 stands', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ error: 'trial_ended' }), { status: 401 }))
    const res = await sendRecovering(send, 'trial-token', { swapToStoredAccount: () => null, renew: async () => null })
    expect(res.status).toBe(401)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('connectOutcome', () => {
  it('fills in the lone empty World and stops there: the deploy mode is chosen and Create and deploy clicked by the user', () => {
    const out = connectOutcome([{ address: '0x2', names: [world('solo.dcl.eth')] }])
    expect(out).toEqual({ kind: 'picked', world: world('solo.dcl.eth'), wallet: '0x2' })
    expect(out).not.toHaveProperty('start')
  })
  it('lists the Worlds when there is more than one, or the lone one has a scene', () => {
    expect(connectOutcome([{ address: '0x1', names: [world('a.dcl.eth'), world('b.dcl.eth')] }])).toEqual({ kind: 'choose' })
    expect(connectOutcome([{ address: '0x1', names: [world('busy.dcl.eth', true)] }])).toEqual({ kind: 'choose' })
  })
  it('with no World, the account is ready and the no-NAME line says what next', () => {
    expect(connectOutcome([{ address: '0x1', names: [] }])).toEqual({ kind: 'none', message: NO_WORLD_MESSAGE })
  })
})
