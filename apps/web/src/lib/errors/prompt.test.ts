import { describe, it, expect } from 'vitest'
import { PROMPT_INTERVAL_MS, type ClientErrorEvent } from '@virvixr/shared'
import {
  shouldCheckPrompt, promptKey, promptRequestBody, readLocal, writeLocal, decideFromAnswer, promptDecision, LOCAL_KEY, type PromptAnswer,
} from './prompt'

/** LIV-66 §4 in the browser: which errors are worth asking about, and the guest's own 24-hour and opt-out state. */

const NOW = 1_800_000_000_000
const failedSave = (over: Partial<ClientErrorEvent> = {}): ClientErrorEvent => ({
  kind: 'api', t: NOW, route: '/scenes/x', method: 'PUT', path: '/api/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab', status: 500, userFacing: true,
  requestId: '0b1c2d3e-0000-4000-8000-000000000001', errorBody: { error: 'boom', email: 'me@x.com' },
  breadcrumbs: [{ t: NOW, type: 'click', label: 'Save' }], sceneId: '3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab', ...over,
})
const answer = (over: Partial<PromptAnswer> = {}): PromptAnswer => ({ prompt: 'ask', saved: false, signature: 'sig1', facts: { expected: false, reports: 0, openIssue: false }, ...over })

class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
}

describe('shouldCheckPrompt: only errors that broke what the user was doing', () => {
  it('a failed save the user asked for', () => {
    expect(shouldCheckPrompt(failedSave())).toBe(true)
  })
  it('never a background request', () => {
    expect(shouldCheckPrompt(failedSave({ userFacing: undefined }))).toBe(false)
    expect(shouldCheckPrompt({ kind: 'exception', t: NOW, message: 'x' })).toBe(false)
  })
  it('never an expected 4xx (validation, session, permission, upload size or type)', () => {
    for (const status of [400, 401, 403, 413, 415, 422]) expect(shouldCheckPrompt(failedSave({ status })), String(status)).toBe(false)
    expect(shouldCheckPrompt(failedSave({ status: 409 }))).toBe(true)
  })
  it('never a crash screen: it has its own Report button and no auto-prompt', () => {
    expect(shouldCheckPrompt({ kind: 'crash', t: NOW, message: 'x', userFacing: true })).toBe(false)
  })
})

describe('the prompt check sends the signature only', () => {
  it('no breadcrumbs, error body, page, scene or request id', () => {
    const body = JSON.parse(promptRequestBody(failedSave()))
    expect(body).toEqual({ v: 1, event: { kind: 'api', t: NOW, method: 'PUT', path: '/api/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab', status: 500, userFacing: true } })
  })
  it('two failures differing only in an id are one check', () => {
    expect(promptKey(failedSave())).toBe(promptKey(failedSave({ path: '/api/scenes/aaaaaaaa-1d2a-4b3c-9d8e-0123456789ab' })))
    expect(promptKey(failedSave())).not.toBe(promptKey(failedSave({ status: 502 })))
  })
})

describe('a guest keeps its own prompt state (localStorage)', () => {
  it('is asked at most once in 24 hours', () => {
    const s = new MemoryStorage()
    let r = decideFromAnswer(answer(), readLocal(s), NOW)
    expect(r.prompt).toBe('ask')
    writeLocal(s, r.local)
    r = decideFromAnswer(answer({ signature: 'sig2' }), readLocal(s), NOW + 60_000)
    expect(r.prompt).toBe('none')
    r = decideFromAnswer(answer(), readLocal(s), NOW + PROMPT_INTERVAL_MS)
    expect(r.prompt).toBe('ask')
  })
  it('hears "we know about this" once per signature', () => {
    const s = new MemoryStorage()
    const known = answer({ prompt: 'known', facts: { expected: false, reports: 3, openIssue: true } })
    const r = decideFromAnswer(known, readLocal(s), NOW)
    expect(r.prompt).toBe('known')
    writeLocal(s, r.local)
    expect(decideFromAnswer(known, readLocal(s), NOW + 1000).prompt).toBe('none')
    expect(decideFromAnswer({ ...known, signature: 'other' }, readLocal(s), NOW + 1000).prompt).toBe('known')
  })
  it('"Don\'t ask me about errors" stops the asking', () => {
    const s = new MemoryStorage()
    writeLocal(s, { ...readLocal(s), optedOut: true })
    expect(decideFromAnswer(answer(), readLocal(s), NOW).prompt).toBe('none')
  })
  it('an account’s answer was already decided (and saved) by the server', () => {
    const s = new MemoryStorage()
    writeLocal(s, { askedAt: NOW, optedOut: true, known: [] })
    const r = decideFromAnswer(answer({ saved: true, prompt: 'ask' }), readLocal(s), NOW)
    expect(r.prompt).toBe('ask')
    expect(r.local).toEqual(readLocal(s))
  })
  it('bad or missing storage is a fresh state, and the known list stays short', () => {
    const s = new MemoryStorage()
    s.setItem(LOCAL_KEY, '{nope')
    expect(readLocal(s)).toEqual({ askedAt: null, optedOut: false, known: [] })
    expect(readLocal(null)).toEqual({ askedAt: null, optedOut: false, known: [] })
    let local = readLocal(s)
    for (let i = 0; i < 300; i++) local = decideFromAnswer(answer({ prompt: 'known', signature: `s${i}`, facts: { expected: false, reports: 3, openIssue: false } }), local, NOW).local
    expect(local.known.length).toBe(200)
  })
  it('uses the shared rule', () => {
    expect(promptDecision(true, { expected: false, reports: 0, openIssue: false }, { askedAt: null, optedOut: false, knownShown: false }, NOW)).toBe('ask')
  })
})
