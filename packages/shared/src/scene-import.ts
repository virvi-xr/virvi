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
  /** The retention sweep deleted its stored files (source, build, log) 30 days after it ended. */
  filesExpired: boolean
  createdAt: string
}

/** The largest zip an import accepts. */
export const SCENE_IMPORT_MAX_BYTES = 100 * 1024 * 1024
/** The most files an imported scene may have, once node_modules/ and the like are left out. */
export const SCENE_IMPORT_MAX_FILES = 2000
/** The most an imported scene's kept files may add up to, unzipped. */
export const SCENE_IMPORT_MAX_UNZIPPED_BYTES = 300 * 1024 * 1024
