/** The getting-started checklist (LIV-37), as GET /api/me/onboarding gives it. */
export type OnboardingStepId = 'create' | 'content' | 'deploy' | 'live'
export interface Onboarding {
  steps: Array<{ id: OnboardingStepId; done: boolean }>
  complete: boolean
  sceneId: string | null
  dismissedAt: string | null
}

const DOCS = '/docs/getting-started/first-scene/'

/** Each step's wording, where to do it, and its section of the "Your first scene" guide. */
export function stepView(id: OnboardingStepId, sceneId: string | null): { title: string; body: string; href: string; action: string; docs: string } {
  switch (id) {
    case 'create':
      return { title: 'Create a scene', body: 'Start from a template, a blank scene or a scene you import.', href: '/scenes/new', action: 'New scene', docs: `${DOCS}#create-a-scene` }
    case 'content':
      return { title: 'Add something to it', body: 'Place an image, a video screen, a 3D model or a sound.', href: sceneId ? `/scenes/${sceneId}` : '/scenes', action: 'Open the scene', docs: `${DOCS}#add-something` }
    case 'deploy':
      return { title: 'Put it in a world', body: 'Deploy to a Decentraland World or your parcels, or connect a Hyperfy world.', href: sceneId ? `/sync?scene=${sceneId}` : '/sync', action: 'Go to Sync', docs: `${DOCS}#put-it-in-a-world` }
    case 'live':
      return { title: 'See it live', body: 'Visit it. The step ticks once the scene reports in from the world.', href: sceneId ? `/sync?scene=${sceneId}` : '/sync', action: 'Where it runs', docs: `${DOCS}#see-it-live` }
  }
}

/** Show the checklist while a step is left and it hasn't been dismissed. */
export const showChecklist = (o: Onboarding | null): o is Onboarding => !!o && !o.complete && !o.dismissedAt

/** "2 of 4 done" */
export const progressLine = (o: Onboarding) => `${o.steps.filter((s) => s.done).length} of ${o.steps.length} done`

/** The step to do next: the first one not done. */
export const nextStep = (o: Onboarding) => o.steps.find((s) => !s.done)?.id ?? null

const STEP_LABEL: Record<string, string> = { create: 'Created a scene', content: 'Added something', deploy: 'Put it in a world', live: 'Saw it live' }

/** The admin funnel's rows: signed up, then each step, with its share of the accounts. */
export function funnelRows(f: { accounts: number; steps: Array<{ id: string; accounts: number }> }) {
  const pct = (n: number) => (f.accounts ? `${Math.round((n / f.accounts) * 100)}%` : '0%')
  return [{ label: 'Signed up', count: f.accounts, percent: pct(f.accounts) }, ...f.steps.map((s) => ({ label: STEP_LABEL[s.id] ?? s.id, count: s.accounts, percent: pct(s.accounts) }))]
}
