import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseSse, streamAssistant } from './sse'

const ev = (o: object) => `data: ${JSON.stringify(o)}\n\n`

describe('parseSse', () => {
  it('holds an event split across two chunks until it completes', () => {
    const full = ev({ type: 'text', delta: 'hello' })
    const a = parseSse(full.slice(0, 12), '')
    expect(a.events).toEqual([])
    const b = parseSse(full.slice(12), a.carry)
    expect(b.events).toEqual([{ type: 'text', delta: 'hello' }])
    expect(b.carry).toBe('')
  })

  it('ignores ping comments', () => {
    const r = parseSse(`: ping\n\n${ev({ type: 'text', delta: 'x' })}`, '')
    expect(r.events).toEqual([{ type: 'text', delta: 'x' }])
  })

  it('reads two events in one chunk and keeps a partial third', () => {
    const r = parseSse(ev({ type: 'text', delta: 'a' }) + ev({ type: 'done', messageId: null }) + 'data: {"ty', '')
    expect(r.events).toEqual([{ type: 'text', delta: 'a' }, { type: 'done', messageId: null }])
    expect(r.carry).toBe('data: {"ty')
  })

  it('skips a frame that is not JSON', () => {
    expect(parseSse('data: nope\n\n', '').events).toEqual([])
  })
})

describe('streamAssistant', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('turns a refusal into an error event then done', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'assistant_busy', message: 'Wait.' }), { status: 409 })))
    const got: any[] = []
    await streamAssistant('/api/assistant/x', { a: 1 }, 'tok', (e) => got.push(e), new AbortController().signal)
    expect(got).toEqual([{ type: 'error', code: 'assistant_busy', message: 'Wait.' }, { type: 'done', messageId: null }])
    const [, init] = (fetch as any).mock.calls[0]
    expect(init.headers.authorization).toBe('Bearer tok')
  })

  it('streams events from the body', async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(ev({ type: 'text', delta: 'h' }).slice(0, 10))); c.enqueue(enc.encode(ev({ type: 'text', delta: 'h' }).slice(10) + ev({ type: 'done', messageId: 'm' }))); c.close() } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
    const got: any[] = []
    await streamAssistant('/u', {}, 't', (e) => got.push(e), new AbortController().signal)
    expect(got).toEqual([{ type: 'text', delta: 'h' }, { type: 'done', messageId: 'm' }])
  })
})
