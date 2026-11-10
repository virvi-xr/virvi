import { categoryLabel } from './studio'

/**
 * Helping people write a design's first prompt: what they are making (slots for a wearable, the kind of move for an
 * emote), a short guide with ticks that light up as the draft covers each part, and the state of "Improve my prompt"
 * (POST /api/studio/designs/:id/prompt-help). Wearable and emote designs only. The example prompts are studio-ideas.ts.
 */

export type HelpKind = 'wearable' | 'emote'
export const helpsWith = (kind: string): kind is HelpKind => kind === 'wearable' || kind === 'emote'

// ── What are you making? (wearables) ────────────────────────────────────────

/** The slots offered before the first message, grouped as people think of them; ids are the server's categories. */
export const SLOT_GROUPS: { label: string; slots: string[] }[] = [
  { label: 'Head', slots: ['hat', 'helmet', 'hair', 'mask', 'eyewear', 'earring', 'tiara', 'top_head', 'facial_hair'] },
  { label: 'Body', slots: ['upper_body', 'lower_body', 'feet', 'hands_wear'] },
  { label: 'Skin', slots: ['skin'] },
]
/** A chip's words: `top_head` → top head. */
export const slotChipLabel = categoryLabel

/** Ticked slots, or one of the two choices that leave the slots to the agent. */
export type SlotChoice = { mode: 'slots'; slots: string[] } | { mode: 'outfit' } | { mode: 'unsure' }
export const NO_CHOICE: SlotChoice = { mode: 'slots', slots: [] }

/** Ticks or unticks a slot; ticking one leaves "A full outfit" or "Not sure". Kept in SLOT_GROUPS order. */
export function toggleSlot(choice: SlotChoice, slot: string): SlotChoice {
  const now = choice.mode === 'slots' ? choice.slots : []
  const next = now.includes(slot) ? now.filter((s) => s !== slot) : [...now, slot]
  const order = SLOT_GROUPS.flatMap((g) => g.slots)
  return { mode: 'slots', slots: next.sort((a, b) => order.indexOf(a) - order.indexOf(b)) }
}

/** "A full outfit" or "Not sure": a second tap clears it. */
export const pickOpen = (choice: SlotChoice, mode: 'outfit' | 'unsure'): SlotChoice => choice.mode === mode ? NO_CHOICE : { mode }

/** The slots that go with the first message: only ticked ones; the server refuses an empty list, so none is none. */
export const choiceSlots = (choice: SlotChoice): string[] | undefined =>
  choice.mode === 'slots' && choice.slots.length ? choice.slots : undefined

/** What the first message sends: the person's words and the ticked slots. A full outfit is said in words. */
export function firstWearableMessage(text: string, choice: SlotChoice): { text: string; selectedSlots?: string[] } {
  const slots = choiceSlots(choice)
  const words = choice.mode === 'outfit' ? `${text}\n\nI'd like a full outfit: suggest the pieces.` : text
  return slots ? { text: words, selectedSlots: slots } : { text: words }
}

// ── What kind of move? (emotes) ─────────────────────────────────────────────

export const MOVE_KINDS = ['dance', 'gesture', 'reaction', 'prop'] as const
export type MoveKind = typeof MOVE_KINDS[number]
export const MOVE_LABELS: Record<MoveKind, string> = { dance: 'A dance', gesture: 'A gesture', reaction: 'A reaction', prop: 'With a prop' }
export const PLAYBACKS = ['loop', 'once'] as const
export type Playback = typeof PLAYBACKS[number]
export const PLAYBACK_LABELS: Record<Playback, string> = { loop: 'Loops', once: 'Plays once' }
export type EmoteChoice = { move: MoveKind | null; playback: Playback | null }

const MOVE_WORDS: Record<MoveKind, string> = { dance: 'It’s a dance.', gesture: 'It’s a gesture.', reaction: 'It’s a reaction.', prop: 'It uses a prop.' }
const PLAYBACK_WORDS: Record<Playback, string> = { loop: 'It loops.', once: 'It plays once.' }

