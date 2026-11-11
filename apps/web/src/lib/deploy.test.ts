import { describe, it, expect } from 'vitest'
import { WrongWalletError } from './dcl-sign'
import { deploymentSummary, destinationHistory, mapView, modeLabel, pendingLine, publishCopy, signErrorMessage, signerWallets, statusView, destinationLocation } from './deploy'

describe('pendingLine', () => {
  it('counts the models waiting to go live', () => {
    expect(pendingLine(3)).toBe('3 models are waiting to go live')
    expect(pendingLine(1)).toBe('1 model is waiting to go live')
    expect(pendingLine(0)).toBe('Every model in the scene is live.')
  })

  it('counts a thumbnail change apart from the models (LIV-88)', () => {
    const m = { kind: undefined }
    const t = { kind: 'thumbnail' as const }
    expect(pendingLine([m, m])).toBe('2 models are waiting to go live')
    expect(pendingLine([t])).toBe('The new thumbnail is waiting to go live')
    expect(pendingLine([{ kind: 'thumbnail' as const, removed: true as const }])).toBe('Removing the thumbnail is waiting to go live')
    expect(pendingLine([m, t])).toBe('1 model and the new thumbnail are waiting to go live')
    expect(pendingLine([])).toBe('Everything in the scene is live.')
  })
})

