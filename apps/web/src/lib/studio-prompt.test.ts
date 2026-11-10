import { describe, it, expect } from 'vitest'
import {
  EXAMPLES, GUIDE, GUIDE_FOLDED_KEY, HELP_IDLE, NO_CHOICE, SLOT_GROUPS, canImprove, choiceSlots, firstEmoteMessage, firstWearableMessage, guideTicks,
  helpFailure, helpReducer, helpsWith, pickOpen, readGuideFolded, toggleSlot, withAnswer, writeGuideFolded, type HelpState, type PromptHelp,
  ANSWER_MAX, ANSWERS_MAX, clampAnswers, outgoingMessage, reaskBody, tooLong, type FirstChoice,
} from './studio-prompt'
import { WEARABLE_CATEGORIES } from './studio-reply'

describe('what are you making', () => {
  it('offers only the server’s categories, each once', () => {
    const offered = SLOT_GROUPS.flatMap((g) => g.slots)
    expect(new Set(offered).size).toBe(offered.length)
    for (const s of offered) expect(WEARABLE_CATEGORIES).toContain(s)
    expect(SLOT_GROUPS.map((g) => g.label)).toEqual(['Head', 'Body', 'Skin'])
    expect(helpsWith('wearable') && helpsWith('emote') && !helpsWith('scene')).toBe(true)
  })

  it('sends the ticked slots with the first message, in the chips’ order', () => {
    let c = toggleSlot(NO_CHOICE, 'feet')
    c = toggleSlot(c, 'hat')
    expect(firstWearableMessage('beach, palm trees', c)).toEqual({ text: 'beach, palm trees', selectedSlots: ['hat', 'feet'] })
    c = toggleSlot(c, 'hat')
    expect(choiceSlots(c)).toEqual(['feet'])
    // none ticked sends none (the server refuses an empty list)
    expect(firstWearableMessage('a hat', toggleSlot(c, 'feet'))).toEqual({ text: 'a hat' })
  })

  it('leaves the slots to the agent for a full outfit or not sure', () => {
    const outfit = pickOpen(toggleSlot(NO_CHOICE, 'hat'), 'outfit')
    expect(firstWearableMessage('desert explorer', outfit)).toEqual({ text: 'desert explorer\n\nI\'d like a full outfit: suggest the pieces.' })
    const unsure = pickOpen(outfit, 'unsure')
    expect(firstWearableMessage('desert explorer', unsure)).toEqual({ text: 'desert explorer' })
    expect(pickOpen(unsure, 'unsure')).toEqual(NO_CHOICE)
    // ticking a slot leaves either
    expect(toggleSlot(unsure, 'mask')).toEqual({ mode: 'slots', slots: ['mask'] })
  })

  it('puts an emote’s chips into its words', () => {
    expect(firstEmoteMessage('a happy wiggle', { move: 'dance', playback: 'loop' })).toEqual({ text: 'a happy wiggle\n\nIt’s a dance. It loops.' })
    expect(firstEmoteMessage('a bow', { move: null, playback: 'once' })).toEqual({ text: 'a bow\n\nIt plays once.' })
    expect(firstEmoteMessage('a bow', { move: null, playback: null })).toEqual({ text: 'a bow' })
  })
})

