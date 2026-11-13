import { describe, it, expect } from 'vitest'
import { CHECKIN_INTERVAL_MS, raffleConsentText, type PublicRaffle } from '@virvixr/shared'
import { CheckInClock, cardReducer, cardView, checkInWanted, initialCard, plainText, raffleEntryError, type RaffleCard } from '../src/raffle/card.js'
import { pickHostRaffle, presentNow, raffleHostError } from '../src/raffle/host.js'

const raffle = (over: Partial<PublicRaffle> = {}): PublicRaffle => ({
  id: 'r1', sceneId: 's1', name: 'Launch party', prize: 'A wearable', rules: 'Be nice.', status: 'open', winnersCount: 1, entryCount: 3, ...over,
})
const run = (s: RaffleCard, ...events: Parameters<typeof cardReducer>[1][]) => events.reduce(cardReducer, s)
const actions = (s: RaffleCard) => cardView(s).actions.map((a) => a.id)

describe('raffle card', () => {
  it('is hidden without an open or drawn raffle', () => {
    expect(cardView(initialCard(false)).visible).toBe(false)
    expect(cardView(run(initialCard(false), { type: 'raffle', raffle: raffle({ status: 'closed' }) })).visible).toBe(false)
  })

  it('enter → consent → entered', () => {
    let s = run(initialCard(false), { type: 'raffle', raffle: raffle() })
    expect(cardView(s)).toMatchObject({ visible: true, title: 'Launch party', prize: 'Prize: A wearable', entries: '3 entries' })
    expect(cardView(s).actions[0]).toEqual({ id: 'enter', label: 'Enter raffle' })
    s = run(s, { type: 'enter' })
    expect(cardView(s).body).toBe(raffleConsentText())
    expect(actions(s)).toEqual(['confirm', 'cancel'])
    s = run(s, { type: 'confirm' })
    expect(s.busy).toBe(true)
    expect(actions(s)).toEqual([])
    s = run(s, { type: 'entered' })
    expect(cardView(s).line).toBe('Entered ✓')
    expect(actions(s)).toEqual(['withdraw', 'rules'])
    expect(checkInWanted(s)).toBe(true)
    s = run(s, { type: 'withdraw' }, { type: 'withdrawn' })
    expect(actions(s)).toEqual(['enter', 'rules'])
    expect(checkInWanted(s)).toBe(false)
  })

  it('Cancel leaves the consent without entering', () => {
    const s = run(initialCard(false), { type: 'raffle', raffle: raffle() }, { type: 'enter' }, { type: 'cancel' })
    expect(s).toMatchObject({ view: 'card', entered: false })
  })

  it('a guest gets the sign-in line and no enter action', () => {
    let s = run(initialCard(true), { type: 'raffle', raffle: raffle() })
    expect(cardView(s).line).toBe('Sign in with a wallet to enter')
    expect(actions(s)).toEqual(['rules'])
    s = run(s, { type: 'enter' })
    expect(s.view).toBe('card')
  })

  it('a draw where I am a winner → won; others see entries closed', () => {
    const entered = run(initialCard(false), { type: 'raffle', raffle: raffle() }, { type: 'mine', entered: true, won: false })
    const won = run(entered, { type: 'drawn', won: true })
    expect(cardView(won).line).toBe('You won! The host will contact you about your prize.')
    expect(checkInWanted(won)).toBe(true)
    const lost = run(entered, { type: 'drawn', won: false })
    expect(lost.raffle!.status).toBe('drawn')
    expect(cardView(lost).line).toBe('Entries closed')
    expect(actions(lost)).toEqual(['withdraw', 'rules'])
    // A winner stays a winner when a re-spin picks someone else
    expect(run(won, { type: 'drawn', won: false }).won).toBe(true)
  })

  it('entries closed for visitors who never entered once drawn', () => {
    const s = run(initialCard(false), { type: 'raffle', raffle: raffle({ status: 'drawn' }) })
    expect(cardView(s).line).toBe('Entries closed')
    expect(actions(s)).toEqual(['rules'])
  })

  it('a late joiner sees their entered state from the current raffle', () => {
    const s = run(initialCard(false), { type: 'raffle', raffle: raffle() }, { type: 'mine', entered: true, won: false })
    expect(cardView(s).line).toBe('Entered ✓')
  })

  it('Rules shows the rules text with Close; no Rules button without rules', () => {
    let s = run(initialCard(false), { type: 'raffle', raffle: raffle() }, { type: 'rules' })
    expect(cardView(s)).toMatchObject({ body: 'Be nice.', actions: [{ id: 'close', label: 'Close' }] })
    s = run(s, { type: 'close' })
    expect(s.view).toBe('card')
    expect(actions(run(initialCard(false), { type: 'raffle', raffle: raffle({ rules: '  ' }) }))).toEqual(['enter'])
  })

  it('a new raffle forgets the last entry; the same raffle keeps it', () => {
    const s = run(initialCard(false), { type: 'raffle', raffle: raffle() }, { type: 'mine', entered: true, won: true })
    expect(run(s, { type: 'raffle', raffle: raffle({ entryCount: 9 }) })).toMatchObject({ entered: true, won: true })
    expect(run(s, { type: 'raffle', raffle: raffle({ id: 'r2' }) })).toMatchObject({ entered: false, won: false })
    expect(run(s, { type: 'raffle', raffle: null })).toMatchObject({ raffle: null, entered: false })
  })

  it('a failed enter shows a short note and returns to the card', () => {
    const s = run(initialCard(false), { type: 'raffle', raffle: raffle() }, { type: 'enter' }, { type: 'confirm' }, { type: 'failed', note: 'Entries are closed.' })
    expect(s).toMatchObject({ busy: false, view: 'card', note: 'Entries are closed.' })
    expect(cardView(s).note).toBe('Entries are closed.')
  })

  it('1 entry reads singular', () => {
    expect(cardView(run(initialCard(false), { type: 'raffle', raffle: raffle({ entryCount: 1 }) })).entries).toBe('1 entry')
  })
})

