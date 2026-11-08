import { describe, it, expect } from 'vitest'
import { isOwnSource, errorEvent, apiErrorEvent, buildReport, reportPreview, shouldReportApi } from './capture'

const ORIGIN = 'https://virvi.io'

describe('isOwnSource: extensions and third-party scripts are dropped', () => {
  it('keeps our own scripts', () => {
    expect(isOwnSource({ filename: 'https://virvi.io/_next/static/chunks/main.js' }, ORIGIN)).toBe(true)
    expect(isOwnSource({ stack: 'TypeError: x\n    at f (https://virvi.io/_next/static/chunks/a.js:1:2)' }, ORIGIN)).toBe(true)
    expect(isOwnSource({ stack: 'Error: plain' }, ORIGIN)).toBe(true) // a thrown value with no frames
  })
  it('drops extensions and other origins', () => {
    expect(isOwnSource({ filename: 'chrome-extension://abcdef/content.js' }, ORIGIN)).toBe(false)
    expect(isOwnSource({ stack: 'Error\n    at x (moz-extension://1234/inject.js:1:1)' }, ORIGIN)).toBe(false)
    expect(isOwnSource({ stack: 'e@safari-web-extension://abc/x.js:1:1' }, ORIGIN)).toBe(false)
    expect(isOwnSource({ filename: 'https://www.googletagmanager.com/gtm.js' }, ORIGIN)).toBe(false)
    expect(isOwnSource({ message: 'Script error.' }, ORIGIN)).toBe(false) // a cross-origin script's opaque error
  })
})

describe('errorEvent', () => {
  it('reads an Error, redacted, with the page and breadcrumbs', () => {
    const err = new TypeError('no scene for me@x.com')
    err.stack = 'TypeError: no scene for me@x.com\n    at f (https://virvi.io/a.js?token=abc:1:2)'
    const e = errorEvent('crash', err, { route: '/scenes/x?tab=1', breadcrumbs: [{ t: 1, type: 'nav', path: '/' }], userFacing: true, now: 7 })
    expect(e).toEqual({
      kind: 'crash', t: 7, route: '/scenes/x', errorType: 'TypeError', message: 'no scene for [email]',
      stack: 'TypeError: no scene for [email]\n    at f (https://virvi.io/a.js', breadcrumbs: [{ t: 1, type: 'nav', path: '/' }], userFacing: true,
    })
  })
  it('reads a thrown non-Error', () => {
    expect(errorEvent('rejection', 'went wrong', { route: '/', breadcrumbs: [], now: 1 })).toMatchObject({ errorType: 'Error', message: 'went wrong' })
    expect(errorEvent('rejection', { reason: 1 }, { route: '/', breadcrumbs: [], now: 1 }).message).toBe('{"reason":1}')
  })
})

describe('apiErrorEvent', () => {
  it('keeps only the redacted error body, never the request body', () => {
    const e = apiErrorEvent({ method: 'post', path: '/api/auth/login?x=1', status: 400, requestId: 'r1', body: { error: 'bad', password: 'hunter2' } }, { route: '/signin', breadcrumbs: [], now: 3 })
    expect(e).toEqual({ kind: 'api', t: 3, route: '/signin', method: 'POST', path: '/api/auth/login', status: 400, requestId: 'r1', errorBody: { error: 'bad', password: '[redacted]' }, breadcrumbs: [] })
  })
  it('never reports the error endpoint itself', () => {
    expect(shouldReportApi('/api/errors')).toBe(false)
    expect(shouldReportApi('/api/errors/reports')).toBe(false)
    expect(shouldReportApi('/api/scenes')).toBe(true)
  })
})

describe('the Report form payload', () => {
  it('the "What we\'ll send" preview is exactly the submitted body', () => {
    const event = errorEvent('crash', new Error('boom'), { route: '/scenes', breadcrumbs: [{ t: 1, type: 'click', label: 'Save' }], now: 5 })
    const payload = buildReport('  Saving my scene  ', event, 'abc123')
    expect(payload).toEqual({ v: 1, release: 'abc123', description: 'Saving my scene', event })
    expect(reportPreview(payload)).toBe(JSON.stringify(payload, null, 2))
    expect(JSON.parse(reportPreview(payload))).toEqual(payload)
  })
})
