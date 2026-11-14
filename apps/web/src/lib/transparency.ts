// The Transparency & Safety page (LIV-165): what the server says it runs, and the prompt to check it with an AI agent.

import type { BeatChain } from '@virvixr/shared'

export const REPO_URL = 'https://github.com/virvi-xr/virvi'

/** A BEAT contract (LIV-11): its explorer page, and its source in the repo at the running commit. */
export type ContractInfo = { chain: BeatChain; address: string; explorerUrl: string; sourceUrl: string }

export type ReleaseInfo = {
  repo: string
  release: string
  commit: string | null
  commitUrl: string | null
  buildUrl: string | null
  image: string | null
  buildArgs: Record<string, string>
  verified: boolean
  manifest: { url: string; sha256: string } | null
  contracts?: ContractInfo[]
}

/** A prompt anyone can paste into an AI agent (one that can read GitHub and websites) to check Virvi themselves. */
export function agentPrompt(site: { web: string; api: string }): string {
  return `Please check the Virvi app for me. Its code is public at ${REPO_URL}.

1. Wallets: find every place the code asks a wallet to sign or send something. Confirm it only signs me in, or deploys or pays for something I chose, and that nothing can move my tokens, NFTs or money without me approving it in my wallet.
2. Smart contracts: list every contract address and contract call in the code. Say what each one is, and flag anything unknown, unverified or suspicious.
3. Privacy: read ${site.web}/privacy/ and check the code only collects and shares what that page says.
4. Live version: get the commit from ${site.api}/api/transparency, confirm that commit is in the public repo, and do the checks above on that commit.
5. Contracts: for each contract listed there, check that its Polygonscan-verified source matches the file at its sourceUrl.

Tell me in plain language what you found, anything that looks risky, and anything you couldn't check.`
}
