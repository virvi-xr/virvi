import { describe, expect, it, vi } from 'vitest'
import { BEATS_OFF, balanceLabel, clearPause, formatPol, formatPol4, giveUp, loadAdminBeats, lowGasDetail, pauseMessage, retryFailed, type AdminBeatChain } from './admin-beats'

const chain = (over: Partial<AdminBeatChain> = {}): AdminBeatChain => ({
  chain: 'polygon-amoy', contract: null, minter: '0x1234567890abcdef1234567890abcdef12345678',
  balanceWei: '0', balanceError: false, paused: false, reason: null, missing: [],
  minGasWei: '1000000000000000000', batchCostWei: null, topUpWei: null, ...over,
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
    const api = { retryAdminBeatsFailed: vi.fn().mockResolvedValue({ retried: 3, skippedClosed: 0 }) }
    expect(await retryFailed(api)).toBe('3 failed claims will be sent again.')
    expect(api.retryAdminBeatsFailed).toHaveBeenLastCalledWith(undefined)
    api.retryAdminBeatsFailed.mockResolvedValue({ retried: 1, skippedClosed: 0 })
    expect(await retryFailed(api, 'b1')).toBe('1 failed claim will be sent again.')
    expect(api.retryAdminBeatsFailed).toHaveBeenLastCalledWith('b1')
    api.retryAdminBeatsFailed.mockResolvedValue({ retried: 0, skippedClosed: 0 })
    expect(await retryFailed(api)).toBe('No failed claims to retry.')
  })
  it('says how many failed claims are on closed BEATs and could not be retried', async () => {
    const api = { retryAdminBeatsFailed: vi.fn().mockResolvedValue({ retried: 2, skippedClosed: 3 }) }
    expect(await retryFailed(api)).toBe("2 failed claims will be sent again. 3 on closed BEATs can't be retried.")
    api.retryAdminBeatsFailed.mockResolvedValue({ retried: 0, skippedClosed: 1 })
    expect(await retryFailed(api)).toBe("1 on closed BEATs can't be retried.")
  })
  it('says what a chain that is not set up is missing', () => {
    const off = chain({ minter: null, balanceWei: null, paused: true, reason: 'no_client', missing: ['BEAT_CONTRACT_POLYGON', 'BEAT_MINTER_KEY'] })
    expect(pauseMessage(off)).toBe("Not set up: set BEAT_CONTRACT_POLYGON and BEAT_MINTER_KEY. Hosts can't pay for BEATs until then.")
    expect(pauseMessage({ ...off, missing: ['BEAT_MINTER_KEY'] })).toBe("Not set up: set BEAT_MINTER_KEY. Hosts can't pay for BEATs until then.")
  })
  it('Clear pause calls the API for that chain', async () => {
    const api = { clearAdminBeatPause: vi.fn().mockResolvedValue({ ok: true }) }
    await clearPause(api, 'polygon')
    expect(api.clearAdminBeatPause).toHaveBeenCalledWith('polygon')
  })
  it('Stop retrying and close calls the API for that BEAT and says what happens next', async () => {
    const api = { giveUpAdminBeat: vi.fn().mockResolvedValue({ givenUp: 2 }) }
    expect(await giveUp(api, 'b1')).toBe('2 failed claims won\'t be retried. The BEAT closes on chain shortly.')
    expect(api.giveUpAdminBeat).toHaveBeenCalledWith('b1')
    api.giveUpAdminBeat.mockResolvedValue({ givenUp: 1 })
    expect(await giveUp(api, 'b1')).toBe('1 failed claim won\'t be retried. The BEAT closes on chain shortly.')
  })
  it('formats POL with exactly 4 decimals, cut down or rounded up', () => {
    expect(formatPol4('1000000000000000000')).toBe('1.0000 POL')
    expect(formatPol4('1234567890123456789')).toBe('1.2345 POL')
    expect(formatPol4('1234567890123456789', 'up')).toBe('1.2346 POL')
    expect(formatPol4('1234500000000000000', 'up')).toBe('1.2345 POL')
    expect(formatPol4('0')).toBe('0.0000 POL')
    expect(formatPol4('1', 'up')).toBe('0.0001 POL')
  })
  it('a low-gas pause says the balance, the minimum and how much to top up', () => {
    expect(lowGasDetail(chain())).toBeNull()
    const low = chain({ paused: true, reason: 'low_gas', balanceWei: '250000000000000000' })
    expect(lowGasDetail({ ...low, batchCostWei: '400000000000000000', topUpWei: '1150000000000000001' })).toBe(
      'Balance 0.2500 POL. Minimum 1.0000 POL. Top up 1.1501 POL: the minimum plus one full 100-claim batch at current fees.')
    expect(lowGasDetail({ ...low, topUpWei: '750000000000000000' })).toBe('Balance 0.2500 POL. Minimum 1.0000 POL. Top up 0.7500 POL to reach the minimum.')
    // M1: never "Top up 0.0000 POL": no suggestion, just the balance and minimum
    expect(lowGasDetail({ ...low, balanceWei: '1500000000000000000', topUpWei: null })).toBe('Balance 1.5000 POL. Minimum 1.0000 POL.')
    expect(lowGasDetail({ ...low, balanceWei: '1500000000000000000', topUpWei: '0' })).toBe('Balance 1.5000 POL. Minimum 1.0000 POL.')
    // An unreadable balance: no top-up figure
    expect(lowGasDetail({ ...low, balanceWei: null, balanceError: true })).toBe('Balance unavailable. Minimum 1.0000 POL.')
  })
})
