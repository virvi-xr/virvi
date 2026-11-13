/**
 * The raffle wheel's geometry and spin (LIV-55). Pure (no @dcl/sdk), so it is unit-tested.
 *
 * The wheel turns clockwise by `angle` degrees. Slice i of n covers [i, i + 1) × 360/n before turning, so its
 * centre sits at `sliceCentre(i, n) + angle` on screen; the pointer is at POINTER_ANGLE. Decentraland's screen
 * UI can't rotate elements, so the overlay draws the wheel as a drum seen side-on (`drumRows`): the same angles,
 * with the slices passing the pointer as rows.
 */
import { WHEEL_MAX_NAMES } from '@virvixr/shared'

export const POINTER_ANGLE = 0
/** The spin itself; the wheel then rests on the winner, for about 8 s in all. */
export const WHEEL_SPIN_MS = 6_500
export const WHEEL_SHOW_MS = 8_000
/** With several winners, the card listing them all follows for this long. */
export const WINNERS_CARD_MS = 6_000
/** Whole turns before the wheel settles. */
const SPIN_TURNS = 5
const KEYFRAMES = 32

export type WheelSlice = { label: string; more: boolean }
export type SpinKeyframe = { atMs: number; angle: number }

const mod = (a: number, n: number) => ((a % n) + n) % n

/** One slice per name (at most WHEEL_MAX_NAMES), then `+N more` for the pool the wheel doesn't show. */
export function wheelSlices(names: string[], more: number): WheelSlice[] {
  const shown = names.slice(0, WHEEL_MAX_NAMES)
  const rest = Math.max(0, Math.floor(more)) + (names.length - shown.length)
  const slices = shown.map((label) => ({ label, more: false }))
  return rest > 0 ? [...slices, { label: `+${rest} more`, more: true }] : slices
}

/** The winner's slice: the first name slice with that name (names may repeat), else the first slice. */
export function winnerSlice(slices: WheelSlice[], name: string): number {
  const i = slices.findIndex((s) => !s.more && s.label === name)
  return i < 0 ? 0 : i
}

export const sliceCentre = (i: number, n: number) => ((i + 0.5) * 360) / n

/**
 * Keyframes for one spin: from rest, easing out (it only ever slows down), to an angle that puts the winner's
 * slice centre under the pointer after SPIN_TURNS whole turns.
 */
export function spinPlan(sliceCount: number, winnerIndex: number, durationMs: number): SpinKeyframe[] {
  const n = Math.max(1, sliceCount)
  const target = SPIN_TURNS * 360 + mod(POINTER_ANGLE - sliceCentre(winnerIndex, n), 360)
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
  return Array.from({ length: KEYFRAMES + 1 }, (_, k) => {
    const t = k / KEYFRAMES
    return { atMs: Math.round(durationMs * t), angle: k === KEYFRAMES ? target : target * easeOut(t) }
  })
}

/** The wheel's angle `ms` into the spin: interpolated between keyframes, resting on the last one after it. */
export function angleAt(plan: SpinKeyframe[], ms: number): number {
  if (!plan.length) return 0
  if (ms <= plan[0].atMs) return plan[0].angle
  for (let k = 1; k < plan.length; k++) {
    const a = plan[k - 1]
    const b = plan[k]
    if (ms <= b.atMs) return b.atMs === a.atMs ? b.angle : a.angle + ((b.angle - a.angle) * (ms - a.atMs)) / (b.atMs - a.atMs)
  }
  return plan[plan.length - 1].angle
}

/** Where the pointer is, in slices: 3.5 is slice 3's centre. */
const pointerPosition = (angle: number, n: number) => mod(POINTER_ANGLE - angle, 360) / (360 / n)

export function sliceAtPointer(angle: number, n: number): number {
  return Math.floor(pointerPosition(angle, n)) % n
}

/**
 * The drum's rows around the pointer: `around` slices either side of the one under it, top to bottom. `offset`
 * is in rows from the pointer (0 = centred on it; fractions while turning).
 */
export function drumRows(angle: number, n: number, around: number): { index: number; offset: number }[] {
  const pos = pointerPosition(angle, n)
  const at = Math.floor(pos)
  const rows: { index: number; offset: number }[] = []
  for (let k = -around; k <= around; k++) rows.push({ index: mod(at + k, n), offset: at + k + 0.5 - pos })
  return rows
}
