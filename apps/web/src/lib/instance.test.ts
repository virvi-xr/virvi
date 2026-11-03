import { describe, expect, it } from 'vitest'
import { instanceLabel, instanceTooltip } from './instance'

describe('instanceLabel', () => {
  it('labels the self-hosted modes and leaves hosted virvi.io unlabelled', () => {
    expect(instanceLabel('single')).toBe('Self-hosted')
    expect(instanceLabel('scalable')).toBe('Self-hosted · Scalable')
    expect(instanceLabel('cloud')).toBeNull()
  })
  it('shows nothing until the server has answered, or for a mode it does not know', () => {
    expect(instanceLabel(null)).toBeNull()
    expect(instanceLabel('martian' as any)).toBeNull()
  })
})

describe('instanceTooltip', () => {
  it('names the mode and the server version', () => {
    expect(instanceTooltip({ mode: 'scalable', version: '2.0.0' })).toBe('Self-hosted install (scalable: several servers), Virvi server 2.0.0')
    expect(instanceTooltip({ mode: 'single', version: '2.0.0' })).toBe('Self-hosted install (single server), Virvi server 2.0.0')
  })
})
