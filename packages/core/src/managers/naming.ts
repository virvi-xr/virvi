/**
 * The name a Virvi item shows up under in analytics: the element's name, else the file it plays (last path
 * segment, no query), else the kind of item.
 */
export function itemName(name: string | undefined, src: string | undefined, kind: string): string {
  if (name) return name
  const file = src?.split(/[?#]/)[0].split('/').filter(Boolean).pop()
  return file || kind
}