describe('modeLabel', () => {
  it('says who deploys', () => {
    expect(modeLabel({ mode: 'virvi', grantedAt: '2026-10-25T00:00:00Z' })).toBe('Virvi deploys for you')
    expect(modeLabel({ mode: 'virvi', grantedAt: null })).toMatch(/once you've signed/)
    expect(modeLabel({ mode: 'sign', grantedAt: null })).toBe('You sign each deploy')
  })
})

describe('statusView', () => {
  it('uses its own sentence for short reasons and the server sentence when it says more', () => {
    expect(statusView({ status: 'ok', statusDetail: null })).toEqual({ label: 'Up to date', tone: 'success', line: '' })
    const review = statusView({ status: 'needs_review', statusDetail: 'Your World changed outside Virvi' })
    expect(review.label).toBe('Needs a look')
    expect(review.line).toMatch(/use the live version/)
    const failing = 'Virvi couldn\'t update your World 3 times in a row (too big). Check it on the deploy page and press Redeploy now.'
    expect(statusView({ status: 'needs_review', statusDetail: failing }).line).toBe(failing)
    expect(statusView({ status: 'unreachable', statusDetail: "Couldn't read your World from Decentraland" }).line).toMatch(/tries again on its own/)
  })
})

describe('deploy history', () => {
  it("keeps only the destination's deployments", () => {
    const list = [{ id: 'a', destinationId: 'd1' }, { id: 'b', destinationId: null }, { id: 'c', destinationId: 'd2' }]
    expect(destinationHistory(list, 'd1').map((d) => d.id)).toEqual(['a'])
  })
  it('summarises what a deploy added', () => {
    expect(deploymentSummary({ id: 'x', sceneId: 's', status: 'deployed', assetBundle: { added: [1, 2] } })).toBe('2 new models')
    expect(deploymentSummary({ id: 'x', sceneId: 's', status: 'deployed', assetBundle: { added: [1] } })).toBe('1 new model')
    expect(deploymentSummary({ id: 'x', sceneId: 's', status: 'deployed', assetBundle: null })).toBe('')
  })
})

describe('signErrorMessage', () => {
  const dest = { ownerWallet: '0x1234567890abcdef1234567890abcdef12345678', worldName: 'cafe.dcl.eth' }
  it('names the owning wallet on a wrong wallet', () => {
    expect(signErrorMessage(new WrongWalletError(dest.ownerWallet), dest)).toBe('Sign with 0x1234…5678, the wallet that owns cafe.dcl.eth.')
  })
  it('names no single wallet for Genesis City parcels', () => {
    expect(signErrorMessage(new WrongWalletError(['0xaa']), { ...dest, kind: 'parcels' })).toBe('Sign with a wallet that owns or operates these parcels.')
  })
  it('falls back to the wizard messages', () => {
    expect(signErrorMessage(Object.assign(new Error('x'), { code: 4001 }), dest)).toBe('You cancelled the request in your wallet. Nothing was changed.')
  })
})

describe('signerWallets', () => {
  const dest = { ownerWallet: '0xOwner' }
  it('is the owner for a World, the signers for parcels, and no restriction when they are unknown', () => {
    expect(signerWallets(dest)).toEqual(['0xOwner'])
    expect(signerWallets({ ...dest, signers: ['0xa', '0xb'] })).toEqual(['0xa', '0xb'])
    expect(signerWallets({ ...dest, signers: null })).toBeNull()
    expect(signerWallets({ ...dest, signers: [] })).toBeNull()
  })
})

describe('destinationLocation', () => {
  it('tells a World from Genesis City parcels', () => {
    expect(destinationLocation({ kind: 'world', worldName: 'a.dcl.eth', base: '0,0', parcels: ['0,0'] })).toEqual({ kind: 'world', world: 'a.dcl.eth' })
    expect(destinationLocation({ worldName: 'a.dcl.eth', base: '0,0', parcels: ['0,0'] })).toEqual({ kind: 'world', world: 'a.dcl.eth' })
    expect(destinationLocation({ kind: 'parcels', worldName: null as unknown as string, base: '1,2', parcels: ['1,2', '1,3'] }))
      .toEqual({ kind: 'parcels', base: '1,2', parcels: ['1,2', '1,3'] })
  })
})

describe('publishCopy', () => {
  it("words a World's publish page by its name and owner", () => {
    expect(publishCopy({ kind: 'world', worldName: 'a.dcl.eth', base: '0,0', parcels: ['0,0'] })).toEqual({
      place: 'a.dcl.eth',
      subtitle: 'Put the models you added live in your Decentraland World.',
      signWith: 'You sign once with the wallet that owns a.dcl.eth.',
      yours: 'your World',
      notSigned: "This World is set to let Virvi deploy, but the permission isn't signed yet.",
    })
  })
  it('words Genesis City parcels without a World name', () => {
    const copy = publishCopy({ kind: 'parcels', worldName: null as unknown as string, base: '1,2', parcels: ['1,2', '1,3'] })
    expect(copy).toEqual({
      place: 'Genesis City 1,2 (2 parcels)',
      subtitle: 'Put the models you added live on your Genesis City parcels.',
      signWith: 'You sign once with a wallet that owns or operates these parcels.',
      yours: 'your parcels',
      notSigned: "These parcels are set to let Virvi deploy, but Virvi isn't an operator on them yet.",
    })
    expect(JSON.stringify(copy)).not.toMatch(/null|World/)
  })
})

describe('mapView (LIV-135)', () => {
  const d = (over: Partial<Parameters<typeof mapView>[0]> = {}) =>
    ({ kind: 'world' as const, lastEntityId: 'bafy1', mapStatus: 'pending' as const, mapEntityId: 'bafy1', mapAssets: null, ...over })

  it('ready, with the model count', () => {
    expect(mapView(d({ mapStatus: 'ready', mapAssets: 12 }))?.line).toBe('Map data: ready (12 models)')
    expect(mapView(d({ mapStatus: 'ready', mapAssets: 1 }))?.line).toBe('Map data: ready (1 model)')
    expect(mapView(d({ mapStatus: 'ready', mapAssets: null }))?.line).toBe('Map data: ready')
  })

  it('pending and none', () => {
    expect(mapView(d())?.line).toBe('Map data: waiting for Decentraland')
    expect(mapView(d({ mapStatus: 'none' }))?.line).toBe("No map data — Decentraland didn't build a map snapshot for this deploy")
    expect(mapView(d({ mapStatus: 'none' }))?.tone).toBe('warning')
  })

  it('says nothing when it was never checked, or the live entity is no longer the one checked', () => {
    expect(mapView(d({ mapStatus: 'unknown' }))).toBeNull()
    expect(mapView(d({ mapStatus: undefined }))).toBeNull()
    expect(mapView(d({ mapStatus: 'ready', mapAssets: 3, lastEntityId: 'bafyowner' }))).toBeNull()
  })

  it('the help line: Worlds have no satellite map yet; Genesis City updates when Decentraland re-captures', () => {
    expect(mapView(d())?.help).toMatch(/Worlds don't have a satellite map/)
    expect(mapView(d({ kind: 'parcels' }))?.help).toMatch(/re-captures/)
    expect(mapView(d({ kind: 'parcels' }))?.help).not.toMatch(/Worlds don't/)
  })
})
