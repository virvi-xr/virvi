/**
 * The in-world raffle overlay (LIV-55): the visitor's raffle card (enter with consent, withdraw, rules, won and
 * closed states, the guest line) and the wheel everyone in the scene sees on a draw. Drawn from this module's
 * state; raffle/connect.ts feeds it.
 *
 * One UI root: with a host HUD the overlay renders inside the HUD's tree (DclHUDRenderer.setOverlay); without one
 * (visitors) it is its own ReactEcsRenderer.addUiRenderer root. Every name is shown as plain text (plainText).
 */
import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine } from '@dcl/sdk/ecs'
import type { PublicDraw } from '@virvixr/shared'
import { markHudPress } from '../hud/press.js'
import { cardView, initialCard, plainText, type CardAction, type RaffleCard } from './card.js'
import { WHEEL_SHOW_MS, WHEEL_SPIN_MS, WINNERS_CARD_MS, angleAt, drumRows, sliceAtPointer, spinPlan, wheelSlices, winnerSlice, type SpinKeyframe, type WheelSlice } from './wheel.js'

const C = {
  bg: Color4.create(0.06, 0.06, 0.1, 0.94),
  dim: Color4.create(0, 0, 0, 0.55),
  row: Color4.create(0.1, 0.1, 0.16, 1),
  rowHit: Color4.create(0.35, 0.38, 0.92, 1),
  btn: Color4.create(0.14, 0.14, 0.2, 1),
  accent: Color4.create(0.35, 0.38, 0.92, 1),
  text: Color4.create(1, 1, 1, 1),
  textDim: Color4.create(0.65, 0.65, 0.7, 1),
  success: Color4.create(0.18, 0.75, 0.38, 1),
  danger: Color4.create(0.88, 0.28, 0.28, 1),
  virvi: Color4.create(8 / 255, 221 / 255, 235 / 255, 1),
}

interface WheelRun {
  slices: WheelSlice[]
  plan: SpinKeyframe[]
  winners: string[]
  elapsedMs: number
}

const ui: { card: RaffleCard; wheel: WheelRun | null; onAction: ((a: CardAction) => void) | null } = {
  card: initialCard(true),
  wheel: null,
  onAction: null,
}

export function setRaffleCard(card: RaffleCard): void {
  ui.card = card
}

export function setRaffleCardHandler(handler: (a: CardAction) => void): void {
  ui.onAction = handler
}

/** Spin the wheel for a draw: it lands on the first winner. A new draw replaces a spin still running. */
export function startWheel(draw: PublicDraw): void {
  const slices = wheelSlices(draw.names, draw.more)
  if (!slices.length) return
  const winners = draw.winners.map((w) => w.displayName)
  ui.wheel = { slices, plan: spinPlan(slices.length, winnerSlice(slices, winners[0] ?? ''), WHEEL_SPIN_MS), winners, elapsedMs: 0 }
}

const wheelLength = (w: WheelRun) => WHEEL_SHOW_MS + (w.winners.length > 1 ? WINNERS_CARD_MS : 0)

/** Advance the wheel by engine time; false once no wheel is showing. */
export function advanceWheel(dtMs: number): boolean {
  if (!ui.wheel) return false
  ui.wheel.elapsedMs += dtMs
  if (ui.wheel.elapsedMs >= wheelLength(ui.wheel)) ui.wheel = null
  return !!ui.wheel
}

export const wheelShowing = () => !!ui.wheel

let mounted = false

/** Mount once: inside the host HUD's tree when there is one, else as its own UI root. */
export function mountRaffleOverlay(hud: { setOverlay(component: () => ReactEcs.JSX.Element | null): void } | null): void {
  if (mounted) return
  mounted = true
  if (hud) hud.setOverlay(RaffleOverlay)
  // Same 1920x1080 design size as the HUD; under the HUD (zIndex 1000), over the scene's own UI
  else ReactEcsRenderer.addUiRenderer(engine.addEntity(), RaffleOverlay, { virtualWidth: 1920, virtualHeight: 1080, zIndex: 900 })
}

// ---------------------------------------------------------------------------

const CARD_W = 320
const BODY_H = 220
const press = (a: CardAction) => () => { markHudPress(); ui.onAction?.(a) }

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

