import { describe, it, expect, afterEach } from 'vitest'
import { config } from '../src/config.js'
import { assistantModel, setAssistantFetch, MAX_TOKENS, type ModelParams } from '../src/assistant/model.js'

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

function answer(body: string, status = 200) {
  const sent: any[] = []
  setAssistantFetch((async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(body, { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } })
  }) as typeof fetch)
  return sent
}

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

  it('asks for medium effort and 4096 tokens, and keeps thinking blocks verbatim', async () => {
    ;(config as any).anthropicApiKey = 'sk-test'
    const sent = answer(sse([start, ...thinking, ...toolUse('{"sceneId":"abc"}'), ...end]))
    const r = await assistantModel()(params(), () => {})
    expect(sent[0]).toMatchObject({ max_tokens: 4096, output_config: { effort: 'medium' }, stream: true })
    expect(sent[0]).not.toHaveProperty('thinking')
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
  })

  it('still throws API errors', async () => {
    ;(config as any).anthropicApiKey = 'sk-test'
    answer(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), 400)
    await expect(assistantModel()(params(), () => {})).rejects.toMatchObject({ status: 400 })
  })
})
