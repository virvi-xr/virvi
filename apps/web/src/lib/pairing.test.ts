import { describe, it, expect } from 'vitest'
import type { HyperfyPairingSummary } from '@virvixr/shared'
import { approvalPrompt, pairingErrorMessage, pairingRowLabel, pairingCodeFromPath, headsetPairingCodeFromPath, headsetErrorMessage, headsetPairHref } from './pairing'

const apiErr = (message: string, status: number, body: Record<string, unknown>) => Object.assign(new Error(message), { status, body })

describe('approvalPrompt', () => {
  it('names the world, scene and player', () => {
    expect(approvalPrompt({ worldName: 'Gallery', sceneName: 'Lobby', playerName: 'Ana' }))
      .toBe('Link Hyperfy world "Gallery" (scene Lobby) to your account? Requested by Ana.')
  })
  it('falls back when the player has no name', () => {
    expect(approvalPrompt({ worldName: 'Gallery', sceneName: 'Lobby', playerName: null }))
      .toBe('Link Hyperfy world "Gallery" (scene Lobby) to your account? Requested by a player.')
  })
})

describe('pairingErrorMessage', () => {
  it('explains an expired code', () => {
    expect(pairingErrorMessage(apiErr('not_found', 404, { error: 'not_found', result: 'expired' })))
      .toBe('This code has expired. Ask for a new one in the world.')
  })
  it('explains missing access', () => {
    expect(pairingErrorMessage(apiErr('no_access', 403, { error: 'no_access', result: 'no_access' })))
      .toBe("You don't have access to this scene.")
  })
  it('explains an unknown code', () => {
    expect(pairingErrorMessage(apiErr('not_found', 404, { error: 'not_found' }))).toBe("That code doesn't exist.")
  })
  it('falls back', () => {
    expect(pairingErrorMessage(new Error('API error 500'))).toBe('Something went wrong. Try again in a moment.')
  })
})

const row = (over: Partial<HyperfyPairingSummary>): HyperfyPairingSummary => ({
  id: 'p1', worldId: 'w1', worldName: 'Gallery', sceneId: 's1', sceneName: 'Lobby', kind: 'self',
  createdAt: '2026-10-20T00:00:00Z', lastUsedAt: null, expiresAt: '2026-10-20T18:30:00Z', ...over,
})

describe('pairingRowLabel', () => {
  const now = new Date('2026-10-20T12:00:00Z')
  it('shows when a self pairing ends, in UTC', () => {
    expect(pairingRowLabel(row({}), now)).toBe('Gallery · until 18:30 UTC')
  })
  it('includes the date when it ends on another day', () => {
    expect(pairingRowLabel(row({ expiresAt: '2026-10-21T02:05:00Z' }), now)).toBe('Gallery · until Oct 21, 02:05 UTC')
  })
  it('says hosted pairings are remembered on this browser', () => {
    expect(pairingRowLabel(row({ kind: 'hosted', expiresAt: null }), now)).toBe('Gallery · remembered on this browser')
  })
})

describe('pairingCodeFromPath', () => {
  it('takes the route param outside static export', () => {
    expect(pairingCodeFromPath('/pair/abc-def/', 'abc-def')).toBe('ABCDEF')
  })
  it('reads the address bar when the param is the placeholder', () => {
    expect(pairingCodeFromPath('/pair/abc-def/', '_')).toBe('ABCDEF')
    expect(pairingCodeFromPath('/pair/ABCDEF', undefined)).toBe('ABCDEF')
  })
  it('rejects a code that cannot exist', () => {
    expect(pairingCodeFromPath('/pair/ABC0EF/', '_')).toBeNull()
    expect(pairingCodeFromPath('/pair/_/', '_')).toBeNull()
  })
})

describe('headsetPairingCodeFromPath', () => {
  it('reads the code from the address bar, in any case or format', () => {
    expect(headsetPairingCodeFromPath('/pair/headset/ABC-234/', '_')).toBe('ABC234')
    expect(headsetPairingCodeFromPath('/pair/headset/abc234', undefined)).toBe('ABC234')
  })
  it('takes the route param outside static export', () => {
    expect(headsetPairingCodeFromPath('/pair/headset/x/', 'abc-234')).toBe('ABC234')
  })
  it('is null for other paths', () => {
    expect(headsetPairingCodeFromPath('/pair/ABC234', '_')).toBeNull()
  })
})

describe('headsetErrorMessage', () => {
  it('explains an unverified account', () => {
    expect(headsetErrorMessage(apiErr('unverified', 403, { error: 'unverified' }))).toBe('Verify your email before approving a headset.')
  })
  it('explains an expired or unknown code', () => {
    expect(headsetErrorMessage(apiErr('not_found', 404, { error: 'not_found' }))).toBe('This code has expired or was already used. Ask the headset for a new one.')
  })
  it('falls back', () => {
    expect(headsetErrorMessage(new Error('x'))).toBe('Something went wrong. Try again in a moment.')
  })
})

describe('headsetPairHref', () => {
  it('normalises the typed code into the pairing page', () => {
    expect(headsetPairHref(' abc-234 ')).toBe('/pair/headset/ABC234/')
  })
  it('is null for nothing typed', () => {
    expect(headsetPairHref('  ')).toBeNull()
    expect(headsetPairHref('-')).toBeNull()
  })
})
