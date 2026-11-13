import { describe, expect, it } from 'vitest'
import { RAFFLE_RULES_TEMPLATE } from '@virvixr/shared'
import {
  blankRaffle, confirmAction, drawBody, editBody, entryLabel, fillRules, minutesPresent, raffleActions, raffleBody, raffleErrorMessage, raffleFormError,
  raffleToInput, rulesHost, spinCountDefault, winnerLabel, type HostRaffle,
} from './raffles'
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
  it('shows a removed winner without a wallet', () => {
    expect(winnerLabel({ entryId: 'e2', displayName: null, wallet: null, deleted: true })).toEqual({ name: 'Removed entrant', wallet: null })
    expect(winnerLabel({ entryId: 'e3', displayName: null, wallet: null })).toEqual({ name: 'Removed entrant', wallet: null })
  })
  it('shows an entry with no name or wallet as a removed entrant, with no wallet to copy', () => {
    const at = { secondsPresent: 0, lastSeenAt: null, createdAt: '2026-11-13T00:00:00Z' }
    expect(entryLabel({ id: 'e1', displayName: null, wallet: null, ...at })).toEqual({ name: 'Removed entrant', wallet: null })
    expect(entryLabel({ id: 'e1', displayName: null, wallet: '0xabc', ...at })).toEqual({ name: 'Removed entrant', wallet: null })
    expect(entryLabel({ id: 'e2', displayName: 'Ana', wallet: '0xabc', ...at })).toEqual({ name: 'Ana', wallet: '0xabc' })
  })
})

describe('spinning', () => {
  it('defaults to every winner on the first spin and one replacement after', () => {
    expect(spinCountDefault(3, 0)).toBe(3)
    expect(spinCountDefault(3, 2)).toBe(1)
  })
  it('sends the count, and the snapshots only when some are left out', () => {
    expect(drawBody(2, ['s1', 's2'], ['s1', 's2'])).toEqual({ count: 2 })
    expect(drawBody(1, ['s2'], ['s1', 's2'])).toEqual({ count: 1, snapshotIds: ['s2'] })
    expect(drawBody(1, [], ['s1'])).toEqual({ count: 1, snapshotIds: [] })
  })
  it('asks before Close and Cancel only', () => {
    expect(confirmAction('close')).toMatch(/close/i)
    expect(confirmAction('cancel')).toMatch(/cancel/i)
    expect(confirmAction('open')).toBeNull()
    expect(confirmAction('draw')).toBeNull()
  })
  it('maps bad_count', () => {
    expect(raffleErrorMessage(new Error('bad_count'))).not.toBe('Something went wrong. Try again.')
  })
})

describe('editing a raffle', () => {
  const r: HostRaffle = {
    id: 'r1', sceneId: 's1', name: 'Friday', prize: 'Hat', rules: null, winnersCount: 2, mode: 'weighted', minPresentMinutes: 3,
    autoSnapshotMinutes: 10, status: 'open', entryCount: 0, openedAt: null, endedAt: null,
  }
  it('fills the form from the raffle, terms not needed', () => {
    const f = raffleToInput(r)
    expect(f).toMatchObject({ name: 'Friday', prize: 'Hat', rules: '', winnersCount: 2, mode: 'weighted', minPresentMinutes: 3, autoSnapshotMinutes: 10 })
    expect(raffleFormError(f, { editing: true })).toBeNull()
    expect(raffleFormError({ ...f, name: '' }, { editing: true })).toMatch(/name/)
  })
  it('sends the same fields as create, without the host terms', () => {
    const body = editBody({ ...raffleToInput(r), rules: '  Be nice. ' })
    expect(body).toEqual({ name: 'Friday', prize: 'Hat', winnersCount: 2, mode: 'weighted', minPresentMinutes: 3, autoSnapshotMinutes: 10, rules: 'Be nice.' })
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
