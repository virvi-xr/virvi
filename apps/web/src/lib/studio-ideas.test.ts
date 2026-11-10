import { describe, it, expect } from 'vitest'
import { IDEA_NONE, SEEN_MAX, ideaCountRow, ideaIdToSend, ideaParams, ideaReducer, withSeen, type IdeaPick } from './studio-ideas'
import { NO_CHOICE, pickOpen, toggleSlot } from './studio-prompt'

const params = (s: string) => Object.fromEntries(new URLSearchParams(s))

describe('which ideas to ask for', () => {
  it('follows the slot chips', () => {
    expect(params(ideaParams({ kind: 'wearable', slots: NO_CHOICE }, []))).toEqual({ count: '3' })
    expect(params(ideaParams({ kind: 'wearable', slots: toggleSlot(toggleSlot(NO_CHOICE, 'feet'), 'hat') }, []))).toEqual({ count: '3', mode: 'slots', slots: 'hat,feet' })
    expect(params(ideaParams({ kind: 'wearable', slots: pickOpen(NO_CHOICE, 'outfit') }, []))).toEqual({ count: '3', mode: 'outfit' })
    expect(params(ideaParams({ kind: 'wearable', slots: pickOpen(NO_CHOICE, 'unsure') }, []))).toEqual({ count: '3', mode: 'unsure' })
  })

  it('follows the move chips', () => {
    expect(params(ideaParams({ kind: 'emote', emote: { move: null, playback: null } }, []))).toEqual({ count: '3' })
    expect(params(ideaParams({ kind: 'emote', emote: { move: 'dance', playback: 'once' } }, []))).toEqual({ count: '3', move: 'dance', playback: 'once' })
    expect(params(ideaParams({ kind: 'emote', emote: { move: null, playback: 'loop' } }, []))).toEqual({ count: '3', playback: 'loop' })
  })

  it('skips the ones already seen', () => {
    expect(params(ideaParams({ kind: 'wearable', slots: NO_CHOICE }, ['a-hat', 'b-boot']))).toEqual({ count: '3', exclude: 'a-hat,b-boot' })
  })

  it('the same chips ask the same question, so a debounce can tell a change from a repeat', () => {
    const a = ideaParams({ kind: 'wearable', slots: toggleSlot(NO_CHOICE, 'hat') }, [])
    expect(ideaParams({ kind: 'wearable', slots: toggleSlot(NO_CHOICE, 'hat') }, [])).toBe(a)
    expect(ideaParams({ kind: 'wearable', slots: toggleSlot(NO_CHOICE, 'feet') }, [])).not.toBe(a)
  })
})

describe('the ideas seen this visit', () => {
  it('adds each new one once, in order', () => {
    expect(withSeen(['a'], [{ id: 'b', text: '' }, { id: 'a', text: '' }, { id: 'c', text: '' }])).toEqual(['a', 'b', 'c'])
    expect(withSeen([], [])).toEqual([])
  })

  it('keeps the latest ones past the cap', () => {
    const many = Array.from({ length: SEEN_MAX }, (_, i) => `i-${i}`)
    const next = withSeen(many, [{ id: 'new-one', text: '' }])
    expect(next).toHaveLength(SEEN_MAX)
    expect(next[next.length - 1]).toBe('new-one')
    expect(next[0]).toBe('i-1')
  })
})

describe('which idea goes with the first message', () => {
  const hat = { id: 'bucket-hat-palm', text: 'A low-poly bucket hat.' }
  const boot = { id: 'frog-face-rain-boots', text: 'Low-poly green rain boots.' }

  it('the tapped one, still after edits', () => {
    let s: IdeaPick = ideaReducer(IDEA_NONE, { type: 'tapped', idea: hat })
    expect(ideaIdToSend(s, true)).toBe(hat.id)
    s = ideaReducer(s, { type: 'typed', text: 'A low-poly bucket hat, in red.' })
    expect(ideaIdToSend(s, true)).toBe(hat.id)
  })

  it('cleared when the box is emptied, or replaced by another idea or by Use this', () => {
    const tapped = ideaReducer(IDEA_NONE, { type: 'tapped', idea: hat })
    expect(ideaIdToSend(ideaReducer(tapped, { type: 'typed', text: '   ' }), true)).toBeUndefined()
    expect(ideaIdToSend(ideaReducer(tapped, { type: 'tapped', idea: boot }), true)).toBe(boot.id)
    expect(ideaIdToSend(ideaReducer(tapped, { type: 'replaced' }), true)).toBeUndefined()
    // emptied, then typed again: not from the idea any more
    const emptied = ideaReducer(tapped, { type: 'typed', text: '' })
    expect(ideaIdToSend(ideaReducer(emptied, { type: 'typed', text: 'my own hat' }), true)).toBeUndefined()
  })

  it('only with the design’s first message, and never without a tap', () => {
    expect(ideaIdToSend(ideaReducer(IDEA_NONE, { type: 'tapped', idea: hat }), false)).toBeUndefined()
    expect(ideaIdToSend(ideaReducer(IDEA_NONE, { type: 'typed', text: hat.text }), true)).toBeUndefined()
  })
})

describe('the admin page’s example ideas', () => {
  it('names each row and flags fewer than the low mark left', () => {
    expect(ideaCountRow({ key: 'top_head', left: 2, total: 9 }, 3, 'wearable')).toEqual({ label: 'Top head', count: '2 of 9 left', low: true })
    expect(ideaCountRow({ key: 'outfit', left: 3, total: 50 }, 3, 'wearable')).toEqual({ label: 'Outfits (2–4 pieces)', count: '3 of 50 left', low: false })
    expect(ideaCountRow({ key: 'prop', left: 0, total: 15 }, 3, 'emote')).toEqual({ label: 'With a prop', count: '0 of 15 left', low: true })
  })
})
