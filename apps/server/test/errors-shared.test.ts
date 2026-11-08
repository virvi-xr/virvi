import { describe, it, expect } from 'vitest'
import {
  routeTemplate, normalizeMessage, topFrame, errorSignature, expectedReason, EXPECTED_4XX,
  redactText, redactUrl, redactValue, parseUserAgent, checkErrorBatch, checkErrorReport, ERROR_LIMITS,
} from '@virvixr/shared'

/** The shared error rules (LIV-66): the web app and the server both sign, redact and validate with these. */

describe('routeTemplate', () => {
  it('replaces ids, numbers, hex and codes so two calls to different records share one route', () => {
    expect(routeTemplate('/api/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab/presets')).toBe('/api/scenes/:id/presets')
    expect(routeTemplate('/api/scenes/aaaaaaaa-1d2a-4b3c-9d8e-0123456789ab/presets')).toBe('/api/scenes/:id/presets')
    expect(routeTemplate('/api/studio/designs/x/pieces/hat/revisions/12/report')).toBe('/api/studio/designs/x/pieces/hat/revisions/:n/report')
    expect(routeTemplate('/api/scenes/s/roles/0x00000000000000000000000000000000000000a1')).toBe('/api/scenes/s/roles/:hex')
    expect(routeTemplate('/api/hyperfy/pair/ABC123/claim')).toBe('/api/hyperfy/pair/:code/claim')
    expect(routeTemplate('/pair/headset/QWERTY')).toBe('/pair/headset/:code')
    expect(routeTemplate('/u/abcdef')).toBe('/u/:code')
    expect(routeTemplate('/s/k3y9')).toBe('/s/:code')
  })
  it('drops the query string and the hash', () => {
    expect(routeTemplate('/api/scenes?q=me@x.com&token=abc#top')).toBe('/api/scenes')
    expect(routeTemplate('https://virvi.io/api/media?x=1')).toBe('/api/media')
  })
})

describe('normalizeMessage', () => {
  it('strips ids and numbers so two errors that differ only in them read the same', () => {
    const a = normalizeMessage('Scene 3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab not found after 3 tries (took 1520ms)')
    const b = normalizeMessage('Scene 99999999-1d2a-4b3c-9d8e-0123456789ab not found after 7 tries (took 88ms)')
    expect(a).toBe(b)
    expect(a).toBe('Scene <id> not found after <n> tries (took <n>ms)')
  })
  it('redacts and caps', () => {
    expect(normalizeMessage('mail me@x.com')).toBe('mail [email]')
    expect(normalizeMessage('x'.repeat(1000)).length).toBeLessThanOrEqual(200)
  })
})

describe('topFrame', () => {
  it('reads a Chrome frame without line numbers or chunk hashes', () => {
    const stack = 'TypeError: x is undefined\n    at renderList (https://virvi.io/_next/static/chunks/app/scenes/page-3a9f0c2b1d4e5f60.js:1:2345)\n    at other (https://virvi.io/x.js:1:1)'
    expect(topFrame(stack)).toBe('renderList (/_next/static/chunks/app/scenes/page.js)')
  })
  it('reads a Firefox frame and an anonymous one', () => {
    expect(topFrame('renderList@https://virvi.io/_next/static/chunks/main-0011223344556677.js:3:9')).toBe('renderList (/_next/static/chunks/main.js)')
    expect(topFrame('Error: x\n    at https://virvi.io/_next/static/chunks/9f.js:1:1')).toBe('<anonymous> (/_next/static/chunks/<chunk>.js)')
  })
  it('is null without a stack', () => {
    expect(topFrame(undefined)).toBeNull()
    expect(topFrame('just a message')).toBeNull()
  })
})

