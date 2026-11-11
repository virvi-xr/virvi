/**
 * An undici Agent whose connect step resolves the host itself and refuses private addresses, so the address it
 * connects to is the one it checked (no DNS rebinding between assertPublicHttpUrl and the connection).
 */
import { Agent } from 'undici'
import { defaultLookup, isPrivateAddress } from './public-url.js'

export type Lookup = (host: string) => Promise<string[]>

export function guardedAgent(lookup: Lookup = defaultLookup, opts: { allowPrivate?: () => boolean } = {}): Agent {
  return new Agent({
    connect: {
      lookup: (host: string, options: any, cb: any) => {
        lookup(host).then(
          (addresses) => {
            if (!opts.allowPrivate?.() && (addresses.length === 0 || addresses.some(isPrivateAddress))) {
              return cb(new Error(`Refusing non-public address for ${host}`))
            }
            const family = (a: string) => (a.includes(':') ? 6 : 4)
            if (options?.all) cb(null, addresses.map((address) => ({ address, family: family(address) })))
            else cb(null, addresses[0], family(addresses[0]))
          },
          (err) => cb(err),
        )
      },
    },
  })
}
