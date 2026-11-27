import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { hyperfyWorlds, sceneDeployments, sceneElementInstances, sceneElements, scenePresets, scenes, users } from '../db/schema.js'

/**
 * Guided onboarding (LIV-37): the four steps from signing up to a live scene, each worked out from what the account has
 * actually done, so progress needs no saving and survives leaving. Only the account's own scenes count.
 * - create: owns a scene (not in Trash)
 * - content: one of them has an item placed (an element with a copy)
 * - deploy: Virvi deployed one (a Decentraland World or parcels), a Hyperfy world is connected to one, or a
 *   Decentraland HUD has called from one (a scene deployed from the owner's own project)
 * - live: one is running somewhere: its Decentraland HUD or a connected Hyperfy world has reported in
 */
export const ONBOARDING_STEPS = ['create', 'content', 'deploy', 'live'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

const own = (userId: string) => and(eq(scenes.ownerId, userId), isNull(scenes.deletedAt))

async function has(q: Promise<unknown[]>): Promise<boolean> {
  return (await q).length > 0
}

/** Which steps the account has done, its first scene (for the checklist's links), and whether it dismissed the list. */
export async function onboardingOf(userId: string) {
  const [first] = await db.select({ id: scenes.id }).from(scenes).where(own(userId)).orderBy(scenes.createdAt).limit(1)
  const content = first ? await has(db.select({ id: sceneElementInstances.id }).from(sceneElementInstances)
    .innerJoin(sceneElements, eq(sceneElements.id, sceneElementInstances.elementId))
    .innerJoin(scenePresets, eq(scenePresets.id, sceneElements.presetId))
    .innerJoin(scenes, eq(scenes.id, scenePresets.sceneId)).where(own(userId)).limit(1)) : false
  const deployed = first ? await has(db.select({ id: sceneDeployments.id }).from(sceneDeployments)
    .innerJoin(scenes, eq(scenes.id, sceneDeployments.sceneId))
    .where(and(own(userId), eq(sceneDeployments.status, 'deployed'), isNull(sceneDeployments.removedAt))).limit(1)) : false
  const world = first ? await has(db.select({ id: hyperfyWorlds.id }).from(hyperfyWorlds)
    .innerJoin(scenes, eq(scenes.id, hyperfyWorlds.sceneId)).where(own(userId)).limit(1)) : false
  const hud = first ? await has(db.select({ id: scenes.id }).from(scenes).where(and(own(userId), isNotNull(scenes.dclHudSeenAt))).limit(1)) : false
  const worldSeen = first ? await has(db.select({ id: hyperfyWorlds.id }).from(hyperfyWorlds)
    .innerJoin(scenes, eq(scenes.id, hyperfyWorlds.sceneId)).where(and(own(userId), isNotNull(hyperfyWorlds.lastSeenAt))).limit(1)) : false
  const done: Record<OnboardingStep, boolean> = { create: !!first, content, deploy: deployed || world || hud, live: hud || worldSeen }
  const [u] = await db.select({ dismissedAt: users.onboardingDismissedAt }).from(users).where(eq(users.id, userId))
  return {
    steps: ONBOARDING_STEPS.map((id) => ({ id, done: done[id] })),
    complete: ONBOARDING_STEPS.every((id) => done[id]),
    sceneId: first?.id ?? null,
    dismissedAt: u?.dismissedAt ?? null,
  }
}

/** Hides the checklist, or (dismissed false) shows it again. */
export async function setOnboardingDismissed(userId: string, dismissed: boolean) {
  await db.update(users).set({ onboardingDismissedAt: dismissed ? sql`now()` : null }).where(eq(users.id, userId))
  return onboardingOf(userId)
}

/**
 * Where new accounts stop (LIV-37's funnel), for admins: of the accounts made in the last `days` days (no trials, no
 * admins), how many reached each step, and how many dismissed the checklist. Counts only, no one named.
 */
export async function onboardingFunnel(days = 90) {
  const rows = await db.execute(sql`
    with cohort as (
      select u.id, u.onboarding_dismissed_at from users u
      where u.created_at > now() - make_interval(days => ${days}) and not u.is_trial and u.role <> 'admin'
    ), owned as (
      select s.id, s.owner_id, s.dcl_hud_seen_at from scenes s where s.deleted_at is null and s.owner_id in (select id from cohort)
    ), flags as (
      select c.id, c.onboarding_dismissed_at is not null as dismissed,
        exists (select 1 from owned o where o.owner_id = c.id) as created,
        exists (select 1 from owned o join scene_presets p on p.scene_id = o.id join scene_elements e on e.preset_id = p.id
                join scene_element_instances i on i.element_id = e.id where o.owner_id = c.id) as content,
        exists (select 1 from owned o where o.owner_id = c.id and (o.dcl_hud_seen_at is not null
                or exists (select 1 from scene_deployments d where d.scene_id = o.id and d.status = 'deployed' and d.removed_at is null)
                or exists (select 1 from hyperfy_worlds w where w.scene_id = o.id))) as deployed,
        exists (select 1 from owned o where o.owner_id = c.id and (o.dcl_hud_seen_at is not null
                or exists (select 1 from hyperfy_worlds w where w.scene_id = o.id and w.last_seen_at is not null))) as live
      from cohort c
    )
    select count(*)::int as accounts, count(*) filter (where created)::int as create, count(*) filter (where content)::int as content,
      count(*) filter (where deployed)::int as deploy, count(*) filter (where live)::int as live, count(*) filter (where dismissed)::int as dismissed
    from flags`) as unknown as Array<Record<string, number>>
  const r = rows[0] ?? {}
  return { days, accounts: r.accounts ?? 0, steps: ONBOARDING_STEPS.map((id) => ({ id, accounts: r[id] ?? 0 })), dismissed: r.dismissed ?? 0 }
}
