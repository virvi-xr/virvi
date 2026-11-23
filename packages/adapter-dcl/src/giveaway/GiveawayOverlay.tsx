/**
 * The in-world giveaway card (LIV-194): consent, the time left, Claim, and what happened to the claim. Drawn from this
 * module's state; giveaway/connect.ts feeds it.
 *
 * The card sits in the shared right-hand column (card-column.tsx) under the BEAT card and above the raffle card, so
 * they stack instead of overlapping. Names are shown as plain text (plainText).
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { markHudPress } from '../hud/press.js'
import { addColumnCard, CARD_GAP, mountCardColumn } from '../card-column.js'
import { plainText } from '../raffle/card.js'
import { giveawayCardView, initialGiveawayUi, type CardGiveaway, type GiveawayAction, type GiveawayUi } from './card.js'

const C = {
  bg: Color4.create(0.06, 0.06, 0.1, 0.94),
  row: Color4.create(0.1, 0.1, 0.16, 1),
  btn: Color4.create(0.14, 0.14, 0.2, 1),
  accent: Color4.create(0.35, 0.38, 0.92, 1),
  text: Color4.create(1, 1, 1, 1),
  success: Color4.create(0.18, 0.75, 0.38, 1),
  danger: Color4.create(0.88, 0.28, 0.28, 1),
  test: Color4.create(0.95, 0.65, 0.15, 1),
  virvi: Color4.create(8 / 255, 221 / 255, 235 / 255, 1),
}

const ui: { giveaway: CardGiveaway | null; state: GiveawayUi; onAction: ((a: GiveawayAction) => void) | null } = {
  giveaway: null,
  state: initialGiveawayUi(true, null),
  onAction: null,
}

export function setGiveawayCard(card: { giveaway: CardGiveaway | null; ui: GiveawayUi }): void {
  ui.giveaway = card.giveaway
  ui.state = card.ui
}

export function setGiveawayCardHandler(handler: (a: GiveawayAction) => void): void {
  ui.onAction = handler
}

let mounted = false

/** Mount once, in the shared right-hand card column: under the BEAT card (0), above the raffle card (1). */
export function mountGiveawayOverlay(hud: { addOverlay(component: () => ReactEcs.JSX.Element | null): void } | null): void {
  if (mounted) return
  mounted = true
  addColumnCard(GiveawayOverlay, 0.5)
  mountCardColumn(hud)
}

// ---------------------------------------------------------------------------

const CARD_W = 320
const BODY_FONT = 13
const NOTE_FONT = 12
const TAG_FONT = 11
const press = (a: GiveawayAction) => () => { markHudPress(); ui.onAction?.(a) }
const PRIMARY: GiveawayAction[] = ['agree', 'claim']

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

/** Rough height of wrapped text in the card. */
function textHeight(text: string, fontSize: number, width: number): number {
  const perLine = Math.max(1, Math.floor(width / (fontSize * 0.55)))
  const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0)
  return lines * fontSize * 1.45 + 8
}

export function GiveawayOverlay() {
  const v = giveawayCardView(ui.giveaway, ui.state)
  if (!v.visible) return null
  const bodyWidth = CARD_W - 28
  const good = v.state === 'sent'
  return (
    <UiEntity
      uiTransform={{ width: CARD_W, flexDirection: 'column', padding: 12, margin: { top: CARD_GAP } }}
      uiBackground={{ color: C.bg }}
      onMouseDown={markHudPress}
    >
      <UiEntity uiTransform={{ width: '100%', height: 14, flexDirection: 'row' }}>
        <Label value="GIVEAWAY" fontSize={TAG_FONT} color={C.virvi} textAlign="top-left" uiTransform={{ height: 14 }} />
        {v.test && <Label value="Test" fontSize={TAG_FONT} color={C.test} textAlign="top-left" uiTransform={{ height: 14, margin: { left: 8 } }} />}
      </UiEntity>
      <Label value={plainText(v.title)} fontSize={15} color={C.text} textAlign="top-left" textWrap="wrap" uiTransform={{ width: '100%', height: textHeight(v.title, 15, bodyWidth) }} />
      {v.line && (
        <Label value={plainText(v.line)} fontSize={BODY_FONT} color={good ? C.success : C.text} textAlign="top-left" textWrap="wrap"
          uiTransform={{ width: '100%', height: textHeight(v.line, BODY_FONT, bodyWidth), margin: { top: 4 } }} />
      )}
      {v.notice && (
        // Shown whole, never in a scroll box: the agree button sits under all of it
        <UiEntity uiTransform={{ width: '100%', margin: { top: 6 }, padding: 6, flexDirection: 'column' }} uiBackground={{ color: C.row }}>
          <Label value={v.notice} fontSize={BODY_FONT} color={C.text} textAlign="top-left" textWrap="wrap"
            uiTransform={{ width: bodyWidth - 12, height: textHeight(v.notice, BODY_FONT, bodyWidth - 12) }} />
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
