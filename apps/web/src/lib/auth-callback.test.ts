import { describe, expect, it } from 'vitest'
import { callbackBackToLogin, callbackErrorMessage } from './auth-callback'

describe('callbackErrorMessage', () => {
  it('says plainly when the person cancelled', () => {
    for (const code of ['access_denied', 'cancelled', 'user_cancelled_authorize']) expect(callbackErrorMessage(code)).toMatch(/cancelled/i)
  })
  it('says what failed for the codes the server sends', () => {
    expect(callbackErrorMessage('oauth_failed')).toMatch(/couldn.t sign you in/i)
    for (const code of ['missing_code', 'invalid_token', 'token_exchange_failed', 'user_fetch_failed']) expect(callbackErrorMessage(code)).toMatch(/try signing in again/i)
  })
  it('never shows a code it does not know, or markup', () => {
    expect(callbackErrorMessage('<b>x</b>')).toBe(callbackErrorMessage('whatever'))
    expect(callbackErrorMessage('whatever')).not.toMatch(/whatever/)
  })
  it('keeps the old message when there is no code at all', () => {
    expect(callbackErrorMessage(null)).toBe('Missing authentication parameters. Please try signing in again.')
  })
})

describe('callbackBackToLogin', () => {
  it('keeps where the person was going', () => {
    expect(callbackBackToLogin('/app-sign-in')).toBe('/signin/?next=%2Fapp-sign-in')
  })
  it('goes to plain sign-in when there is nothing safe to keep', () => {
    expect(callbackBackToLogin(null)).toBe('/signin/')
    expect(callbackBackToLogin('https://evil.example')).toBe('/signin/')
    expect(callbackBackToLogin('//evil.example')).toBe('/signin/')
  })
})
