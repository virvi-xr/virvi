import { describe, it, expect, afterEach } from 'vitest'
import { config } from '../src/config.js'
import { assistantModel, setAssistantFetch, INVALID_TOOL_JSON, MAX_TOKENS, THINKING_BETA, type ModelParams } from '../src/assistant/model.js'

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } } }
const thinking = [
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Read it first.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig==' } },
  { type: 'content_block_stop', index: 0 },
]
const toolUse = (json: string) => [
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_scene', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json } },
  { type: 'content_block_stop', index: 1 },
]
const end = [
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } },
  { type: 'message_stop' },
]

function answer(body: string | ReadableStream<Uint8Array>, status = 200) {
  const sent: any[] = []
  const headers: Headers[] = []
  setAssistantFetch((async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    headers.push(new Headers(init?.headers))
    return new Response(body, { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } })
  }) as typeof fetch)
  return Object.assign(sent, { headers })
}

/** A stream that delivers `text`, then fails the way a dropped connection does. */
function dies(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text))
      c.error(new TypeError('terminated'))
    },
  })
}
const writeUse = [
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_w', name: 'update_scene', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"sceneId":"abc","name":"X"}' } },
  { type: 'content_block_stop', index: 1 },
]

const params = (): ModelParams => ({
  model: 'claude-sonnet-5-5',
  system: [{ type: 'text', text: 'rules' }],
  tools: [{ name: 'get_scene', description: 'd', input_schema: { type: 'object' }, eager_input_streaming: true }],
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: MAX_TOKENS,
  signal: new AbortController().signal,
})

describe('the real model turn', () => {
  const prevKey = config.anthropicApiKey
  afterEach(() => {
    setAssistantFetch(null)
    ;(config as any).anthropicApiKey = prevKey
  })

  it('asks for medium effort and 4096 tokens, drops stale thinking instead of failing, and keeps thinking blocks verbatim', async () => {
    ;(config as any).anthropicApiKey = 'sk-test'
    const sent = answer(sse([start, ...thinking, ...toolUse('{"sceneId":"abc"}'), ...end]))
    const r = await assistantModel()(params(), () => {})
    expect(sent[0]).toMatchObject({ max_tokens: 4096, output_config: { effort: 'medium' }, stream: true })
    expect(sent[0].thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
    expect(sent.headers[0].get('anthropic-beta')).toContain(THINKING_BETA)
    expect(sent[0]).not.toHaveProperty('betas')
    expect(r.content).toEqual([
      { type: 'thinking', thinking: 'Read it first.', signature: 'sig==' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_scene', input: { sceneId: 'abc' } },
    ])
    expect(r).toMatchObject({ stopReason: 'tool_use', usage: { input_tokens: 120, output_tokens: 40 } })
  })

  it('turns a tool input that is broken JSON into a marked call instead of failing', async () => {
    ;(config as any).anthropicApiKey = 'sk-test'
    answer(sse([start, ...thinking, ...toolUse('{"sceneId": }'), ...end]))
    const r = await assistantModel()(params(), () => {})
    expect(r.content).toEqual([
      { type: 'thinking', thinking: 'Read it first.', signature: 'sig==' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_scene', input: {}, invalidJson: '{"sceneId": }' },
    ])
    // Not a tool_use stop: nothing the cut-short stream carried may run, only the INVALID_JSON answer
    expect(r.stopReason).toBe(INVALID_TOOL_JSON)
  })

  it('throws when the stream dies for another reason, even after a complete write call and a broken one', async () => {
    ;(config as any).anthropicApiKey = 'sk-test'
    const brokenOpen = [
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_b', name: 'get_scene', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"sceneId": }' } },
    ]
    answer(dies(sse([start, ...thinking, ...writeUse, ...brokenOpen])))
    await expect(assistantModel()(params(), () => {})).rejects.toBeInstanceOf(Error)
  })

  it('still throws API errors', async () => {
    ;(config as any).anthropicApiKey = 'sk-test'
    answer(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), 400)
    await expect(assistantModel()(params(), () => {})).rejects.toMatchObject({ status: 400 })
  })
})