/** The emote's first message: the chips go into the words (an emote has no slots). */
export function firstEmoteMessage(text: string, choice: EmoteChoice): { text: string } {
  const extra = [choice.move && MOVE_WORDS[choice.move], choice.playback && PLAYBACK_WORDS[choice.playback]].filter(Boolean)
  return { text: extra.length ? `${text}\n\n${extra.join(' ')}` : text }
}

// ── The message the box sends ───────────────────────────────────────────────

export const MAX_PROMPT = 4000

/**
 * Before the first message, what the chips say. `inWords`: the box already holds the chips' sentence (the person used
 * a suggestion made from it), so it isn't added again; ticked slots still go with the message.
 */
export type FirstChoice = { kind: HelpKind; slots: SlotChoice; emote: EmoteChoice; inWords: boolean }

/** What Send sends, and what "Improve my prompt" rewrites: the words with the chips' sentence, and the ticked slots. */
export function outgoingMessage(text: string, first: FirstChoice | null): { text: string; selectedSlots?: string[] } {
  if (!first) return { text }
  if (first.kind === 'emote') return first.inWords ? { text } : firstEmoteMessage(text, first.emote)
  if (!first.inWords) return firstWearableMessage(text, first.slots)
  const slots = choiceSlots(first.slots)
  return slots ? { text, selectedSlots: slots } : { text }
}

/** Why the box can't send this, when the chips' sentence takes it past the limit; null when it fits. */
export function tooLong(body: { text: string }, max = MAX_PROMPT): string | null {
  const over = body.text.length - max
  return over > 0 ? `Your message is ${over.toLocaleString('en-US')} character${over === 1 ? '' : 's'} too long with your choices above. Shorten it a little.` : null
}

// ── What makes a good prompt ────────────────────────────────────────────────

export type GuideItem = { id: string; label: string; example: string }
export const GUIDE: Record<HelpKind, GuideItem[]> = {
  wearable: [
    { id: 'what', label: 'What it is, and which slots', example: 'A bucket hat and matching sneakers.' },
    { id: 'style', label: 'Style', example: 'Cartoon, realistic, low-poly or pixel art.' },
    { id: 'colours', label: 'Colours and materials', example: 'Sky blue canvas with a woven straw band.' },
    { id: 'details', label: 'Details and motifs', example: 'A small embroidered palm tree on the front.' },
    { id: 'fit', label: 'Fit', example: 'Hides the hair, works on both body shapes.' },
    { id: 'reference', label: 'A reference image', example: 'Attach a sketch or photo with Attach files, above the box.' },
  ],
  emote: [
    { id: 'move', label: 'The move', example: 'A two-step dance that ends in a spin.' },
    { id: 'mood', label: 'Mood and speed', example: 'Cheerful and bouncy, fairly fast.' },
    { id: 'playback', label: 'Loops or plays once', example: 'Loops cleanly so it can play for a while.' },
    { id: 'props', label: 'Props and sounds', example: 'Holding a paper lantern, with a soft chime.' },
    { id: 'reference', label: 'A reference', example: 'Attach a sketch or a still of the move with Attach files, above the box.' },
  ],
}