describe('errorSignature', () => {
  it('API errors sign by status, method and route template', () => {
    const a = errorSignature({ kind: 'api', status: 500, method: 'get', path: '/api/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab?x=1' })
    const b = errorSignature({ kind: 'api', status: 500, method: 'GET', path: '/api/scenes/11111111-1d2a-4b3c-9d8e-0123456789ab' })
    expect(a).toBe(b)
    expect(a).toBe('api 500 GET /api/scenes/:id')
    expect(errorSignature({ kind: 'api', status: 404, method: 'GET', path: '/api/scenes/x' })).not.toBe(a)
  })
  it('client errors sign by type, stripped message and top frame', () => {
    const stack = (n: number) => `TypeError: Cannot read item ${n}\n    at renderList (https://virvi.io/_next/static/chunks/page-${n}a9f0c2b1d4e5f60.js:${n}:4)`
    const a = errorSignature({ kind: 'crash', errorType: 'TypeError', message: 'Cannot read item 4', stack: stack(4) })
    const b = errorSignature({ kind: 'crash', errorType: 'TypeError', message: 'Cannot read item 9', stack: stack(9) })
    expect(a).toBe(b)
    expect(a).toBe('crash TypeError: Cannot read item <n> @ renderList (/_next/static/chunks/page.js)')
  })
  it('server events sign by their own fields, apart from client ones', () => {
    expect(errorSignature({ kind: 'server_5xx', status: 503, method: 'POST', path: '/api/scenes/:sceneId' })).toBe('server_5xx 503 POST /api/scenes/:sceneId')
    expect(errorSignature({ kind: 'job', job: 'deploy', errorType: 'Error', message: 'World 12 is full' })).toBe('job deploy Error: World <n> is full')
  })
  it('failed jobs and server exceptions sign by name, type and code, with only a short prefix of the message', () => {
    // Text a user chose (names, reasons) after the first few words, or quoted, never makes a new signature
    const job = (message: string, code?: string) => errorSignature({ kind: 'job', job: 'import_start', errorType: 'ImportError', message, code })
    expect(job('bad_zip: The zip file "my scene 1" could not be opened')).toBe(job('bad_zip: The zip file "another 22" could not be read at all'))
    expect(job('bad_zip: The zip file is broken')).toBe('job import_start ImportError bad_zip: The zip file is')
    expect(job('Decentraland rejected the deploy: name alice-world taken')).toBe(job('Decentraland rejected the deploy: bob owns this'))
    expect(job('anything at all', 'grant_revoked')).toBe('job import_start ImportError grant_revoked: anything at all')
    expect(job('x', 'grant_revoked')).not.toBe(job('x', 'cancelled'))
    expect(job('a'.repeat(300))).toHaveLength('job import_start ImportError: '.length + 40)
    const exc = (message: string) => errorSignature({ kind: 'server_exception', errorType: 'Error', message, stack: 'Error: x\n    at handle (/app/dist/routes/import.js:1:2)' })
    expect(exc('Unexpected token in "user text 1" here and more words')).toBe(exc('Unexpected token in "other 9" here, then different words'))
    expect(exc('Unexpected token in json')).toBe('server_exception Error: Unexpected token in json @ handle (/app/dist/routes/import.js)')
    // Browser errors keep their whole (stripped) message
    expect(errorSignature({ kind: 'exception', errorType: 'E', message: 'one two three four five six' })).toBe('exception E: one two three four five six')
  })
})

describe('expected 4xx (one list, never filed)', () => {
  it('covers renewal and dead sessions, validation, uploads and explained refusals', () => {
    expect(expectedReason(401)).toBe('session')
    expect(expectedReason(403, { error: 'account_required' })).toBe('permission')
    expect(expectedReason(400, { error: 'name is required' })).toBe('validation')
    expect(expectedReason(422)).toBe('validation')
    expect(expectedReason(413)).toBe('upload_too_large')
    expect(expectedReason(415)).toBe('upload_type')
  })
  it('anything else is not expected', () => {
    for (const s of [404, 409, 429, 500, 502, 503]) expect(expectedReason(s), String(s)).toBeNull()
  })
  it('the list is the documented one', () => {
    expect(Object.keys(EXPECTED_4XX).map(Number).sort()).toEqual([400, 401, 403, 413, 415, 422])
  })
})

