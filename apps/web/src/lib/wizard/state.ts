import { DEFAULT_ROOM_SET_OPTIONS, plotSizeM, type Plot, type RoomSetOptions } from '@virvixr/shared'
import type { DclWorld, WizardAsset } from '../api'
import { budgetStatus, fitToBudget } from './budget'
import { clampToPlot, layoutTheme, suggestPosition, type PlacedItem } from './placement'

export type WizardStep = 'where' | 'size' | 'assets' | 'arrange' | 'deploy'

/** The 2×2 guide plot used for placement when there is no Decentraland destination. */
export const GUIDE_PLOT: Plot = { width: 2, depth: 2, base: { x: 0, y: 0 } }

export interface WizardState {
  step: WizardStep
  destinations: {
    dcl: {
      world: string; wallet: string; hasScene: boolean; footprint: DclWorld['footprint']; storage?: DclWorld['storage']
      /** Another Virvi scene the World is connected to when it was picked (disconnect it first); null or absent: none. */
      connectedScene?: DclWorld['connectedScene']
    } | null
    hyperfy: null | { kind: 'self' | 'hosted'; name: string }
    ar: null | { name: string }
  }
  /**
   * A trial chose "Decentraland World" without a wallet: the World is picked at Deploy, when the wallet is connected.
   * Decentraland's limits apply as if one were chosen.
   */
  dclLater: boolean
  plot: Plot | null
  /**
   * The room scan the scene starts from: its plot is fixed by the scan. `triangles` is the generated set's count,
   * from the last preview (null until one has loaded).
   */
  roomSet: { scanId: string; plot: Plot; options: RoomSetOptions; triangles: number | null } | null
  themeId: string | null
  items: PlacedItem[]
  spawn: { x: number; z: number }
  mode: 'virvi' | 'sign'
  name: string
  /** Whether the user typed their own Hyperfy world / AR space name; until then each follows the scene name. */
  touched: { hyperfy: boolean; ar: boolean }
  /** Items the last theme or plot change dropped to fit the budget. */
  lastDropped: number
  /** Plain-language message for the last action that could not happen. */
  notice: string | null
  /** Counter for item keys, so the reducer stays pure. */
  seq: number
}

export type WizardAction =
  /** Picking a World clears `dclLater`. */
  | { type: 'setDcl'; dcl: WizardState['destinations']['dcl'] }
  /** On clears a picked World. */
  | { type: 'setDclLater'; on: boolean }
  | { type: 'setHyperfy'; hyperfy: WizardState['destinations']['hyperfy'] }
  | { type: 'setAr'; ar: WizardState['destinations']['ar'] }
  /** Ignored while a room set is chosen: the scan fixes the plot. */
  | { type: 'setPlot'; plot: Plot }
  | { type: 'setRoomSet'; scanId: string; plot: Plot; options?: RoomSetOptions }
  | { type: 'setRoomSetOptions'; options: Partial<RoomSetOptions> }
  /** The preview's triangle count for `scanId`; ignored once another scan is chosen. */
  | { type: 'setRoomSetTriangles'; scanId: string; triangles: number }
  | { type: 'clearRoomSet' }
  | { type: 'applyTheme'; themeId: string | null; items: Array<{ asset: WizardAsset; x: number; z: number; rotationY: number }> }
  | { type: 'addAsset'; asset: WizardAsset }
  | { type: 'removeItem'; key: string }
  | { type: 'moveItem'; key: string; x: number; z: number }
  | { type: 'rotateItem'; key: string }
  | { type: 'moveSpawn'; x: number; z: number }
  | { type: 'setMode'; mode: 'virvi' | 'sign' }
  | { type: 'setName'; name: string }
  /** The user typing a Hyperfy world / AR space name: it stops following the scene name. */
  | { type: 'setHyperfyName'; name: string }
  | { type: 'setArName'; name: string }
  | { type: 'goTo'; step: WizardStep }

/** The server's limit on a Hyperfy world name (a scene name may be up to 120). */
export const HYPERFY_NAME_MAX = 100
const hyperfyName = (name: string) => name.slice(0, HYPERFY_NAME_MAX)

