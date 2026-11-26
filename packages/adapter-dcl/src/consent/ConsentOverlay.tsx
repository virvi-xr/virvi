/**
 * The scene visitor notice (GDPR notice): a card at the top of the shared right-hand column (card-column.tsx), styled
 * as the BEAT, giveaway and raffle cards, with Accept, Decline and the privacy link. It never blocks movement. Once the
 * visitor has decided, a small "Privacy" entry at the column's foot shows it again. Drawn from the visitor's decision
 * (AnalyticsConsent) each frame.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import type { AnalyticsConsent } from '@virvixr/core'
import { markHudPress } from '../hud/press.js'
import { addColumnCard, CARD_GAP, mountCardColumn } from '../card-column.js'
import { consentAction, consentCardView, type ConsentAction } from './card.js'

const C = {
  bg: Color4.create(0.06, 0.06, 0.1, 0.94),
  row: Color4.create(0.1, 0.1, 0.16, 1),
  btn: Color4.create(0.14, 0.14, 0.2, 1),
  accent: Color4.create(0.35, 0.38, 0.92, 1),
  text: Color4.create(1, 1, 1, 1),
  textDim: Color4.create(0.65, 0.65, 0.7, 1),
  link: Color4.create(0.55, 0.7, 1, 1),
  virvi: Color4.create(8 / 255, 221 / 255, 235 / 255, 1),
}

const ui: { consent: AnalyticsConsent | null; openUrl: (url: string) => void } = { consent: null, openUrl: () => {} }

let mounted = false

/** Mount once: the notice above every other card (-1), the Privacy entry under them all (99). */
export function mountConsentOverlay(
  consent: AnalyticsConsent,
  openUrl: (url: string) => void,
  hud: { addOverlay(component: () => ReactEcs.JSX.Element | null): void } | null = null,
): void {
  ui.consent = consent
  ui.openUrl = openUrl
  if (mounted) return
  mounted = true
  addColumnCard(ConsentCardView, -1)
  addColumnCard(PrivacyEntry, 99)
  mountCardColumn(hud)
}

const CARD_W = 320
const BODY_FONT = 13
const NOTE_FONT = 12
const TAG_FONT = 11
const PRIMARY: ConsentAction[] = ['accept']

const press = (a: ConsentAction) => () => {
  markHudPress()
  if (ui.consent) consentAction(a, ui.consent, (url) => { void Promise.resolve(ui.openUrl(url)).catch(() => {}) })
}

/** Rough height of wrapped text in the card (as the BEAT card measures it). */
function textHeight(text: string, fontSize: number, width: number): number {
  const perLine = Math.max(1, Math.floor(width / (fontSize * 0.55)))
  const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0)
  return lines * fontSize * 1.45 + 8
}

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

export function ConsentCardView() {
  const { card } = consentCardView(ui.consent)
  if (!card) return null
  const bodyWidth = CARD_W - 28
  return (
    <UiEntity
      uiTransform={{ width: CARD_W, flexDirection: 'column', padding: 12, margin: { top: CARD_GAP } }}
      uiBackground={{ color: C.bg }}
      onMouseDown={markHudPress}
    >
      <Label value="VIRVI" fontSize={TAG_FONT} color={C.virvi} textAlign="top-left" uiTransform={{ height: 14 }} />
      <Label value={card.title} fontSize={15} color={C.text} textAlign="top-left" uiTransform={{ width: '100%', height: 22 }} />
      <UiEntity uiTransform={{ width: '100%', margin: { top: 6 }, padding: 6, flexDirection: 'column' }} uiBackground={{ color: C.row }}>
        <Label value={card.body} fontSize={BODY_FONT} color={C.text} textAlign="top-left" textWrap="wrap"
          uiTransform={{ width: bodyWidth - 12, height: textHeight(card.body, BODY_FONT, bodyWidth - 12) }} />
      </UiEntity>
      {card.current && (
        <Label value={card.current} fontSize={NOTE_FONT} color={C.textDim} textAlign="top-left" textWrap="wrap"
          uiTransform={{ width: '100%', height: textHeight(card.current, NOTE_FONT, bodyWidth), margin: { top: 4 } }} />
      )}
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
        {card.actions.map((a) => <CardButton key={a.id} label={a.label} primary={PRIMARY.includes(a.id)} onPress={press(a.id)} />)}
        <UiEntity uiTransform={{ height: 30, margin: { top: 6, left: 4 }, alignItems: 'center' }} onMouseDown={press('privacy')}>
          <Label value={card.link} fontSize={NOTE_FONT} color={C.link} textWrap="nowrap" />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

/** The small entry that shows the notice again, so a visitor can change their mind. */
export function PrivacyEntry() {
  if (!consentCardView(ui.consent).chip) return null
  return (
    <UiEntity
      uiTransform={{ height: 22, padding: { left: 8, right: 8 }, margin: { top: CARD_GAP }, alignItems: 'center', justifyContent: 'center' }}
      uiBackground={{ color: C.bg }}
      onMouseDown={press('reopen')}
    >
      <Label value="Privacy" fontSize={TAG_FONT} color={C.textDim} textWrap="nowrap" />
    </UiEntity>
  )
}
