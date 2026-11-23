import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Wallet, type Provider } from 'ethers'
import { config } from '../config.js'
import { GiveawayError } from './errors.js'

// Each giveaway's own Polygon wallet. The private key is sealed with AES-256-GCM (12-byte iv) under
// GIVEAWAY_WALLET_SECRET and stored as `v1:<iv>:<tag>:<ciphertext>` (base64). Callers check config.giveaways.enabled first.

function secret(): Buffer {
  const key = config.giveaways.walletSecret
  if (!key) throw new Error('GIVEAWAY_WALLET_SECRET is not set')
  return key
}

/** A fresh random wallet: its checksummed address and its sealed private key. */
export function newGiveawayWallet(): { address: string; keyEnc: string } {
  const wallet = Wallet.createRandom()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secret(), iv)
  const ct = Buffer.concat([cipher.update(wallet.privateKey, 'utf8'), cipher.final()])
  const keyEnc = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
  return { address: wallet.address, keyEnc }
}

/** The wallet behind a sealed key, connected to `provider` if given. A bad seal throws key_unreadable (never any key material). */
export function giveawaySigner(keyEnc: string, provider?: Provider): Wallet {
  const unreadable = () => new GiveawayError(500, 'key_unreadable', "This giveaway wallet can't be used.")
  const [version, iv, tag, ct] = keyEnc.split(':')
  if (version !== 'v1' || !iv || !tag || !ct) throw unreadable()
  try {
    const decipher = createDecipheriv('aes-256-gcm', secret(), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    const key = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8')
    return new Wallet(key, provider)
  } catch {
    throw unreadable()
  }
}
