import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TERMS_VERSION, termsDateLabel } from '@virvixr/shared'
import { termsGate, type TermsStatus } from './terms'

const status = (s: Partial<TermsStatus>): TermsStatus => ({ version: TERMS_VERSION, accepted: false, acceptedVersion: null, ...s })

describe('termsGate', () => {
  it('shows nothing until the status has loaded, or once the current Terms are agreed', () => {
    expect(termsGate(null)).toBeNull()
    expect(termsGate(status({ accepted: true, acceptedVersion: TERMS_VERSION }))).toBeNull()
  })

  it('asks an account that never agreed to agree', () => {
    expect(termsGate(status({}))).toEqual({
      title: 'Agree to the Terms of Service',
      body: 'To keep using Virvi, please read and agree to our Terms of Service.',
    })
  })

  it('tells an account that agreed to older Terms that they changed, and when', () => {
    expect(termsGate(status({ acceptedVersion: '2020-01-01' }))).toEqual({
      title: 'Our Terms of Service have changed',
      body: `We updated our Terms of Service on ${termsDateLabel(TERMS_VERSION)}. To keep using Virvi, please read and agree to them.`,
    })
  })
})

describe('termsDateLabel', () => {
  it('reads a version as a date', () => {
    expect(termsDateLabel('2026-11-18')).toBe('18 November 2026')
    expect(termsDateLabel('2027-01-05')).toBe('5 January 2027')
  })
})

describe('the Terms pages', () => {
  // Changing TERMS_VERSION asks everyone to agree again: the pages they're sent to must be the new text
  it('show the date of the version in force', () => {
    const line = `Last updated: ${termsDateLabel(TERMS_VERSION)}`
    expect(readFileSync(new URL('../app/terms/page.tsx', import.meta.url), 'utf8')).toContain(line)
    expect(readFileSync(new URL('../../../docs/src/content/docs/terms.md', import.meta.url), 'utf8')).toContain(line)
  })
})