describe('redaction (fixtures)', () => {
  const FIXTURES: Array<[string, string]> = [
    ['token eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMyJ9.abcDEF_123-x failed', 'token [token] failed'],
    ['Authorization: Bearer abc.def-123', 'Authorization: Bearer [token]'],
    ['key virvi_1234567890abcdef used', 'key [token] used'],
    ['stripe sk_live_51Habcdefghijk', 'stripe [token]'],
    ['who: jane.doe+x@example.co.uk', 'who: [email]'],
    ['wallet 0x52908400098527886E0F7030069857D2E4169EE7 is not the owner', 'wallet [wallet] is not the owner'],
    ['sig 0x' + 'ab'.repeat(65), 'sig [hex]'],
    ['GET /api/scenes?token=abc&email=a@b.co failed', 'GET /api/scenes failed'],
    ['https://virvi.io/auth/callback?code=xyz#frag', 'https://virvi.io/auth/callback'],
    ['card 4242 4242 4242 4242 declined', 'card [number] declined'],
    ['opaque Zk3mQ9vR2xL8pT4wY7nB1cF6hJ0sD5aE', 'opaque [token]'],
  ]
  for (const [input, out] of FIXTURES) it(`redacts: ${input.slice(0, 40)}`, () => expect(redactText(input)).toBe(out))

  it('keeps ordinary words, ids and numbers', () => {
    expect(redactText('Scene 3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab not found (404)')).toBe('Scene 3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab not found (404)')
  })

  it('redactUrl drops the query and the codes in credential paths', () => {
    expect(redactUrl('https://virvi.io/pair/ABC123?x=1')).toBe('https://virvi.io/pair/:code')
    expect(redactUrl('/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab?tab=roles')).toBe('/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab')
  })

  it('redactValue drops secret-looking keys and redacts strings in an error body', () => {
    const v = redactValue({
      error: 'bad email me@x.com', password: 'hunter2', nested: { accessToken: 'abc', signature: '0x12', note: 'ok' },
      card: { number: '4242' }, list: ['a@b.co'],
    }) as any
    expect(v).toEqual({ error: 'bad email [email]', password: '[redacted]', nested: { accessToken: '[redacted]', signature: '[redacted]', note: 'ok' }, card: '[redacted]', list: ['[email]'] })
  })
})

describe('parseUserAgent', () => {
  it('reads browser and OS coarsely', () => {
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toEqual({ browser: 'Chrome 131', os: 'macOS' })
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toEqual({ browser: 'Edge 130', os: 'Windows' })
    expect(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'Safari 17', os: 'iOS' })
    expect(parseUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toEqual({ browser: 'Firefox 132', os: 'Linux' })
    expect(parseUserAgent('Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0 Chrome/128.0 Mobile VR Safari/537.36')).toEqual({ browser: 'Quest Browser 35', os: 'Quest' })
    expect(parseUserAgent(undefined)).toEqual({ browser: 'Other', os: 'Other' })
  })
})

describe('checkErrorBatch', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  const api = { kind: 'api', t: now, route: '/scenes', method: 'GET', path: '/api/scenes', status: 500, requestId: 'r1' }
  it('takes a well-formed batch and redacts every string again', () => {
    const r = checkErrorBatch({ v: 1, release: 'abc1234', events: [
      api,
      { kind: 'crash', t: now, route: '/scenes?x=me@x.com', errorType: 'TypeError', message: 'for me@x.com', stack: 'at f (https://virvi.io/a.js:1:1)',
        breadcrumbs: [{ t: now, type: 'click', label: 'Save me@x.com' }, { t: now, type: 'api', method: 'GET', path: '/api/x?token=1', status: 500, ms: 12, requestId: 'r' }] },
    ] }, now)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.release).toBe('abc1234')
    expect(r.events[1].route).toBe('/scenes')
    expect(r.events[1].message).toBe('for [email]')
    expect(r.events[1].breadcrumbs?.[0].label).toBe('Save [email]')
    expect(r.events[1].breadcrumbs?.[1].path).toBe('/api/x')
  })
  it('refuses bad shapes', () => {
    expect(checkErrorBatch(null, now).ok).toBe(false)
    expect(checkErrorBatch({ v: 2, events: [api] }, now).ok).toBe(false)
    expect(checkErrorBatch({ v: 1, events: [] }, now).ok).toBe(false)
    expect(checkErrorBatch({ v: 1, events: Array(ERROR_LIMITS.maxEvents + 1).fill(api) }, now).ok).toBe(false)
    expect(checkErrorBatch({ v: 1, events: [{ ...api, kind: 'server_5xx' }] }, now).ok).toBe(false) // clients can't send server events
    expect(checkErrorBatch({ v: 1, events: [{ ...api, status: 'x' }] }, now).ok).toBe(false)
    expect(checkErrorBatch({ v: 1, events: [{ ...api, breadcrumbs: Array(31).fill({ t: now, type: 'nav', path: '/' }) }] }, now).ok).toBe(false)
  })
  it('never takes a user, org or browser from the client', () => {
    const r = checkErrorBatch({ v: 1, events: [{ ...api, userId: 'u', userHash: 'h', orgId: 'o', browser: 'b' }] }, now)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.events[0])).not.toEqual(expect.arrayContaining(['userId']))
    if (r.ok) for (const k of ['userId', 'userHash', 'orgId', 'browser']) expect(k in r.events[0], k).toBe(false)
  })
  it('clamps a client clock that is far off, and caps counts', () => {
    const r = checkErrorBatch({ v: 1, events: [{ ...api, t: now - 10 * 86_400_000, count: 1e9 }] }, now)
    expect(r.ok && r.events[0].t).toBe(now)
    expect(r.ok && r.events[0].count).toBe(ERROR_LIMITS.maxCount)
  })
})