describe('raffleEntryError', () => {
  it('maps server codes to short text', () => {
    expect(raffleEntryError(new Error('HTTP 409: {"error":"entry_closed"}'))).toBe('Entries are closed.')
    expect(raffleEntryError(new Error('HTTP 403: {"error":"wallet_required"}'))).toBe('Sign in with a wallet to enter.')
    expect(raffleEntryError(new Error('HTTP 429: {"error":"rate_limited"}'))).toBe('Too many tries. Wait a moment.')
    expect(raffleEntryError(new Error('boom'))).toBe('Something went wrong. Try again.')
  })
})

describe('plainText', () => {
  it('keeps names from being read as rich-text tags', () => {
    expect(plainText('<b>Bob</b>')).toBe('<​b>Bob<​/b>')
    expect(plainText('Ana')).toBe('Ana')
  })
})

describe('CheckInClock', () => {
  it('fires every CHECKIN_INTERVAL_MS while active and resets when not', () => {
    const clock = new CheckInClock()
    const step = CHECKIN_INTERVAL_MS / 1000 / 2
    expect(clock.tick(step, true)).toBe(false)
    expect(clock.tick(step, true)).toBe(true)
    expect(clock.tick(step, true)).toBe(false)
    expect(clock.tick(step, false)).toBe(false)
    expect(clock.tick(step, true)).toBe(false)
    expect(clock.tick(step, true)).toBe(true)
  })
})

describe('host Raffle tab helpers', () => {
  const r = (id: string, status: string) => ({ id, name: id, status, entryCount: 0 })
  it('picks the running raffle, else the newest draft', () => {
    expect(pickHostRaffle([r('d2', 'draft'), r('o1', 'open'), r('d1', 'draft')])!.id).toBe('o1')
    expect(pickHostRaffle([r('c1', 'closed'), r('d2', 'draft'), r('d1', 'draft')])!.id).toBe('d2')
    expect(pickHostRaffle([r('c1', 'closed')])).toBeNull()
  })

  it('counts entrants checked in within the present window', () => {
    const now = Date.parse('2026-11-13T12:00:00Z')
    expect(presentNow([
      { lastSeenAt: '2026-11-13T11:59:30Z' },
      { lastSeenAt: '2026-11-13T11:58:30Z' },
      { lastSeenAt: null },
    ], now)).toBe(1)
  })

  it('shows server error codes as short messages', () => {
    expect(raffleHostError(new Error('HTTP 409: {"error":"empty_pool","message":"x"}'))).toBe('Nobody qualifies yet: take a snapshot while entrants are in the scene.')
    expect(raffleHostError(new Error('HTTP 409: {"error":"draw_in_progress"}'))).toBe('A draw just happened. Wait a few seconds.')
    expect(raffleHostError(new Error('HTTP 403: {"error":"forbidden"}'))).toBe("You can't run raffles in this scene.")
    expect(raffleHostError(new Error('nope'))).toBe('Something went wrong — try again')
  })
})
