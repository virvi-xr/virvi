import type { EmoteChoice, SlotChoice } from './studio-prompt'

/**
 * The example prompts under "What makes a good prompt" (GET /api/studio/designs/:id/prompt-ideas): a few at a time from
 * the server's pool, following the chips, skipping the ones the viewer already saw this visit. The idea a person taps
 * goes with their first message (`ideaId`), so the server retires it for everyone once it is sent, edited or not.
 */

export type PromptIdea = { id: string; text: string }
export type PromptIdeas = { ideas: PromptIdea[]; more: boolean }

/** How many the guide shows at a time. */
export const IDEAS_SHOWN = 3
/** The server skips at most this many seen ids, so the page keeps no more (the latest). */
export const SEEN_MAX = 200
/** How long the chips rest before the ideas follow them. */
export const IDEAS_DEBOUNCE_MS = 300

export type IdeaChips = { kind: 'wearable'; slots: SlotChoice } | { kind: 'emote'; emote: EmoteChoice }

/** The route's query for these chips: ticked slots, a full outfit or not sure; the move and playback; the ids seen. */
export function ideaParams(chips: IdeaChips, seen: string[], count = IDEAS_SHOWN): string {
  const p = new URLSearchParams({ count: String(count) })
  if (chips.kind === 'wearable') {
    const c = chips.slots
    if (c.mode !== 'slots') p.set('mode', c.mode)
    else if (c.slots.length) {
      p.set('mode', 'slots')
      p.set('slots', c.slots.join(','))
    }
  } else {
    if (chips.emote.move) p.set('move', chips.emote.move)
    if (chips.emote.playback) p.set('playback', chips.emote.playback)
  }
  if (seen.length) p.set('exclude', seen.join(','))
  return p.toString()
}

/** The ids seen so far with these, each once, the latest SEEN_MAX. */
export function withSeen(seen: string[], ideas: PromptIdea[]): string[] {
  const next = [...seen]
  for (const i of ideas) if (!next.includes(i.id)) next.push(i.id)
  return next.slice(-SEEN_MAX)
}

/** The idea the box's words came from, if they still do. */
export type IdeaPick = PromptIdea | null
export const IDEA_NONE: IdeaPick = null
export type IdeaAction =
  | { type: 'tapped'; idea: PromptIdea }
  // the person typed in the box (an edit keeps the idea; emptying the box lets it go)
  | { type: 'typed'; text: string }
  // the box's words came from somewhere else: "Use this" from Improve my prompt, or a sent message
  | { type: 'replaced' }

export function ideaReducer(pick: IdeaPick, action: IdeaAction): IdeaPick {
  switch (action.type) {
    case 'tapped':
      return action.idea
    case 'typed':
      return action.text.trim() ? pick : null
    case 'replaced':
      return null
  }
}

/** The `ideaId` the message sends: only the design's first message, only when the box came from an idea. */
export const ideaIdToSend = (pick: IdeaPick, firstMessage: boolean): string | undefined => (firstMessage && pick ? pick.id : undefined)

// ── The admin page's "Example ideas" ────────────────────────────────────────

export type IdeaCount = { key: string; left: number; total: number }
/** GET /api/admin/studio/ideas: per slot (outfits included) and for outfits, then per move; `low` flags a row. */
export type AdminIdeaCounts = { wearable: IdeaCount[]; emote: IdeaCount[]; low: number }

const MOVE_WORDS: Record<string, string> = { dance: 'Dances', gesture: 'Gestures', reaction: 'Reactions', prop: 'With a prop' }

/** A count's row: its words (`top_head` → Top head; outfits; a move), "left of total", and whether it is running low. */
export function ideaCountRow(c: IdeaCount, low: number, kind: 'wearable' | 'emote'): { label: string; count: string; low: boolean } {
  const words = kind === 'emote' ? (MOVE_WORDS[c.key] ?? c.key) : c.key === 'outfit' ? 'Outfits (2–4 pieces)' : c.key.replace(/_/g, ' ')
  return { label: words.charAt(0).toUpperCase() + words.slice(1), count: `${c.left} of ${c.total} left`, low: c.left < low }
}