describe('checkErrorReport', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  const event = { kind: 'crash', t: now, route: '/scenes', errorType: 'Error', message: 'boom' }
  it('needs a description of what the user was doing', () => {
    expect(checkErrorReport({ v: 1, description: '  ', event }, now).ok).toBe(false)
    const r = checkErrorReport({ v: 1, description: ' Saving my scene ', event }, now)
    expect(r.ok && r.description).toBe('Saving my scene')
    expect(checkErrorReport({ v: 1, description: 'x'.repeat(ERROR_LIMITS.maxDescription + 1), event }, now).ok).toBe(false)
    expect(checkErrorReport({ v: 1, description: 'x' }, now).ok).toBe(false)
  })
})

// ── Fix round 1 ──────────────────────────────────────────────────────────────

describe('redaction gaps (M3)', () => {
  it('drops a query string with no slash before it, two-part JWTs, key=value secrets and shorter mixed tokens', () => {
    expect(redactText('back to callback?code=SECRET123 now')).toBe('back to callback now')
    expect(redactText('jwt eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMyJ9 end')).toBe('jwt [token] end')
    expect(redactText('failed with token=abcd1234efgh and session=abcdef, Code=99')).toBe('failed with token=[redacted] and session=[redacted], Code=[redacted]')
    expect(redactText('id Ab3dE6gH9jK2mN5pQ8rS1t')).toBe('id [token]')
    expect(redactText('plain words stay: Why? Because.')).toBe('plain words stay: Why? Because.')
    expect(redactText('issue #123 and page#frag')).toBe('issue #123 and page')
  })
})

describe('redaction runs in linear time (I1)', () => {
  const N = 64 * 1024
  const ADVERSARIAL = [
    '/'.repeat(N), '@'.repeat(N), 'a'.repeat(N), 'a@'.repeat(N / 2), 'eyJ'.repeat(N / 3), 'eyJ' + 'a'.repeat(N),
    '0x'.repeat(N / 2), '0'.repeat(N), '1 '.repeat(N / 2), '?'.repeat(N), '/a'.repeat(N / 2) + '?', 'x.'.repeat(N / 2) + '@',
    'a'.repeat(N - 1) + '@', 'token='.repeat(N / 6), 'Ab1'.repeat(N / 3), 'at f (' + '('.repeat(N) + ')',
  ]
  it('64 KB of adversarial text takes well under 50 ms per pattern family', () => {
    for (const s of ADVERSARIAL) {
      const t0 = performance.now()
      redactText(s)
      normalizeMessage(s)
      topFrame(s)
      routeTemplate(s)
      const ms = performance.now() - t0
      expect(ms, `${s.slice(0, 12)}… took ${ms.toFixed(1)} ms`).toBeLessThan(50)
    }
  })
  it('a 64 KB adversarial batch validates in well under 100 ms', () => {
    const stack = 'Error\n' + '    at f (https://virvi.io/' + '/'.repeat(3900) + ')\n'
    const ev = { kind: 'exception', t: Date.now(), message: '@'.repeat(ERROR_LIMITS.maxMessage), stack, route: '/'.repeat(300), breadcrumbs: Array(30).fill({ t: 1, type: 'click', label: 'a@'.repeat(40) }) }
    const t0 = performance.now()
    const r = checkErrorBatch({ v: 1, events: Array(ERROR_LIMITS.maxEvents).fill(ev) }, Date.now())
    for (const e of r.ok ? r.events : []) errorSignature(e)
    expect(performance.now() - t0).toBeLessThan(100)
  })
})