const has = (draft: string, words: RegExp) => words.test(draft.toLowerCase())
const WEARABLE_WHAT = /\b(hats?|caps?|beanie|helmet|hair|wig|mask|glasses|goggles|eyewear|sunglasses|earrings?|tiara|crown|horns?|halo|beard|moustache|mustache|shirt|t-shirt|tee|jacket|hoodie|coat|top|sweater|vest|dress|armou?r|pants|trousers|jeans|shorts|skirt|shoes?|sneakers?|boots?|sandals|gloves?|bracelet|skin|outfit|set)\b/
const STYLE = /\b(cartoon\w*|realistic|painterly|cel[- ]?shaded|low[- ]?poly|pixel\w*|anime|stylized|stylised|cute|chibi|futuristic|retro|vintage|minimal\w*|cyberpunk|steampunk|fantasy|sci-?fi|gothic|kawaii|punk|elegant|sporty|casual|grunge|y2k|vaporwave)\b/
const COLOURS = /\b(red|orange|yellow|green|blue|purple|violet|pink|black|white|gr[ae]y|brown|beige|cream|gold(en)?|silver|teal|turquoise|navy|neon|pastel|rainbow|colou?rs?|leather|metal(lic)?|chrome|steel|wood(en)?|glass|silk|satin|velvet|wool|knit(ted)?|denim|cotton|canvas|fur|lace|plastic|rubber|straw|crystal|gems?|marble)\b/
const DETAILS = /\b(pattern\w*|stripe[sd]?|spots|dots|polka|checker\w*|plaid|print(ed)?|embroider\w*|trim|spikes?|studs?|feathers?|flowers?|floral|stars?|hearts?|skulls?|flames?|wings?|chains?|patch(es)?|buttons?|zips?|zipper|pockets?|glow\w*|motifs?|logo|badge|bow|ribbon|fringe|tassels?|emblem|symbol|details?|accents?|graphics?|decals?|(on|across|along|around) (the|its|each) (front|back|sides?|chest|sleeves?|brim|band|collar|hem|toes?|heels?|top))\b/
const FIT = /\b(hides?|hiding|fit\w*|loose|tight|baggy|oversized|cropped|long|short|both body|body shapes?|male|female|over the hair|covers?)\b/
const REFERENCE = /\b(reference|image|photo|picture|sketch|drawing|attached|uploaded|like this)\b/
const EMOTE_MOVE = /\b(danc\w*|wave|waving|jump\w*|spin\w*|twirl\w*|clap\w*|bow\w*|kick\w*|punch\w*|salute|nod\w*|shrug\w*|point\w*|walk\w*|run\w*|sit\w*|flip\w*|stomp\w*|shake|shimmy|moonwalk|dab|gesture|celebrat\w*|cheer\w*|laugh\w*|cry\w*|hug\w*|step\w*|sway\w*|hop\w*|pose|wiggl\w*|throw\w*|juggl\w*|bob\w*|fist pump)\b/
const MOOD = /\b(happy|cheerful|joyful|sad|angry|excited|calm|chill|silly|goofy|funny|energetic|lazy|slow(ly)?|fast|quick(ly)?|smooth|bouncy|dramatic|proud|shy|confident|sleepy|epic|playful|tired|relaxed|wild|gentle|sassy|cool)\b/
const PLAYBACK = /\b(loops?|looping|once|repeat\w*|one-?shot|over and over|ends? (with|in|on))\b/
const PROPS = /\b(props?|holding|holds|hold|guitar|sword|flag|umbrella|ball|balloon|phone|cup|lantern|book|wand|sign|microphone|mic|sound|music|chime|confetti|particles?|sparkles?)\b/

/** Which parts of the guide the draft already covers: a light keyword check on the draft, the slots and the uploads. */
export function guideTicks(kind: HelpKind, draft: string, ctx: { slots?: string[]; hasUploads?: boolean } = {}): Set<string> {
  const ticks = new Set<string>()
  const ref = !!ctx.hasUploads || has(draft, REFERENCE)
  if (kind === 'wearable') {
    if (ctx.slots?.length || has(draft, WEARABLE_WHAT)) ticks.add('what')
    if (has(draft, STYLE)) ticks.add('style')
    if (has(draft, COLOURS)) ticks.add('colours')
    if (has(draft, DETAILS)) ticks.add('details')
    if (has(draft, FIT)) ticks.add('fit')
  } else {
    if (has(draft, EMOTE_MOVE)) ticks.add('move')
    if (has(draft, MOOD)) ticks.add('mood')
    if (has(draft, PLAYBACK)) ticks.add('playback')
    if (has(draft, PROPS)) ticks.add('props')
  }
  if (ref) ticks.add('reference')
  return ticks
}

// ── The "What makes a good prompt" panel, open or folded, per viewer ──────

export const GUIDE_FOLDED_KEY = 'virvi-studio-prompt-guide-folded'
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

/** Whether the viewer folded the guide away; blocked or empty storage reads as open. */
export function readGuideFolded(store: KeyValueStore | null): boolean {
  try { return store?.getItem(GUIDE_FOLDED_KEY) === '1' } catch { return false }
}
export function writeGuideFolded(store: KeyValueStore | null, folded: boolean): void {
  try { store?.setItem(GUIDE_FOLDED_KEY, folded ? '1' : '0') } catch { /* private window or blocked storage */ }
}

