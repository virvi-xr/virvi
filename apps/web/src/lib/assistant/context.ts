import type { AssistantPageContext } from '@virvixr/shared'

/** What the assistant is told about the page the user is on: the path, plus the scene/event/location the page is showing. */
export function pageContext(pathname: string, search: string): AssistantPageContext {
  const path = pathname.replace(/^\/demo(?=\/|$)/, '') || '/'
  const q = new URLSearchParams(search)
  const ctx: AssistantPageContext = { path }
  const section = path.split('/')[1]
  if (section === 'scenes') {
    const id = q.get('id')
    if (id) ctx.sceneId = id
  } else if (section === 'events') {
    const id = q.get('id')
    if (id) ctx.eventId = id
  } else if (section === 'analytics') {
    const location = q.get('location')
    const scene = q.get('scene')
    if (location) ctx.locationId = location
    if (scene) ctx.sceneId = scene
  } else if (section === 'deploy') {
    const scene = q.get('scene')
    if (scene) ctx.sceneId = scene
  }
  return ctx
}
