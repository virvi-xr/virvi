import { describe, it, expect } from 'vitest'
import { appSignInRedirect, appHandoffErrorMessage, APP_SIGNED_IN_MESSAGE } from './app-sign-in'
import { safeNextPath } from './next-path'
import { headsetPairView, pairPageHref, visitorApprovalCopy } from './pairing'
import { signUpButtons } from './trial'

describe('appSignInRedirect', () => {
  it('hands the code back over https, on the site the person signed in on', () => {
    expect(appSignInRedirect('abc', 'https://virvi.io')).toBe('https://virvi.io/app-signed-in?code=abc')
    expect(appSignInRedirect('abc', 'https://staging.virvi.io')).toBe('https://staging.virvi.io/app-signed-in?code=abc')
    expect(appSignInRedirect('abc', 'http://localhost:3000')).toBe('http://localhost:3000/app-signed-in?code=abc')
  })
  it('URL-encodes the code', () => {
    expect(appSignInRedirect('a b&c=d/e', 'https://virvi.io')).toBe('https://virvi.io/app-signed-in?code=a%20b%26c%3Dd%2Fe')
  })
  it('never uses the old virvi:// link', () => {
    expect(appSignInRedirect('abc', 'https://virvi.io')).not.toMatch(/^virvi:/)
  })
})

describe('the /app-signed-in page', () => {
  it('says only to return to the app, never anything about the code', () => {
    expect(APP_SIGNED_IN_MESSAGE).toBe('Return to the Virvi app.')
  })
})

describe('appHandoffErrorMessage', () => {
  it('says plainly when a trial or scene pass is refused', () => {
    expect(appHandoffErrorMessage({ status: 401 })).toMatch(/sign in with an account/i)
  })
  it('asks to wait when rate limited', () => {
    expect(appHandoffErrorMessage({ status: 429 })).toMatch(/moment/i)
  })
  it('falls back to a generic message', () => {
    expect(appHandoffErrorMessage(new Error('x'))).toMatch(/try again/i)
  })
})

describe('the sign-in callback return path', () => {
  it('keeps /app-sign-in', () => {
    expect(safeNextPath('/app-sign-in')).toBe('/app-sign-in')
    expect(safeNextPath('/app-sign-in/')).toBe('/app-sign-in/')
  })
  it('drops anything that leaves the site', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'virvi://x', 'evil']) {
      expect(safeNextPath(bad)).toBeNull()
    }
  })
})

describe('headset pairing views', () => {
  it('a visitor code never gets the personal/shared picker', () => {
    expect(headsetPairView('visitor')).toBe('visitor')
  })
  it('builder (and an older server that sends no purpose) keeps the picker', () => {
    expect(headsetPairView('builder')).toBe('builder')
    expect(headsetPairView(undefined)).toBe('builder')
  })
  it('the pair page link carries the code as a query param', () => {
    expect(pairPageHref('ABCD2345')).toBe('/pair/?code=ABCD2345')
  })
  it('the visitor confirmation says what will happen', () => {
    const c = visitorApprovalCopy('Quest 3 of Sam')
    expect(c.heading).toBe('Sign this headset in to your Virvi account')
    expect(c.device).toBe('Device name (reported by the device): Quest 3 of Sam')
    expect(c.warning).toBe("Only approve a headset you're holding. It will be signed in as you, with full access to your Virvi account.")
    expect(visitorApprovalCopy(null).device).toMatch(/did not report a name/i)
  })
})

describe('Apple sign-in button', () => {
  it('shows only when the server has Apple', () => {
    const p = { google: false, discord: false }
    expect(signUpButtons('signin', { ...p, apple: true }, false).map((b) => b.id)).toEqual(['apple'])
    expect(signUpButtons('signin', { ...p, apple: false }, false)).toEqual([])
  })
})
