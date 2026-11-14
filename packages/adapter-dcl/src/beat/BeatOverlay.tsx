/**
 * The in-world BEAT card (LIV-11): opt in with consent, progress while tracking, claim, and what happened to the claim.
 * Drawn from this module's state; beat/connect.ts feeds it.
 *
 * One UI root: with a host HUD the card renders inside the HUD's tree (DclHUDRenderer.addOverlay); without one
 * (visitors) it is its own ReactEcsRenderer.addUiRenderer root. The BEAT's name is shown as plain text (plainText).
 */
import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine } from '@dcl/sdk/ecs'
import type { VisitorBeat } from '@virvixr/shared'
import { markHudPress } from '../hud/press.js'
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

const ui: { beat: VisitorBeat | null; state: BeatUi; onAction: ((a: BeatAction) => void) | null } = {
  beat: null,
  state: initialBeatUi(true),
  onAction: null,
}

export function setBeatCard(card: { beat: VisitorBeat | null; ui: BeatUi }): void {
  ui.beat = card.beat
  ui.state = card.ui
}

export function setBeatCardHandler(handler: (a: BeatAction) => void): void {
  ui.onAction = handler
}

let mounted = false

/** Mount once: inside the host HUD's tree when there is one, else as its own UI root. */
export function mountBeatOverlay(hud: { addOverlay(component: () => ReactEcs.JSX.Element | null): void } | null): void {
  if (mounted) return
  mounted = true
  if (hud) hud.addOverlay(BeatOverlay)
  // Same 1920x1080 design size as the HUD; under the HUD (zIndex 1000), over the scene's own UI
  else ReactEcsRenderer.addUiRenderer(engine.addEntity(), BeatOverlay, { virtualWidth: 1920, virtualHeight: 1080, zIndex: 900 })
}

// ---------------------------------------------------------------------------

const CARD_W = 320
const BODY_H = 200
const press = (a: BeatAction) => () => { markHudPress(); ui.onAction?.(a) }
const PRIMARY: BeatAction[] = ['track', 'confirm', 'claim']

function CardButton({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean; key?: string }) {
  return (
    <UiEntity
      uiTransform={{ height: 30, padding: { left: 12, right: 12 }, margin: { right: 6, top: 6 }, alignItems: 'center', justifyContent: 'center' }}
      uiBackground={{ color: primary ? C.accent : C.btn }}
      onMouseDown={onPress}
    >
      <Label value={label} fontSize={12} color={C.text} textWrap="nowrap" />
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
      uiTransform={{ positionType: 'absolute', position: { right: 12, top: 140 }, width: CARD_W, flexDirection: 'column', padding: 12 }}
      uiBackground={{ color: C.bg }}
      onMouseDown={markHudPress}
    >
      <UiEntity uiTransform={{ width: '100%', height: 14, flexDirection: 'row' }}>
        <Label value="BEAT" fontSize={10} color={C.virvi} textAlign="top-left" uiTransform={{ height: 14 }} />
        {v.test && <Label value="Test" fontSize={10} color={C.test} textAlign="top-left" uiTransform={{ height: 14, margin: { left: 8 } }} />}
      </UiEntity>
      <Label value={plainText(v.title)} fontSize={15} color={C.text} textAlign="top-left" textWrap="wrap" uiTransform={{ width: '100%', height: textHeight(v.title, 15, bodyWidth) }} />
      {v.body !== null && (
        <UiEntity
          uiTransform={{ width: '100%', height: BODY_H, overflow: 'scroll', margin: { top: 6 }, padding: 6, flexDirection: 'column' }}
          uiBackground={{ color: C.row }}
        >
          <Label value={plainText(v.body)} fontSize={11} color={C.text} textAlign="top-left" textWrap="wrap"
            uiTransform={{ width: bodyWidth - 12, height: textHeight(v.body, 11, bodyWidth - 12) }} />
        </UiEntity>
      )}
      {v.line && (
        <Label value={plainText(v.line)} fontSize={12} color={good ? C.success : C.text} textAlign="top-left" textWrap="wrap"
          uiTransform={{ width: '100%', height: textHeight(v.line, 12, bodyWidth), margin: { top: 4 } }} />
      )}
      {v.progress && (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 6 } }}>
          <UiEntity uiTransform={{ width: '100%', height: 8 }} uiBackground={{ color: C.row }}>
            <UiEntity uiTransform={{ width: `${Math.round(v.progress.fraction * 100)}%`, height: '100%' }} uiBackground={{ color: C.accent }} />
          </UiEntity>
          <Label value={v.progress.label} fontSize={11} color={C.textDim} textAlign="top-left" uiTransform={{ width: '100%', height: 18, margin: { top: 2 } }} />
        </UiEntity>
      )}
      {v.note && (
        <Label value={v.note} fontSize={11} color={C.danger} textAlign="top-left" textWrap="wrap"
          uiTransform={{ width: '100%', height: textHeight(v.note, 11, bodyWidth) }} />
      )}
      {v.actions.length > 0 && (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap' }}>
          {v.actions.map((a) => <CardButton key={a.id} label={a.label} primary={PRIMARY.includes(a.id)} onPress={press(a.id)} />)}
        </UiEntity>
      )}
    </UiEntity>
  )
}
