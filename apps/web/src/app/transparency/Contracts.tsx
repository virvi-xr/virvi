import { BEAT_CHAIN_INFO } from '@virvixr/shared'
import type { ContractInfo } from '@/lib/transparency'

const link = 'text-blue-400 hover:underline'

/** The smart contracts Virvi uses (BEATs, LIV-11): each with its page on Polygonscan and its source in the repo. */
export function Contracts({ contracts }: { contracts: ContractInfo[] }) {
  if (contracts.length === 0) return <p className="text-gray-400">No contracts are live yet.</p>
  return (
    <ul className="space-y-3">
      {contracts.map((c) => (
        <li key={c.chain} className="rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm">
          <p className="font-medium text-white">BEAT contract on {BEAT_CHAIN_INFO[c.chain]?.label ?? c.chain}</p>
          <p className="mt-1 min-w-0 break-all font-mono text-xs text-gray-300">{c.address}</p>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <a href={c.explorerUrl} className={link}>View on Polygonscan</a>
            <a href={c.sourceUrl} className={link}>{c.deployedCommit ? `Source code (deployed from ${c.deployedCommit.slice(0, 8)})` : 'Source code'}</a>
          </p>
          {!c.deployedCommit && <p className="mt-1 text-xs text-gray-400">The commit this contract was deployed from isn't recorded, so this links to the contracts folder.</p>}
        </li>
      ))}
    </ul>
  )
}
