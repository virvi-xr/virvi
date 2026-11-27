import { describe, it, expect } from 'vitest'
import { appealLine, logLine } from './moderation'

describe('moderation wording (LIV-34)', () => {
  it('says where an appeal stands', () => {
    expect(appealLine({ status: 'open', response: null })).toBe("You appealed. We'll email you when we've looked at it.")
    expect(appealLine({ status: 'rejected', response: 'It breaks the rules.' })).toBe('Your appeal was turned down: It breaks the rules.')
    expect(appealLine({ status: 'restored', response: null })).toBe('Your appeal was accepted.')
  })
  it('reads each log entry', () => {
    expect(logLine({ action: 'taken_down', targetType: 'asset', owner: 'Ada' })).toBe("Took down Ada's model")
    expect(logLine({ action: 'dismissed', targetType: 'asset_report', owner: null })).toBe('Dismissed a report on a model')
    expect(logLine({ action: 'resolved', targetType: 'ar_report', owner: null })).toBe('Resolved a Spaces report')
  })
})