function RaffleCardView() {
  const v = cardView(ui.card)
  if (!v.visible) return null
  const primary = (id: CardAction) => id === 'enter' || id === 'confirm'
  const bodyWidth = CARD_W - 28
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { right: 12, bottom: 160 }, width: CARD_W, flexDirection: 'column', padding: 12 }}
      uiBackground={{ color: C.bg }}
      onMouseDown={markHudPress}
    >
      <Label value="RAFFLE" fontSize={10} color={C.virvi} textAlign="top-left" uiTransform={{ width: '100%', height: 14 }} />
      <Label value={plainText(v.title)} fontSize={15} color={C.text} textAlign="top-left" uiTransform={{ width: '100%', height: 22 }} />
      <Label value={plainText(v.prize)} fontSize={12} color={C.textDim} textAlign="top-left" textWrap="wrap" uiTransform={{ width: '100%', height: textHeight(v.prize, 12, bodyWidth) }} />
      <Label value={v.entries} fontSize={11} color={C.textDim} textAlign="top-left" uiTransform={{ width: '100%', height: 18 }} />
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
        <Label value={v.line} fontSize={12} color={ui.card.won ? C.success : C.text} textAlign="top-left" textWrap="wrap"
          uiTransform={{ width: '100%', height: textHeight(v.line, 12, bodyWidth), margin: { top: 4 } }} />
      )}
      {v.note && (
        <Label value={v.note} fontSize={11} color={C.danger} textAlign="top-left" textWrap="wrap"
          uiTransform={{ width: '100%', height: textHeight(v.note, 11, bodyWidth) }} />
      )}
      {v.actions.length > 0 && (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap' }}>
          {v.actions.map((a) => <CardButton key={a.id} label={a.label} primary={primary(a.id)} onPress={press(a.id)} />)}
        </UiEntity>
      )}
    </UiEntity>
  )
}

const ROW_H = 54
const AROUND = 3
const DRUM_W = 560

function Wheel() {
  const w = ui.wheel
  if (!w) return null
  const n = w.slices.length
  const angle = angleAt(w.plan, w.elapsedMs)
  const landed = w.elapsedMs >= WHEEL_SPIN_MS
  const winner = w.winners[0] ?? ''
  if (w.elapsedMs >= WHEEL_SHOW_MS && w.winners.length > 1) return <WinnersCard winners={w.winners} />
  const atPointer = sliceAtPointer(angle, n)
  const drumH = ROW_H * (AROUND * 2 + 1)
  const centre = drumH / 2
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: '18%', left: 0 }, width: '100%', height: drumH + 120, flexDirection: 'column', alignItems: 'center' }}
      uiBackground={{ color: C.dim }}
    >
      <Label value={plainText(ui.card.raffle?.name ?? 'Raffle')} fontSize={22} color={C.text} uiTransform={{ height: 40, margin: { top: 10 } }} />
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
        <Label value=">" fontSize={36} color={C.virvi} uiTransform={{ width: 40, height: ROW_H }} />
        <UiEntity uiTransform={{ width: DRUM_W, height: drumH, overflow: 'hidden' }} uiBackground={{ color: C.bg }}>
          {drumRows(angle, n, AROUND).map((r, i) => {
            const hit = r.index === atPointer
            const slice = w.slices[r.index]
            return (
              <UiEntity
                key={i}
                uiTransform={{ positionType: 'absolute', position: { left: 0, top: centre + r.offset * ROW_H - ROW_H / 2 }, width: DRUM_W, height: ROW_H - 4, alignItems: 'center', justifyContent: 'center' }}
                uiBackground={{ color: hit ? C.rowHit : C.row }}
              >
                <Label value={plainText(slice.label)} fontSize={hit ? 22 : 18} color={slice.more ? C.textDim : C.text} textWrap="nowrap" />
              </UiEntity>
            )
          })}
        </UiEntity>
        <Label value="<" fontSize={36} color={C.virvi} uiTransform={{ width: 40, height: ROW_H }} />
      </UiEntity>
      {landed && <Label value={plainText(`${winner} wins!`)} fontSize={28} color={C.success} uiTransform={{ height: 50, margin: { top: 10 } }} />}
    </UiEntity>
  )
}

function WinnersCard({ winners }: { winners: string[] }) {
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: '18%', left: '35%' }, width: '30%', flexDirection: 'column', alignItems: 'center', padding: 18 }}
      uiBackground={{ color: C.bg }}
    >
      <Label value="Winners" fontSize={24} color={C.success} uiTransform={{ height: 40 }} />
      {winners.map((name, i) => (
        <Label key={i} value={plainText(`${i + 1}. ${name}`)} fontSize={18} color={C.text} textWrap="nowrap" uiTransform={{ height: 30 }} />
      ))}
    </UiEntity>
  )
}

export function RaffleOverlay() {
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}>
      <RaffleCardView />
      <Wheel />
    </UiEntity>
  )
}
