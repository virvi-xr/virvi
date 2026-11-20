import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const KEYS = ['ASSISTANT_ENABLED', 'ASSISTANT_AUDIENCE', 'ASSISTANT_MODEL', 'ASSISTANT_DISABLED_TOOLS', 'ASSISTANT_TOOL_CALLS_PER_MESSAGE', 'ASSISTANT_MESSAGES_PER_MINUTE', 'ASSISTANT_ADMIN_BUDGET_USD']
const saved: Record<string, string | undefined> = {}

async function freshConfig(env: Record<string, string> = {}) {
  vi.resetModules()
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
  return (await import('../src/config.js')).config
}

describe('assistant config', () => {
  beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k] })
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    vi.resetModules()
  })

  it('has the defaults when nothing is set', async () => {
    const c = await freshConfig()
    expect(c.assistantEnabled).toBe(true)
    expect(c.assistantAudience).toBe('admins')
    expect(c.assistantModel).toBe('claude-sonnet-5-5')
    expect(c.assistantDisabledTools).toEqual([])
    expect(c.assistantToolCallsPerMessage).toBe(12)
    expect(c.assistantMessagesPerMinute).toBe(10)
    expect(c.assistantAdminBudgetUsd).toBe(20)
  })

  it('reads ASSISTANT_ENABLED strictly as true or false', async () => {
    expect((await freshConfig({ ASSISTANT_ENABLED: 'false' })).assistantEnabled).toBe(false)
    expect((await freshConfig({ ASSISTANT_ENABLED: 'true' })).assistantEnabled).toBe(true)
    await expect(freshConfig({ ASSISTANT_ENABLED: 'yes' })).rejects.toThrow(/ASSISTANT_ENABLED/)
  })

  it('accepts paid and refuses any other audience', async () => {
    expect((await freshConfig({ ASSISTANT_AUDIENCE: 'paid' })).assistantAudience).toBe('paid')
    await expect(freshConfig({ ASSISTANT_AUDIENCE: 'everyone' })).rejects.toThrow(/ASSISTANT_AUDIENCE/)
  })

  it('splits and trims ASSISTANT_DISABLED_TOOLS', async () => {
    const c = await freshConfig({ ASSISTANT_DISABLED_TOOLS: ' update_scene , get_plan' })
    expect(c.assistantDisabledTools).toEqual(['update_scene', 'get_plan'])
  })
})