describe('what makes a good prompt', () => {
  it('ticks what a vague draft covers, and more as it gets concrete', () => {
    expect([...guideTicks('wearable', 'bored ape, btc, beach')]).toEqual([])
    expect([...guideTicks('wearable', 'bored ape, btc, beach', { slots: ['hat'] })]).toEqual(['what'])
    const full = guideTicks('wearable', 'A low-poly sky-blue bucket hat in canvas with an embroidered palm tree. It hides the hair. See the sketch.')
    expect([...full].sort()).toEqual(['colours', 'details', 'fit', 'reference', 'style', 'what'])
    expect(guideTicks('wearable', 'a cap', { hasUploads: true }).has('reference')).toBe(true)
    // whole words only
    expect(guideTicks('wearable', 'redo the thing').has('colours')).toBe(false)
  })

  it('has its own items for an emote', () => {
    expect([...guideTicks('emote', 'A cheerful dance that loops, holding a lantern')].sort()).toEqual(['mood', 'move', 'playback', 'props'])
    expect(GUIDE.emote.map((i) => i.id)).toContain('playback')
    expect(GUIDE.wearable.map((i) => i.id)).toEqual(['what', 'style', 'colours', 'details', 'fit', 'reference'])
  })

  it('every example ticks most of its guide', () => {
    for (const kind of ['wearable', 'emote'] as const) {
      for (const e of EXAMPLES[kind]) expect(guideTicks(kind, e).size, e).toBeGreaterThanOrEqual(3)
      expect(EXAMPLES[kind].length).toBeGreaterThanOrEqual(2)
    }
  })

  it('remembers whether the viewer folded it, and survives blocked storage', () => {
    const m = new Map<string, string>()
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    expect(readGuideFolded(store)).toBe(false)
    writeGuideFolded(store, true)
    expect(m.get(GUIDE_FOLDED_KEY)).toBe('1')
    expect(readGuideFolded(store)).toBe(true)
    const blocked = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(readGuideFolded(blocked)).toBe(false)
    expect(() => writeGuideFolded(blocked, true)).not.toThrow()
    expect(readGuideFolded(null)).toBe(false)
  })
})

describe('the Improve my prompt panel', () => {
  const help: PromptHelp = { prompt: 'A sky-blue bucket hat.', questions: [{ id: 'hair', label: 'Hide the hair?', options: ['Hide it', 'Show it'] }] }

  it('asks, shows the suggestion to edit, and re-asks with the answers', () => {
    let s: HelpState = helpReducer(HELP_IDLE, { type: 'ask' })
    expect(s).toEqual({ status: 'loading', answers: {}, previous: null })
    s = helpReducer(s, { type: 'answered', help })
    expect(s).toEqual({ status: 'ready', help, prompt: 'A sky-blue bucket hat.', answers: {} })
    s = helpReducer(s, { type: 'edit', prompt: 'A sky-blue bucket hat, small.' })
    expect(s.status === 'ready' && s.prompt).toBe('A sky-blue bucket hat, small.')
    const answers = withAnswer({}, 'hair', 'Hide it')
    s = helpReducer(s, { type: 'ask', answers })
    expect(s).toEqual({ status: 'loading', answers: { hair: 'Hide it' }, previous: help })
    s = helpReducer(s, { type: 'answered', help: { ...help, prompt: 'A sky-blue bucket hat that hides the hair.' } })
    expect(s.status === 'ready' && s.answers).toEqual({ hair: 'Hide it' })
    expect(helpReducer(s, { type: 'dismiss' })).toEqual(HELP_IDLE)
  })

  it('ignores a late answer after Dismiss, and shows a failure', () => {
    expect(helpReducer(HELP_IDLE, { type: 'answered', help })).toEqual(HELP_IDLE)
    expect(helpReducer(helpReducer(HELP_IDLE, { type: 'ask' }), { type: 'failed', message: 'x' })).toEqual({ status: 'error', message: 'x' })
    expect(helpReducer(HELP_IDLE, { type: 'edit', prompt: 'x' })).toEqual(HELP_IDLE)
  })

  it('toggles an answer', () => {
    expect(withAnswer({ hair: 'Hide it' }, 'hair', 'Hide it')).toEqual({})
    expect(withAnswer({ hair: 'Hide it' }, 'hair', 'Show it')).toEqual({ hair: 'Show it' })
  })

  it('is pressable with a draft the box could send, and not while asking', () => {
    expect(canImprove('a hat', true, HELP_IDLE)).toBe(true)
    expect(canImprove('   ', true, HELP_IDLE)).toBe(false)
    expect(canImprove('a hat', false, HELP_IDLE)).toBe(false)
    expect(canImprove('a hat', true, { status: 'loading', answers: {}, previous: null })).toBe(false)
  })

  it('says why it was refused, and hides itself when the server has no prompt help', () => {
    expect(helpFailure({ status: 503, body: { error: 'prompt_help_unavailable' } })).toMatchObject({ unavailable: true })
    expect(helpFailure({ status: 429, body: { error: 'prompt_help_limit' } }).message).toBe('You’ve reached today’s limit for prompt help. It comes back tomorrow.')
    expect(helpFailure({ status: 502, body: { error: 'prompt_help_failed' } })).toEqual({ message: 'That didn’t work. Try again in a moment.' })
    expect(helpFailure({ status: 403, body: { code: 'studio_paused' } }).message).toBe('Your studio access is paused.')
  })
})

