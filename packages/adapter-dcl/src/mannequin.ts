/**
 * A giveaway kiosk's mannequin (core's setAvatarShape) as a Decentraland AvatarShape: a male or female base body
 * wearing the giveaway's wearables, or (`player`) dressed like the visitor, with the giveaway's wearables put on last
 * so they replace whatever the visitor wears in the same slot. Pure, so it is unit-tested; DclAdapter applies it.
 */
export const BODY_MALE = 'urn:decentraland:off-chain:base-avatars:BaseMale'
export const BODY_FEMALE = 'urn:decentraland:off-chain:base-avatars:BaseFemale'

type Rgb = { readonly r: number; readonly g: number; readonly b: number }
/** What the scene knows of the visitor's avatar (AvatarBase and AvatarEquippedData on the player entity). */
export interface VisitorAvatar { bodyShapeUrn?: string; wearableUrns?: readonly string[]; skinColor?: Readonly<Rgb>; hairColor?: Readonly<Rgb>; eyesColor?: Readonly<Rgb> }

export interface MannequinShape {
  id: string
  name: string
  bodyShape: string
  wearables: string[]
  emotes: string[]
  skinColor?: Rgb
  hairColor?: Rgb
  eyeColor?: Rgb
}

export function mannequinShape(
  id: string, avatar: { bodyShape: 'male' | 'female' | 'player'; wearables: string[] }, visitor: VisitorAvatar | null,
): MannequinShape {
  const prize = [...new Set(avatar.wearables)]
  if (avatar.bodyShape !== 'player') {
    return { id, name: '', bodyShape: avatar.bodyShape === 'female' ? BODY_FEMALE : BODY_MALE, wearables: prize, emotes: [] }
  }
  const own = (visitor?.wearableUrns ?? []).filter((u) => !prize.includes(u))
  return {
    id, name: '', bodyShape: visitor?.bodyShapeUrn || BODY_MALE, wearables: [...own, ...prize], emotes: [],
    skinColor: visitor?.skinColor, hairColor: visitor?.hairColor, eyeColor: visitor?.eyesColor,
  }
}