describe('top frames are stable across builds (I5)', () => {
  // The same bug in two production builds: different chunk hashes, mangled names, chunk ids and line numbers
  const BUILD_A = `TypeError: Cannot read properties of undefined (reading 'name')
    at Object.nR [as onClick] (https://virvi.io/_next/static/chunks/app/(dashboard)/scenes/%5BsceneId%5D/page-3a9f0c2b1d4e5f60.js:1:9991)
    at eT (https://virvi.io/_next/static/chunks/5748-aeb20f71ad358c32.js:1:23)`
  const BUILD_B = `TypeError: Cannot read properties of undefined (reading 'name')
    at Object.kQ [as onClick] (https://virvi.io/_next/static/chunks/app/(dashboard)/scenes/%5BsceneId%5D/page-77ab01cd99ef2345.js:1:10450)
    at aZ (https://virvi.io/_next/static/chunks/4417-0011223344556677.js:1:99)`
  it('parses route-group paths and keeps the stable parts', () => {
    expect(topFrame(BUILD_A)).toBe('onClick (/_next/static/chunks/app/(dashboard)/scenes/%5BsceneId%5D/page.js)')
    expect(topFrame(BUILD_B)).toBe(topFrame(BUILD_A))
  })
  it('gives one signature for the same crash in two builds', () => {
    const sig = (stack: string) => errorSignature({ kind: 'crash', errorType: 'TypeError', message: "Cannot read properties of undefined (reading 'name')", stack })
    expect(sig(BUILD_A)).toBe(sig(BUILD_B))
  })
  it('drops mangled names and numeric chunk ids, keeps real names', () => {
    expect(topFrame('Error\n    at eT (https://virvi.io/_next/static/chunks/5748-aeb20f71ad358c32.js:1:23)')).toBe('<anonymous> (/_next/static/chunks/<chunk>.js)')
    expect(topFrame('Error\n    at saveScene (https://virvi.io/_next/static/chunks/app/page-aeb20f71ad358c32.js:1:23)')).toBe('saveScene (/_next/static/chunks/app/page.js)')
    expect(topFrame('Error\n    at async Promise.all (index 0)\n    at load (https://virvi.io/_next/static/chunks/main-app-0011223344556677.js:2:3)')).toBe('load (/_next/static/chunks/main-app.js)')
    expect(topFrame('Error\n    at handler (/app/apps/server/dist/routes/scenes.js:10:5)\n    at node:internal/x:1:1')).toBe('handler (/app/apps/server/dist/routes/scenes.js)')
  })
})

describe('client claims are only taken in the right format (M4) and counts are small (I2)', () => {
  const now = Date.now()
  const api = { kind: 'api', t: now, method: 'GET', path: '/api/x', status: 500 }
  it('takes a release that looks like a commit SHA or dev, and a request ID that is a UUID', () => {
    const r = checkErrorBatch({ v: 1, release: 'ABCDEF1234567890', events: [{ ...api, requestId: 'not-a-uuid' }] }, now)
    expect(r.ok && r.release).toBe(null)
    expect(r.ok && r.events[0].requestId).toBeUndefined()
    const ok = checkErrorBatch({ v: 1, release: 'abcdef1234567890', events: [{ ...api, requestId: '3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab' }] }, now)
    expect(ok.ok && ok.release).toBe('abcdef123456')
    expect(ok.ok && ok.events[0].requestId).toBe('3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab')
    expect(checkErrorBatch({ v: 1, release: 'dev', events: [api] }, now).ok && true).toBe(true)
  })
  it('a client count is capped at 20', () => {
    expect(ERROR_LIMITS.maxCount).toBe(20)
  })
})