/** Default arrival point: centre along x, 1 m in from the south edge (matches the server). */
export function defaultSpawn(plot: Plot): { x: number; z: number } {
  return { x: plotSizeM(plot).x / 2, z: 1 }
}

export const initialState: WizardState = {
  step: 'where',
  destinations: { dcl: null, hyperfy: null, ar: null },
  dclLater: false,
  plot: null,
  roomSet: null,
  themeId: null,
  items: [],
  spawn: defaultSpawn(GUIDE_PLOT),
  mode: 'virvi',
  name: '',
  touched: { hyperfy: false, ar: false },
  lastDropped: 0,
  notice: null,
  seq: 0,
}

/** The plot used for placement: the chosen one, else the guide plot. */
export function effectivePlot(state: WizardState): Plot {
  return state.plot ?? GUIDE_PLOT
}

/** Decentraland is a destination: a World is picked, or will be at Deploy. */
export function goesToDcl(state: WizardState): boolean {
  return !!state.destinations.dcl || state.dclLater
}

/** Budget for the current items; hard limits apply only with a Decentraland destination. */
export function stateBudget(state: WizardState, items = state.items) {
  const dcl = state.destinations.dcl
  return budgetStatus(items, goesToDcl(state) ? state.plot : null, dcl?.storage ?? null, state.roomSet && { triangles: state.roomSet.triangles })
}

function clampSpawn(plot: Plot, s: { x: number; z: number }) {
  const size = plotSizeM(plot)
  return { x: Math.min(size.x, Math.max(0, s.x)), z: Math.min(size.z, Math.max(0, s.z)) }
}

/** Decentraland limits apply only with a dcl destination and a chosen plot; otherwise every item stays. */
function fitIfLimited(state: WizardState, items: PlacedItem[], plot: Plot | null) {
  const room = state.roomSet && { triangles: state.roomSet.triangles }
  return goesToDcl(state) && plot ? fitToBudget(items, plot, room) : { items, dropped: 0 }
}

