import { describe, expect, it, vi } from 'vitest'
import { BEATS_OFF, balanceLabel, clearPause, formatPol, loadAdminBeats, pauseMessage, retryFailed, type AdminBeatChain } from './admin-beats'

const chain = (over: Partial<AdminBeatChain> = {}): AdminBeatChain => ({
  chain: 'polygon-amoy', contract: null, minter: '0x1234567890abcdef1234567890abcdef12345678',
  balanceWei: '0', balanceError: false, paused: false, reason: null, ...over,
})

describe('admin BEATs helpers (LIV-11)', () => {
  it('formats wei as POL without float error, cut (never rounded up) to 4 places', () => {
    expect(formatPol('0')).toBe('0 POL')
    expect(formatPol('1000000000000000000')).toBe('1 POL')
    expect(formatPol('1234567890123456789')).toBe('1.2345 POL')
    expect(formatPol('99999999999999999')).toBe('0.0999 POL')
    expect(formatPol('123456789012345678901234567890')).toBe('123456789012.3456 POL')
  })
  it('says the balance is unavailable rather than 0 when it could not be read', () => {
    expect(balanceLabel(chain({ balanceWei: null, balanceError: true }))).toBe('Balance unavailable')
    expect(balanceLabel(chain({ balanceWei: '0', balanceError: true }))).toBe('Balance unavailable')
    expect(balanceLabel(chain({ balanceWei: '2000000000000000000' }))).toBe('2 POL')
  })
  it('names each pause plainly', () => {
    expect(pauseMessage(chain())).toBeNull()
    expect(pauseMessage(chain({ paused: true, reason: 'low_gas' }))).toBe('Minting paused: top up the minter')
    expect(pauseMessage(chain({ paused: true, reason: 'id_conflict' }))).toBe('Minting paused: a BEAT id already exists on chain. Check before clearing.')
  })
  it('reads "BEATs are off" from the 404 the dark routes give', async () => {
    const api = { getAdminBeats: vi.fn().mockRejectedValue(Object.assign(new Error('not_found'), { status: 404 })) }
    expect(await loadAdminBeats(api)).toBe('off')
    expect(BEATS_OFF).toBe('BEATs are off.')
    const boom = { getAdminBeats: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 500 })) }
    await expect(loadAdminBeats(boom)).rejects.toThrow()
  })
  it('Retry failed calls the API, for all or for one BEAT, and says how many went again', async () => {
    const api = { retryAdminBeatsFailed: vi.fn().mockResolvedValue({ retried: 3 }) }
    expect(await retryFailed(api)).toBe('3 failed claims will be sent again.')
    expect(api.retryAdminBeatsFailed).toHaveBeenLastCalledWith(undefined)
    api.retryAdminBeatsFailed.mockResolvedValue({ retried: 1 })
    expect(await retryFailed(api, 'b1')).toBe('1 failed claim will be sent again.')
    expect(api.retryAdminBeatsFailed).toHaveBeenLastCalledWith('b1')
    api.retryAdminBeatsFailed.mockResolvedValue({ retried: 0 })
    expect(await retryFailed(api)).toBe('No failed claims to retry.')
  })
  it('Clear pause calls the API for that chain', async () => {
    const api = { clearAdminBeatPause: vi.fn().mockResolvedValue({ ok: true }) }
    await clearPause(api, 'polygon')
    expect(api.clearAdminBeatPause).toHaveBeenCalledWith('polygon')
  })
})
