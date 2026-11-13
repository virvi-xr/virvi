import { describe, it, expect } from 'vitest'
import {
  cleanDisplayName, shortWallet, raffleConsentText, RAFFLE_HOST_TERMS, RAFFLE_RULES_TEMPLATE,
  RAFFLE_CONSENT_VERSION, CHECKIN_INTERVAL_MS, PRESENT_WINDOW_MS, CHECKIN_CAP_SECONDS, CHECKIN_MIN_GAP_MS,
  DRAW_COOLDOWN_MS, RAFFLE_WINNERS_MAX, MIN_PRESENT_DEFAULT_MINUTES, MIN_PRESENT_MAX_MINUTES,
  AUTO_SNAPSHOT_MINUTES, RAFFLE_RETENTION_DAYS, AUTO_CLOSE_AFTER_DRAW_DAYS, AUTO_CLOSE_AFTER_OPEN_DAYS,
  WHEEL_MAX_NAMES, DRAW_ALGORITHM,
} from '@virvixr/shared'

/** Shared raffle constants and copy (LIV-55). The shared package has no runner of its own; its tests live here. */
const W = '0xAbCdEf0123456789abcdef0123456789abcdef01'

describe('raffle constants', () => {
  it('are pinned', () => {
    expect(RAFFLE_CONSENT_VERSION).toBe(1)
    expect(CHECKIN_INTERVAL_MS).toBe(30_000)
    expect(PRESENT_WINDOW_MS).toBe(60_000)
    expect(CHECKIN_CAP_SECONDS).toBe(45)
    expect(CHECKIN_MIN_GAP_MS).toBe(20_000)
    expect(DRAW_COOLDOWN_MS).toBe(15_000)
    expect(RAFFLE_WINNERS_MAX).toBe(20)
    expect(MIN_PRESENT_DEFAULT_MINUTES).toBe(5)
    expect(MIN_PRESENT_MAX_MINUTES).toBe(120)
    expect([...AUTO_SNAPSHOT_MINUTES]).toEqual([5, 10, 15, 30])
    expect(RAFFLE_RETENTION_DAYS).toBe(30)
    expect(AUTO_CLOSE_AFTER_DRAW_DAYS).toBe(7)
    expect(AUTO_CLOSE_AFTER_OPEN_DAYS).toBe(30)
    expect(WHEEL_MAX_NAMES).toBe(60)
    expect(DRAW_ALGORITHM).toBe('v1')
  })
})

describe('cleanDisplayName', () => {
  it('trims and strips control characters', () => {
    expect(cleanDisplayName('  Alice\u0007  ', W)).toBe('Alice')
  })
  it('cuts a long name to 40 characters', () => {
    const long = 'x'.repeat(60)
    expect(cleanDisplayName(long, W)).toBe('x'.repeat(40))
  })
  it('falls back to the shortened lower-case wallet', () => {
    expect(cleanDisplayName('', W)).toBe('0xabcd…ef01')
    expect(cleanDisplayName(null, W)).toBe('0xabcd…ef01')
    expect(cleanDisplayName(undefined, W)).toBe('0xabcd…ef01')
    expect(cleanDisplayName(' \u0007 ', W)).toBe('0xabcd…ef01')
  })
  it('leaves markup unchanged (it is rendered as text)', () => {
    expect(cleanDisplayName('<b>x</b>', W)).toBe('<b>x</b>')
  })
})

describe('shortWallet', () => {
  it('returns 0x1234…abcd, lower-cased', () => {
    expect(shortWallet(W)).toBe('0xabcd…ef01')
  })
})

describe('raffle copy', () => {
  it('consent text is exact', () => {
    expect(raffleConsentText()).toBe(
      'Your display name (or a shortened wallet address if you have no name) will be shown on the raffle wheel to everyone in this scene, and your name and wallet will be shared with the host so they can deliver your prize. You can withdraw until the draw.',
    )
  })
  it('host terms are exact', () => {
    expect(RAFFLE_HOST_TERMS).toBe(
      "This raffle is free to enter and needs no purchase. I'm responsible for following the giveaway and sweepstakes rules where I and my entrants live, and for delivering prizes.",
    )
  })
  it('rules template is at most 150 words and has its placeholders', () => {
    expect(RAFFLE_RULES_TEMPLATE.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(150)
    for (const p of ['{prize}', '{winners}', '{host}']) expect(RAFFLE_RULES_TEMPLATE).toContain(p)
    expect(RAFFLE_RULES_TEMPLATE).toContain('/docs/raffles')
  })
})
