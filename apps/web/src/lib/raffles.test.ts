import { describe, expect, it } from 'vitest'
import { RAFFLE_RULES_TEMPLATE } from '@virvixr/shared'
import { blankRaffle, fillRules, minutesPresent, raffleActions, raffleBody, raffleErrorMessage, raffleFormError, rulesHost, winnerLabel } from './raffles'
import { sceneTabLocked } from './trial-scene'

const filled = { ...blankRaffle(), name: 'Friday', prize: 'A signed poster' }

describe('raffle form', () => {
  it('blocks submit until the host terms are ticked', () => {
    expect(raffleFormError(filled)).toBe('Accept the host terms to run a raffle.')
    expect(raffleFormError({ ...filled, acceptHostTerms: true })).toBeNull()
  })
  it('needs a name, a prize and 1 to 20 winners', () => {
    const ok = { ...filled, acceptHostTerms: true }
    expect(raffleFormError({ ...ok, name: ' ' })).toMatch(/name/)
    expect(raffleFormError({ ...ok, prize: '' })).toMatch(/prize/)
    expect(raffleFormError({ ...ok, winnersCount: 0 })).toMatch(/1 to 20/)
    expect(raffleFormError({ ...ok, winnersCount: 21 })).toMatch(/1 to 20/)
  })
  it('sends the host terms flag and null rules when blank', () => {
    expect(raffleBody({ ...filled, acceptHostTerms: true, rules: ' ' })).toMatchObject({ acceptHostTerms: true, rules: null, minPresentMinutes: 5, autoSnapshotMinutes: null })
  })
})

describe('rules prefill', () => {
  it('fills prize, winners and host into the template', () => {
    const rules = fillRules('A signed poster', 3, 'Ana')
    expect(rules).toContain('Prize: A signed poster. Winners: 3. Host: Ana.')
    expect(rules).not.toMatch(/\{(prize|winners|host)\}/)
    expect(rules.length).toBeGreaterThan(RAFFLE_RULES_TEMPLATE.length - 30)
  })
  it('keeps "$&" in a prize as typed', () => {
    expect(fillRules('$& $1', 1, 'Ana')).toContain('Prize: $& $1.')
  })
  it('names the host by display name, else the scene', () => {
    expect(rulesHost('Ana', 'Moon')).toBe('Ana')
    expect(rulesHost('  ', 'Moon')).toBe('Moon')
    expect(rulesHost(null, 'Moon')).toBe('Moon')
  })
})

describe('spin results', () => {
  it('shows the winners the API returned, with wallets', () => {
    const w = { entryId: 'e1', displayName: '<b>Ana</b>', wallet: '0xabc' }
    expect(winnerLabel(w)).toEqual({ name: '<b>Ana</b>', wallet: '0xabc' })
  })
  it('shows a deleted entrant without a wallet', () => {
    expect(winnerLabel({ entryId: 'e2', displayName: null, wallet: null, deleted: true })).toEqual({ name: 'Deleted entrant', wallet: null })
  })
})

describe('raffleErrorMessage', () => {
  it('maps empty_pool', () => {
    expect(raffleErrorMessage(new Error('empty_pool'))).toBe('Nobody qualifies yet: take a snapshot while entrants are in the scene.')
  })
  it('maps the other codes a host can hit', () => {
    for (const c of ['mode_locked', 'bad_snapshots', 'raffle_already_active', 'draw_in_progress', 'bad_status', 'winners_out_of_range']) {
      expect(raffleErrorMessage(new Error(c))).not.toBe('Something went wrong. Try again.')
      expect(raffleErrorMessage(new Error(c))).not.toBe(c)
    }
  })
  it('falls back to the server message, then a generic one', () => {
    expect(raffleErrorMessage(Object.assign(new Error('odd'), { body: { message: 'Odd thing.' } }))).toBe('Odd thing.')
    expect(raffleErrorMessage(new Error('odd'))).toBe('Something went wrong. Try again.')
  })
})

describe('raffle actions and trial lock', () => {
  it('shows buttons as the status allows', () => {
    expect(raffleActions('draft')).toEqual(['open', 'cancel'])
    expect(raffleActions('open')).toEqual(['snapshot', 'draw', 'close', 'cancel'])
    expect(raffleActions('drawn')).toEqual(['snapshot', 'draw', 'close'])
    expect(raffleActions('closed')).toEqual([])
    expect(raffleActions('cancelled')).toEqual([])
  })
  it('locks the tab on a trial scene only', () => {
    expect(sceneTabLocked('raffles', true)).toBe(true)
    expect(sceneTabLocked('raffles', false)).toBe(false)
  })
  it('formats minutes present', () => {
    expect(minutesPresent(0)).toBe('0')
    expect(minutesPresent(270)).toBe('4.5')
    expect(minutesPresent(300)).toBe('5')
  })
})
