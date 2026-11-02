/** Scene import: a Creator Hub or SDK7 scene uploaded as a zip, built, then deployed to a World. */
export type SceneImportStatus =
  | 'uploaded'
  | 'building'
  | 'built'
  | 'deploying'
  | 'awaiting_signature'
  | 'deployed'
  | 'failed'

export interface SceneImportView {
  id: string
  sceneId: string
  worldName: string
  kind: 'creator-hub' | 'sdk7'
  status: SceneImportStatus
  errorCode: string | null
  errorMessage: string | null
  deploymentId: string | null
  destinationId: string | null
  /** True when the web can start (or restart) the deploy: `built`, or `awaiting_signature` with the signing window passed. */
  canDeploy: boolean
  logTail: string | null
  createdAt: string
}

/** The largest zip an import accepts. */
export const SCENE_IMPORT_MAX_BYTES = 100 * 1024 * 1024