describe('the message the box sends', () => {
  const outfit: FirstChoice = { kind: 'wearable', slots: { mode: 'outfit' }, emote: { move: null, playback: null }, inWords: false }
  const hat: FirstChoice = { ...outfit, slots: { mode: 'slots', slots: ['hat'] } }
  const dance: FirstChoice = { ...outfit, kind: 'emote', emote: { move: 'dance', playback: 'loop' } }

  it('is what Improve my prompt rewrites too: the chips’ sentence and the slots', () => {
    expect(outgoingMessage('desert explorer', outfit)).toEqual({ text: 'desert explorer\n\nI\'d like a full outfit: suggest the pieces.' })
    expect(outgoingMessage('a sun hat', hat)).toEqual({ text: 'a sun hat', selectedSlots: ['hat'] })
    expect(outgoingMessage('a wiggle', dance)).toEqual({ text: 'a wiggle\n\nIt’s a dance. It loops.' })
    // after the first message the chips are gone
    expect(outgoingMessage('make it pink', null)).toEqual({ text: 'make it pink' })
  })

  it('doesn’t add the chips’ sentence twice once a suggestion made from it is used', () => {
    const asked = outgoingMessage('a wiggle', dance).text
    const used = 'A cheerful wiggle dance. It loops.' // the rewrite of `asked`, put in the box by Use this
    expect(asked).toContain('It loops.')
    expect(outgoingMessage(used, { ...dance, inWords: true })).toEqual({ text: used })
    expect(outgoingMessage('A full desert outfit.', { ...outfit, inWords: true })).toEqual({ text: 'A full desert outfit.' })
    // the slots still go with it
    expect(outgoingMessage('A straw sun hat.', { ...hat, inWords: true })).toEqual({ text: 'A straw sun hat.', selectedSlots: ['hat'] })
  })

  it('says so when the chips’ sentence takes it past the limit', () => {
    const body = outgoingMessage('x'.repeat(3990), outfit)
    expect(tooLong(body)).toBe(`Your message is ${body.text.length - 4000} characters too long with your choices above. Shorten it a little.`)
    expect(tooLong({ text: 'x'.repeat(4001) })).toBe('Your message is 1 character too long with your choices above. Shorten it a little.')
    expect(tooLong({ text: 'x'.repeat(4000) })).toBeNull()
  })
})

describe('re-asking from a question', () => {
  const help: PromptHelp = { prompt: 'A sky-blue bucket hat.', questions: [{ id: 'hair', label: 'Hide the hair?', options: ['Hide it', 'Show it'] }] }
  const ready = (over: Partial<Extract<HelpState, { status: 'ready' }>> = {}) => ({ status: 'ready' as const, help, prompt: help.prompt, answers: {}, ...over })

  it('rewrites the suggestion as edited, not the original draft', () => {
    expect(reaskBody(ready({ prompt: 'A sky-blue bucket hat with a red band.' }), 'hair', 'Hide it', ['hat']))
      .toEqual({ text: 'A sky-blue bucket hat with a red band.', selectedSlots: ['hat'], answers: { hair: 'Hide it' } })
    // an emptied box falls back to the suggestion
    expect(reaskBody(ready({ prompt: '  ' }), 'hair', 'Show it').text).toBe('A sky-blue bucket hat.')
  })

  it('keeps the answers within the server’s limits', () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`q${i}`, 'x'.repeat(100)]))
    const body = reaskBody(ready({ answers: many }), 'hair', 'Hide it')
    expect(Object.keys(body.answers)).toHaveLength(ANSWERS_MAX)
    expect(body.answers.hair).toBe('Hide it')
    expect(Object.values(body.answers).every((a) => a.length <= ANSWER_MAX)).toBe(true)
    expect(clampAnswers({ 'Bad Id': 'x', ok: '  ', fine: ' yes ' })).toEqual({ fine: 'yes' })
  })
})
