import { withLock } from '../errors/jobs.js'
import { elementChanged } from '../routes/scenes.js'
import { recordSceneActivity } from '../scenes/activity.js'
import { sweepTimedRules, TIMED_SWEEP_MS, type ElementChangedHook } from './rules.js'

/** A timed rule's change goes out like any edit, and the activity says Virvi did it, through the rule. */
export const timedRuleChanged: ElementChangedHook = async (e, name, rule) => {
  await elementChanged(e)
  await recordSceneActivity(e.sceneId, { userId: null, wallet: null, via: 'rule' }, 'element.updated', { type: e.elementType, id: e.elementId, name }, { rule })
}

/** Timed scene rules (LIV-196): checked every 20 s, one server at a time. Returns a stop function. */
export function startTimedRuleSweep(): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await withLock('scene-rules', () => sweepTimedRules(timedRuleChanged))
    } catch (err) {
      console.error('[rules] timed sweep failed:', err instanceof Error ? err.message : err)
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, TIMED_SWEEP_MS)
  return () => clearInterval(timer)
}
