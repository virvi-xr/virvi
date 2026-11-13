/**
 * Raffles in the scene (LIV-55): feeds the overlay's card from the room's `raffle_changed` (sent on join and on every
 * change, so guests need no REST), spins the wheel on `raffle_draw`, and checks entrants in while they're entered.
 * Verified visitors also read GET …/raffle/current once connected, for their own entry (entered / won).
 */
import type { Virvi } from '@virvixr/core'
import { cardReducer, CheckInClock, checkInWanted, errorCodeOf, initialCard, raffleEntryError, type CardAction, type CardEvent } from './card.js'
import { advanceWheel, mountRaffleOverlay, setRaffleCard, setRaffleCardHandler, startWheel, wheelShowing } from './RaffleOverlay.js'
import { httpStatusOf } from '../edit-errors.js'

type Systems = { registerSystem(fn: (dt: number) => void): void }
type Hud = Parameters<typeof mountRaffleOverlay>[0]

export interface SceneRaffles {
  /** Call after each connect: verified visitors read their own entry. */
  connected(): void
}

const started = new WeakMap<Virvi, SceneRaffles>()

/** Start once per Virvi, before connecting, so the room's first `raffle_changed` (sent on join) isn't missed. */
export function startSceneRaffles(virvi: Virvi, systems: Systems, opts: { guest: boolean; hud: Hud }): SceneRaffles {
  const existing = started.get(virvi)
  if (existing) return existing

  let card = initialCard(opts.guest)
  const dispatch = (e: CardEvent) => {
    card = cardReducer(card, e)
    setRaffleCard(card)
  }
  // The draw result for me waits until the wheel has landed, so the card doesn't give it away
  let pendingWon: boolean | null = null

  const readMine = async () => {
    if (opts.guest) return null
    try {
      return await virvi.getCurrentRaffle()
    } catch {
      return null // the card still works from the room's messages
    }
  }

  virvi.onRaffleChanged((raffle) => dispatch({ type: 'raffle', raffle }))
  virvi.onRaffleDraw((draw) => {
    if (draw.raffleId !== card.raffle?.id) return
    startWheel(draw)
    dispatch({ type: 'drawn', won: false })
    if (!card.entered) return
    void readMine().then((cur) => {
      if (cur?.raffle?.id === draw.raffleId && cur.myEntry?.won) pendingWon = true
    })
  })

  const clock = new CheckInClock()
  let checking = false
  const checkIn = (raffleId: string) => {
    checking = true
    virvi.raffleCheckIn(raffleId).then(
      () => {},
      (err) => {
        // 429 too_soon: the server already counted a recent one. 404: no entry any more (withdrawn elsewhere).
        if (httpStatusOf(err) === 404 && errorCodeOf(err) === 'not_entered' && card.raffle?.id === raffleId) dispatch({ type: 'mine', entered: false, won: card.won })
      },
    ).finally(() => { checking = false })
  }

  // Engine time drives the wheel, the won reveal and the check-ins (the platform has no timers)
  systems.registerSystem((dt: number) => {
    advanceWheel(dt * 1000)
    if (pendingWon !== null && !wheelShowing()) {
      dispatch({ type: 'drawn', won: pendingWon })
      pendingWon = null
    }
    if (clock.tick(dt, checkInWanted(card)) && !checking && card.raffle) checkIn(card.raffle.id)
  })

  setRaffleCardHandler((action: CardAction) => {
    const raffleId = card.raffle?.id
    if (!raffleId) return
    if (action === 'confirm') {
      if (card.view !== 'consent' || card.busy) return
      dispatch({ type: 'confirm' })
      virvi.enterRaffle(raffleId).then(
        () => { clock.reset(); dispatch({ type: 'entered' }) },
        (err) => dispatch(errorCodeOf(err) === 'already_entered' ? { type: 'entered' } : { type: 'failed', note: raffleEntryError(err) }),
      )
      return
    }
    if (action === 'withdraw') {
      if (!card.entered || card.busy) return
      dispatch({ type: 'withdraw' })
      virvi.withdrawRaffle(raffleId).then(
        () => dispatch({ type: 'withdrawn' }),
        (err) => dispatch(errorCodeOf(err) === 'not_entered' ? { type: 'withdrawn' } : { type: 'failed', note: raffleEntryError(err) }),
      )
      return
    }
    dispatch({ type: action })
  })

  mountRaffleOverlay(opts.hud)
  setRaffleCard(card)

  const api: SceneRaffles = {
    connected() {
      void readMine().then((cur) => {
        if (!cur) return
        dispatch({ type: 'raffle', raffle: cur.raffle })
        if (cur.myEntry) dispatch({ type: 'mine', entered: true, won: cur.myEntry.won })
      })
    },
  }
  started.set(virvi, api)
  return api
}
