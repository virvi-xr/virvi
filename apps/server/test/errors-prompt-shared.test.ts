import { describe, it, expect } from 'vitest'
import {
  promptDecision, PROMPT_INTERVAL_MS, KNOWN_MIN_REPORTS, checkErrorReport, checkErrorBatch, errorSignature, ERROR_LIMITS,
  type PromptFacts, type PromptState,
} from '@virvixr/shared'

/** LIV-66 phase 2, shared rules: when to ask a user about an error, and what a report may carry. */

const NOW = Date.parse('2026-11-08T12:00:00Z')
const facts = (over: Partial<PromptFacts> = {}): PromptFacts => ({ expected: false, reports: 0, openIssue: false, ...over })
const state = (over: Partial<PromptState> = {}): PromptState => ({ askedAt: null, optedOut: false, knownShown: false, ...over })

describe('promptDecision', () => {
  it('asks when the error broke what the user was doing, is not expected, lacks context, and they were not asked lately', () => {
    expect(promptDecision(true, facts(), state(), NOW)).toBe('ask')
    expect(promptDecision(true, facts({ openIssue: true, reports: 2 }), state(), NOW)).toBe('ask')
  })

  it('never shows anything for a background error', () => {
    expect(promptDecision(false, facts(), state(), NOW)).toBe('none')
    expect(promptDecision(false, facts({ openIssue: true, reports: 5 }), state(), NOW)).toBe('none')
  })

  it('never asks about an expected 4xx, and does not say "we know" either', () => {
    expect(promptDecision(true, facts({ expected: true }), state(), NOW)).toBe('none')
    expect(promptDecision(true, facts({ expected: true, openIssue: true, reports: 9 }), state(), NOW)).toBe('none')
  })

  it('asks at most once per 24 hours', () => {
    expect(promptDecision(true, facts(), state({ askedAt: NOW - PROMPT_INTERVAL_MS + 1 }), NOW)).toBe('none')
    expect(promptDecision(true, facts(), state({ askedAt: NOW - PROMPT_INTERVAL_MS }), NOW)).toBe('ask')
    // asked lately, but the issue is known: they hear that instead
    expect(promptDecision(true, facts({ openIssue: true }), state({ askedAt: NOW - 1000 }), NOW)).toBe('known')
  })

  it('never asks someone who turned prompts off', () => {
    expect(promptDecision(true, facts(), state({ optedOut: true }), NOW)).toBe('none')
    expect(promptDecision(true, facts({ openIssue: true }), state({ optedOut: true }), NOW)).toBe('known')
  })

  it(`never asks about a signature with ${KNOWN_MIN_REPORTS} descriptions: "we know about this" instead, once`, () => {
    expect(KNOWN_MIN_REPORTS).toBe(3)
    expect(promptDecision(true, facts({ reports: 3 }), state(), NOW)).toBe('known')
    expect(promptDecision(true, facts({ reports: 3, openIssue: true }), state(), NOW)).toBe('known')
    expect(promptDecision(true, facts({ reports: 3 }), state({ knownShown: true }), NOW)).toBe('none')
  })
})

describe('checkErrorReport (phase 2)', () => {
  const event = { kind: 'crash', t: NOW, route: '/scenes', errorType: 'Error', message: 'boom' }
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')

  it('takes a report with no error (the help menu): a report event of the page', () => {
    const r = checkErrorReport({ v: 1, description: 'The save button does nothing', event: { kind: 'report', t: NOW, route: '/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab' } }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(errorSignature({ kind: r.event.kind, path: r.event.route })).toBe('report /scenes/:id')
  })

  it('never takes a report event in an ingest batch', () => {
    expect(checkErrorBatch({ v: 1, events: [{ kind: 'report', t: NOW, route: '/x' }] }, NOW).ok).toBe(false)
  })

  it('takes an optional PNG, JPEG or WebP screenshot of at most 2 MB', () => {
    expect(ERROR_LIMITS.maxScreenshotBytes).toBe(2 * 1024 * 1024)
    const ok = checkErrorReport({ v: 1, description: 'x', event, screenshot: { type: 'image/png', data: png } }, NOW)
    expect(ok.ok && ok.screenshot?.type).toBe('image/png')
    expect(ok.ok && ok.screenshot?.bytes).toBe(11)
    expect(checkErrorReport({ v: 1, description: 'x', event, screenshot: { type: 'image/gif', data: png } }, NOW).ok).toBe(false)
    expect(checkErrorReport({ v: 1, description: 'x', event, screenshot: { type: 'image/png', data: 42 } }, NOW).ok).toBe(false)
    expect(checkErrorReport({ v: 1, description: 'x', event, screenshot: { type: 'image/png', data: '***' } }, NOW).ok).toBe(false)
    const big = Buffer.alloc(ERROR_LIMITS.maxScreenshotBytes + 1).toString('base64')
    expect(checkErrorReport({ v: 1, description: 'x', event, screenshot: { type: 'image/png', data: big } }, NOW).ok).toBe(false)
    const none = checkErrorReport({ v: 1, description: 'x', event }, NOW)
    expect(none.ok && none.screenshot).toBe(null)
  })
})
