/**
 * The in-world BEAT card (LIV-11): opt in with consent, progress while tracking, claim, and what happened to the claim.
 * Drawn from this module's state; beat/connect.ts feeds it.
 *
 * The card sits in the shared right-hand column (card-column.tsx) above the raffle card, so the two stack instead of
 * overlapping. The BEAT's name is shown as plain text (plainText).
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import type { CardBeat } from './card.js'
import { markHudPress } from '../hud/press.js'
import { addColumnCard, CARD_GAP, mountCardColumn } from '../card-column.js'
import { plainText } from '../raffle/card.js'
import { cardView, initialBeatUi, type BeatAction, type BeatUi } from './card.js'

const C = {
  bg: Color4.create(0.06, 0.06, 0.1, 0.94),
  row: Color4.create(0.1, 0.1, 0.16, 1),
  btn: Color4.create(0.14, 0.14, 0.2, 1),
  accent: Color4.create(0.35, 0.38, 0.92, 1),
  text: Color4.create(1, 1, 1, 1),
  textDim: Color4.create(0.65, 0.65, 0.7, 1),
  success: Color4.create(0.18, 0.75, 0.38, 1),
  danger: Color4.create(0.88, 0.28, 0.28, 1),
  test: Color4.create(0.95, 0.65, 0.15, 1),
  virvi: Color4.create(8 / 255, 221 / 255, 235 / 255, 1),
}

const ui: { beat: CardBeat | null; state: BeatUi; onAction: ((a: BeatAction) => void) | null } = {
  beat: null,
  state: initialBeatUi(true),
  onAction: null,
}

export function setBeatCard(card: { beat: CardBeat | null; ui: BeatUi }): void {
  ui.beat = card.beat
  ui.state = card.ui
}

export function setBeatCardHandler(handler: (a: BeatAction) => void): void {
  ui.onAction = handler
}

let mounted = false

/** Mount once, in the shared right-hand card column, above the raffle card. */
export function mountBeatOverlay(hud: { addOverlay(component: () => ReactEcs.JSX.Element | null): void } | null): void {
  if (mounted) return
  mounted = true
  addColumnCard(BeatOverlay, 0)
  mountCardColumn(hud)
}

// ---------------------------------------------------------------------------

const CARD_W = 320
/** Text sizes (plain-ux I12): the consent and lines at 13, notes and progress at 12, the tags at 11. */
const BODY_FONT = 13
const NOTE_FONT = 12
const TAG_FONT = 11
const press = (a: BeatAction) => () => { markHudPress(); ui.onAction?.(a) }
const PRIMARY: BeatAction[] = ['track', 'confirm', 'claim']

function CardButton({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean; key?: string }) {
  return (
    <UiEntity
      uiTransform={{ height: 30, padding: { left: 12, right: 12 }, margin: { right: 6, top: 6 }, alignItems: 'center', justifyContent: 'center' }}
      uiBackground={{ color: primary ? C.accent : C.btn }}
      onMouseDown={onPress}
    >
      <Label value={label} fontSize={BODY_FONT} color={C.text} textWrap="nowrap" />
    </UiEntity>
  )
}

/** Rough height of wrapped text in the card, so the scroll area knows how tall its content is. */
function textHeight(text: string, fontSize: number, width: number): number {
  const perLine = Math.max(1, Math.floor(width / (fontSize * 0.55)))
  const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0)
  return lines * fontSize * 1.45 + 8
}

export function BeatOverlay() {
  const v = cardView(ui.beat, Date.now(), ui.state)
  if (!v.visible) return null
  const bodyWidth = CARD_W - 28
  const good = v.state === 'minted' || v.state === 'claimable'
  return (
    <UiEntity
      uiTransform={{ width: CARD_W, flexDirection: 'column', padding: 12, margin: { top: CARD_GAP } }}
      uiBackground={{ color: C.bg }}
      onMouseDown={markHudPress}
    >
      <UiEntity uiTransform={{ width: '100%', height: 14, flexDirection: 'row' }}>
        <Label value="BEAT" fontSize={TAG_FONT} color={C.virvi} textAlign="top-left" uiTransform={{ height: 14 }} />
        {v.test && <Label value="Test" fontSize={TAG_FONT} color={C.test} textAlign="top-left" uiTransform={{ height: 14, margin: { left: 8 } }} />}
      </UiEntity>
      <Label value={plainText(v.title)} fontSize={15} color={C.text} textAlign="top-left" textWrap="wrap" uiTransform={{ width: '100%', height: textHeight(v.title, 15, bodyWidth) }} />
      {v.body !== null && (
        // The whole consent is shown at once, never in a scroll box: the agree button sits under all of it
        <UiEntity
          uiTransform={{ width: '100%', margin: { top: 6 }, padding: 6, flexDirection: 'column' }}
          uiBackground={{ color: C.row }}
        >
          <Label value={plainText(v.body)} fontSize={BODY_FONT} color={C.text} textAlign="top-left" textWrap="wrap"
            uiTransform={{ width: bodyWidth - 12, height: textHeight(v.body, BODY_FONT, bodyWidth - 12) }} />
        </UiEntity>
      )}
      {v.line && (
        <Label value={plainText(v.line)} fontSize={BODY_FONT} color={good ? C.success : C.text} textAlign="top-left" textWrap="wrap"
          uiTransform={{ width: '100%', height: textHeight(v.line, BODY_FONT, bodyWidth), margin: { top: 4 } }} />
      )}
      {v.progress && (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 6 } }}>
          <UiEntity uiTransform={{ width: '100%', height: 8 }} uiBackground={{ color: C.row }}>
            <UiEntity uiTransform={{ width: `${Math.round(v.progress.fraction * 100)}%`, height: '100%' }} uiBackground={{ color: C.accent }} />
          </UiEntity>
          <Label value={v.progress.label} fontSize={NOTE_FONT} color={C.textDim} textAlign="top-left" uiTransform={{ width: '100%', height: 18, margin: { top: 2 } }} />
        </UiEntity>
      )}
      {v.note && (
        <Label value={v.note} fontSize={NOTE_FONT} color={C.danger} textAlign="top-left" textWrap="wrap"
          uiTransform={{ width: '100%', height: textHeight(v.note, NOTE_FONT, bodyWidth) }} />
      )}
      {v.actions.length > 0 && (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap' }}>
          {v.actions.map((a) => <CardButton key={a.id} label={a.label} primary={PRIMARY.includes(a.id)} onPress={press(a.id)} />)}
        </UiEntity>
      )}
    </UiEntity>
  )
}
