/**
 * A scene's thumbnail (LIV-88): what Virvi accepts and stores, and where it goes in a Decentraland deployment.
 *
 * Decentraland's scene metadata docs (docs.decentraland.org, sdk7 scene-metadata, checked 2026-11-06): the
 * navmapThumbnail "must be a .png or .jpg image with a 16:9 aspect ratio"; "1920x1080 pixels is the size to aim for".
 */

/** The upload limit, of the file sent. */
export const SCENE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024
/** Width over height, Decentraland's 16:9. */
export const SCENE_THUMBNAIL_RATIO = 16 / 9
/** The smallest stored image: half of Decentraland's 1920 × 1080, so it still looks sharp where it's shown. */
export const SCENE_THUMBNAIL_MIN = { width: 960, height: 540 } as const
/** Larger images are scaled down to this. */
export const SCENE_THUMBNAIL_MAX = { width: 1920, height: 1080 } as const
/** How far the stored image's width / height may be from 16:9 (rounding to whole pixels). */
export const SCENE_THUMBNAIL_RATIO_TOLERANCE = 0.01

/** Whether width × height is Decentraland's 16:9, within a pixel's rounding. */
export function isThumbnailShape(width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) return false
  return Math.abs(width / height / SCENE_THUMBNAIL_RATIO - 1) <= SCENE_THUMBNAIL_RATIO_TOLERANCE
}

/** Where Virvi puts a scene's thumbnail in a deployment: `images/scene-thumbnail-<hash>.<png|jpg>`. */
export const DEPLOYED_THUMBNAIL_RE = /^images\/scene-thumbnail-[0-9a-f]{16}\.(png|jpg)$/i
