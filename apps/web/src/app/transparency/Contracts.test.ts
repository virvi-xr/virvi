import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Contracts } from './Contracts'

const AMOY = '0x5FbDB2315678afecb367f032d93F642f64180aa3'

describe('the contracts on /transparency (LIV-11)', () => {
  it('lists each contract with its explorer page and source', () => {
    const html = renderToStaticMarkup(createElement(Contracts, { contracts: [{
      chain: 'polygon-amoy', address: AMOY,
      explorerUrl: `https://amoy.polygonscan.com/address/${AMOY}`,
      sourceUrl: 'https://github.com/virvi-xr/virvi/blob/main/contracts/src/VirviBeat.sol',
    }] }))
    expect(html).toContain('Polygon Amoy (test)')
    expect(html).toContain(AMOY)
    expect(html).toContain(`href="https://amoy.polygonscan.com/address/${AMOY}"`)
    expect(html).toContain('href="https://github.com/virvi-xr/virvi/blob/main/contracts/src/VirviBeat.sol"')
  })
  it('names the deployed commit when it is recorded, and says so when it is not', () => {
    const base = { chain: 'polygon' as const, address: AMOY, explorerUrl: 'x', sourceUrl: 'https://github.com/virvi-xr/virvi/tree/main/contracts' }
    expect(renderToStaticMarkup(createElement(Contracts, { contracts: [{ ...base, deployedCommit: '6637054dabcdef' }] }))).toContain('Source code (deployed from 6637054d)')
    expect(renderToStaticMarkup(createElement(Contracts, { contracts: [{ ...base, deployedCommit: null }] }))).toContain("isn&#x27;t recorded")
  })
  it('says so when there are none yet', () => {
    expect(renderToStaticMarkup(createElement(Contracts, { contracts: [] }))).toContain('No contracts are live yet.')
  })
})