// ── Improve my prompt ───────────────────────────────────────────────────────

export type HelpQuestion = { id: string; label: string; options: string[] }
export type PromptHelp = { prompt: string; questions: HelpQuestion[]; note?: string }

/**
 * The suggestion panel: nothing, asking, a suggestion (its prompt editable, the answers picked so far), or an error.
 * `unavailable`: the server has no prompt help (503), so the button goes for the rest of the visit.
 */
export type HelpState =
  | { status: 'idle' }
  | { status: 'loading'; answers: Record<string, string>; previous: PromptHelp | null }
  | { status: 'ready'; help: PromptHelp; prompt: string; answers: Record<string, string> }
  | { status: 'error'; message: string }
export type HelpAction =
  | { type: 'ask'; answers?: Record<string, string> }
  | { type: 'answered'; help: PromptHelp }
  | { type: 'failed'; message: string }
  | { type: 'edit'; prompt: string }
  | { type: 'dismiss' }

export const HELP_IDLE: HelpState = { status: 'idle' }

export function helpReducer(state: HelpState, action: HelpAction): HelpState {
  switch (action.type) {
    case 'ask':
      return { status: 'loading', answers: action.answers ?? {}, previous: state.status === 'ready' ? state.help : state.status === 'loading' ? state.previous : null }
    case 'answered':
      return state.status === 'loading' ? { status: 'ready', help: action.help, prompt: action.help.prompt, answers: state.answers } : state
    case 'failed':
      return state.status === 'loading' ? { status: 'error', message: action.message } : state
    case 'edit':
      return state.status === 'ready' ? { ...state, prompt: action.prompt } : state
    case 'dismiss':
      return HELP_IDLE
  }
}

/** Tapping a question's option: the answers to re-ask with (tapping the picked one again takes it back). */
export function withAnswer(answers: Record<string, string>, id: string, option: string): Record<string, string> {
  const next = { ...answers }
  if (next[id] === option) delete next[id]
  else next[id] = option
  return next
}

// The server's limits on a prompt help's answers (routes/studio.ts)
export const ANSWERS_MAX = 10
export const ANSWER_MAX = 80
const ANSWER_ID = /^[a-z0-9_-]{1,40}$/

/** The answers kept within the server's limits: valid ids, non-empty, each cut to fit, the latest ten. */
export function clampAnswers(answers: Record<string, string>): Record<string, string> {
  const kept = Object.entries(answers).filter(([id, a]) => ANSWER_ID.test(id) && a.trim()).map(([id, a]) => [id, a.trim().slice(0, ANSWER_MAX)] as const)
  return Object.fromEntries(kept.slice(-ANSWERS_MAX))
}

/**
 * Re-asking after a tap on a question's option: the suggestion as it is now in its box (edits kept), the slots, and
 * the answers so far with this one.
 */
export function reaskBody(state: Extract<HelpState, { status: 'ready' }>, id: string, option: string, slots?: string[]):
  { text: string; selectedSlots?: string[]; answers: Record<string, string> } {
  const answers = clampAnswers(withAnswer(state.answers, id, option))
  const text = (state.prompt.trim() || state.help.prompt).slice(0, MAX_PROMPT)
  return { text, ...(slots ? { selectedSlots: slots } : {}), answers }
}

/** Whether "Improve my prompt" can be pressed: there is a draft and the box could send it. */
export const canImprove = (text: string, canSendNow: boolean, state: HelpState) =>
  !!text.trim() && canSendNow && state.status !== 'loading'

/** A refused prompt help in the page's words; `unavailable` hides the button. */
export function helpFailure(err: { status?: number; body?: { error?: string; code?: string } }): { message: string; unavailable?: true } {
  const code = err.body?.error ?? err.body?.code
  if (err.status === 503 || code === 'prompt_help_unavailable') return { message: 'Prompt help isn’t available right now.', unavailable: true }
  if (code === 'prompt_help_limit') return { message: 'You’ve reached today’s limit for prompt help. It comes back tomorrow.' }
  if (code === 'studio_paused') return { message: 'Your studio access is paused.' }
  return { message: 'That didn’t work. Try again in a moment.' }
}
