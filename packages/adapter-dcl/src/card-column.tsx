/**
 * The visitor cards' column (raffle, BEAT): one right-hand column at the raffle card's old spot (right 12, bottom
 * 160), growing upward, so the cards stack and can't overlap. Each card registers itself with a place in the order;
 * a hidden card renders null and takes no room. One UI root, like the overlays: inside the host HUD's tree when there
 * is one, else its own ReactEcsRenderer root.
 */
import ReactEcs, { ReactEcsRenderer, UiEntity } from '@dcl/sdk/react-ecs'
import { engine } from '@dcl/sdk/ecs'

type Card = () => ReactEcs.JSX.Element | null
const cards: { order: number; Card: Card }[] = []

/** Add a card to the column; lower `order` sits higher up. Adding one twice is a no-op. */
export function addColumnCard(Card: Card, order: number): void {
  if (cards.some((c) => c.Card === Card)) return
  cards.push({ order, Card })
  cards.sort((a, b) => a.order - b.order)
}

/** The gap between stacked cards. */
export const CARD_GAP = 8

function CardColumn() {
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { right: 12, bottom: 160 }, flexDirection: 'column', alignItems: 'flex-end' }}>
      {cards.map(({ Card }, i) => <Card key={i} />)}
    </UiEntity>
  )
}

let mounted = false

/** Mount once: inside the host HUD's tree when there is one, else as its own UI root. */
export function mountCardColumn(hud: { addOverlay(component: () => ReactEcs.JSX.Element | null): void } | null): void {
  if (mounted) return
  mounted = true
  if (hud) hud.addOverlay(CardColumn)
  // Same 1920x1080 design size as the HUD; under the HUD (zIndex 1000), over the scene's own UI
  else ReactEcsRenderer.addUiRenderer(engine.addEntity(), CardColumn, { virtualWidth: 1920, virtualHeight: 1080, zIndex: 900 })
}