/** Moves to `plot`: items are clamped inside it and fitted to its budget, and a default spawn follows it. */
function withPlot(state: WizardState, plot: Plot): WizardState {
  const clamped = state.items.map((i) => clampToPlot(plot, i))
  const fit = fitIfLimited(state, clamped, plot)
  const old = effectivePlot(state)
  const wasDefault = state.spawn.x === defaultSpawn(old).x && state.spawn.z === defaultSpawn(old).z
  return {
    ...state,
    plot,
    items: fit.items,
    lastDropped: fit.dropped,
    spawn: wasDefault ? defaultSpawn(plot) : clampSpawn(plot, state.spawn),
    notice: null,
  }
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'setDcl':
      return { ...state, destinations: { ...state.destinations, dcl: action.dcl }, dclLater: action.dcl ? false : state.dclLater, notice: null }
    case 'setDclLater':
      return {
        ...state,
        dclLater: action.on,
        destinations: action.on ? { ...state.destinations, dcl: null } : state.destinations,
        notice: null,
      }
    case 'setHyperfy': {
      // Turned on (again): it starts from the scene name and follows it until the user types their own.
      const fresh = !state.destinations.hyperfy && !!action.hyperfy
      const hyperfy = fresh && action.hyperfy ? { ...action.hyperfy, name: hyperfyName(state.name) } : action.hyperfy
      const touched = fresh || !action.hyperfy ? { ...state.touched, hyperfy: false } : state.touched
      return { ...state, destinations: { ...state.destinations, hyperfy }, touched, notice: null }
    }
    case 'setAr': {
      const fresh = !state.destinations.ar && !!action.ar
      const ar = fresh && action.ar ? { ...action.ar, name: state.name } : action.ar
      const touched = fresh || !action.ar ? { ...state.touched, ar: false } : state.touched
      return { ...state, destinations: { ...state.destinations, ar }, touched, notice: null }
    }
    case 'setHyperfyName': {
      const h = state.destinations.hyperfy
      if (!h) return state
      return { ...state, destinations: { ...state.destinations, hyperfy: { ...h, name: action.name } }, touched: { ...state.touched, hyperfy: true } }
    }
    case 'setArName': {
      const a = state.destinations.ar
      if (!a) return state
      return { ...state, destinations: { ...state.destinations, ar: { ...a, name: action.name } }, touched: { ...state.touched, ar: true } }
    }
    case 'setPlot':
      return state.roomSet ? state : withPlot(state, action.plot)
    case 'setRoomSet': {
      const same = state.roomSet?.scanId === action.scanId
      const options = action.options ?? state.roomSet?.options ?? DEFAULT_ROOM_SET_OPTIONS
      // Only the size comes from the scan: the plot keeps the base the wizard already uses.
      const plot: Plot = { width: action.plot.width, depth: action.plot.depth, base: state.plot?.base ?? action.plot.base }
      const roomSet = { scanId: action.scanId, plot, options, triangles: same ? state.roomSet!.triangles : null }
      return withPlot({ ...state, roomSet }, plot)
    }
    case 'setRoomSetOptions':
      return state.roomSet ? { ...state, roomSet: { ...state.roomSet, options: { ...state.roomSet.options, ...action.options } } } : state
    case 'setRoomSetTriangles':
      return state.roomSet?.scanId === action.scanId ? { ...state, roomSet: { ...state.roomSet, triangles: action.triangles } } : state
    case 'clearRoomSet':
      return { ...state, roomSet: null, notice: null }
    case 'applyTheme': {
      const plot = effectivePlot(state)
      const fit = fitIfLimited(state, layoutTheme(action.items, plot), state.plot)
      return { ...state, themeId: action.themeId, items: fit.items, lastDropped: fit.dropped, seq: state.seq + fit.items.length, notice: null }
    }
    case 'addAsset': {
      const plot = effectivePlot(state)
      const pos = suggestPosition(plot, state.items, action.asset, state.spawn)
      if (!pos) return { ...state, notice: `There is no free room left on the plot for ${action.asset.name}` }
      const item: PlacedItem = { key: `item-${state.seq}`, asset: action.asset, x: pos.x, z: pos.z, rotationY: 0 }
      const items = [...state.items, item]
      const over = stateBudget(state, items).over
      if (over) return { ...state, notice: over }
      return { ...state, items, seq: state.seq + 1, lastDropped: 0, notice: null }
    }
    case 'removeItem':
      return { ...state, items: state.items.filter((i) => i.key !== action.key), notice: null }
    case 'moveItem':
      return {
        ...state,
        items: state.items.map((i) => (i.key === action.key ? clampToPlot(effectivePlot(state), { ...i, x: action.x, z: action.z }) : i)),
      }
    case 'rotateItem':
      return {
        ...state,
        items: state.items.map((i) =>
          i.key === action.key ? clampToPlot(effectivePlot(state), { ...i, rotationY: (i.rotationY + 90) % 360 }) : i,
        ),
      }
    case 'moveSpawn':
      return { ...state, spawn: clampSpawn(effectivePlot(state), { x: action.x, z: action.z }) }
    case 'setMode':
      return { ...state, mode: action.mode }
    case 'setName': {
      const { hyperfy, ar } = state.destinations
      return {
        ...state,
        name: action.name,
        destinations: {
          ...state.destinations,
          hyperfy: hyperfy && !state.touched.hyperfy ? { ...hyperfy, name: hyperfyName(action.name) } : hyperfy,
          ar: ar && !state.touched.ar ? { ...ar, name: action.name } : ar,
        },
      }
    }
    case 'goTo':
      return { ...state, step: action.step, notice: null }
  }
}

export function canAdvance(state: WizardState): boolean {
  const { dcl, hyperfy, ar } = state.destinations
  switch (state.step) {
    case 'where':
      return !!state.name.trim() && !!(dcl || state.dclLater || hyperfy || ar)
    case 'size':
      return goesToDcl(state) ? !!state.roomSet || state.plot !== null : true
    case 'assets':
    case 'arrange':
      return stateBudget(state).over === null
    case 'deploy':
      return false
  }
}
