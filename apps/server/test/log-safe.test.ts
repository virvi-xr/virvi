// RPC URLs carry provider keys in their path (Alchemy: /v2/<key>); a logged error must never include one.
import { describe, it, expect } from 'vitest'
import { safeErr } from '../src/beats/job.js'
import { logSafe } from '../src/errors/log-safe.js'

const KEY = 'TZwL7YESiGMxxxxxxxxxxxxxxxxxxxxx'
const ethersStyle = () => new Error(`server response 400 Bad Request (request={  }, info={ "requestUrl": "https://polygon-mainnet.g.alchemy.com/v2/${KEY}", "responseBody": "{\\"error\\":{\\"message\\":\\"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.\\"}}" }, code=SERVER_ERROR)`)

describe('logSafe', () => {
  it('keeps a URL\'s host and drops its path, query and credentials', () => {
    const out = logSafe(`fetch failed for https://user:pass@rpc.example.com/v2/${KEY}?apikey=abc#x and http://localhost:8545`)
    expect(out).toContain('https://rpc.example.com/…')
    expect(out).toContain('http://localhost:8545')
    expect(out).not.toContain(KEY)
    expect(out).not.toContain('pass')
    expect(out).not.toContain('apikey')
  })

  it('keeps the rest of an ethers error readable', () => {
    const out = logSafe(ethersStyle().message)
    expect(out).not.toContain(KEY)
    expect(out).toContain('polygon-mainnet.g.alchemy.com')
    expect(out).toContain('10 block range')
  })

  it('safeErr (the BEAT jobs\' log formatter) never prints an RPC key', () => {
    expect(safeErr(ethersStyle())).not.toContain(KEY)
  })
})
