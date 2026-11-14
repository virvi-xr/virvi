# VirviBeat contract

`src/VirviBeat.sol` is the contract behind BEATs: free attendance tokens for Virvi events, on Polygon.
It is an ERC-1155 built on OpenZeppelin Contracts 5.4.0, compiled with solc 0.8.28.

## What it can and can't do

**What it does:**
- Each BEAT is one token id. Virvi's minter wallet creates the id once, and decides at that moment
  whether the BEAT can be traded. That choice can never be changed afterwards.
- The minter sends one BEAT to each wallet in a list, up to 200 wallets per call.
- A wallet can receive a given BEAT **once, ever**. If it is on the list twice, or the list is sent
  again, or it already burned or traded its BEAT away, it is skipped and gets nothing more.
- A BEAT that isn't tradeable can't be moved to another wallet, by its holder or by anyone the holder
  approved. Its holder can still burn (destroy) it.
- A tradeable BEAT moves like any other ERC-1155 token.
- Wallets and marketplaces find a BEAT's name and image at `{base}{id}.json`.

**Who can do what:**
- The **admin** (the owner's wallet) can give or take away the minter's permission, and can change
  the `base` web address where names and images are looked up.
- The **minter** (Virvi's server wallet) can only create BEATs and send them.
- The wallet that deploys the contract gets no permissions at all.

**What nobody can do:**
- Nobody, not even the admin, can move, burn or change a token in someone else's wallet.
- There is no pause switch, no upgrade, and no way to delete the contract.
- It has no way to take or pay out money: sending POL to it fails, and none of its functions accept payment.

**One thing to know:** if one wallet in a list is a contract that can't accept ERC-1155 tokens, the
whole call fails and nobody in that list gets their BEAT. The server has to drop that wallet and send
the rest again.

## Build and test

Install Foundry and Slither once (`brew install foundry slither-analyzer`), then:

```
cd contracts
forge build
forge test -vv
forge snapshot --check
slither . --config-file slither.config.json
```

The dependencies (OpenZeppelin Contracts `v5.4.0`, forge-std `v1.9.7`) are committed under `lib/`, so
there's nothing to install. Only OpenZeppelin's `contracts/` source, license and readme are kept.

`forge snapshot` rewrites `.gas-snapshot`; commit it when gas changes on purpose. CI runs the same
commands (`.github/workflows/contracts.yml`) on every change under `contracts/`.

## Deploying

The owner deploys from their own machine. `--interactives 1` asks for the deployer's private key in
the terminal, so the key never lands in shell history or a file. The deployer only pays gas: it gets no
role. The admin is `BEAT_ADMIN` and the minter is `BEAT_MINTER`.

**Amoy (testnet):**

```
cd contracts && BEAT_ADMIN=0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220 BEAT_MINTER=<minter address> BEAT_BASE_URI=https://api.virvi.io/api/beats/metadata/polygon-amoy/ forge script script/Deploy.s.sol --rpc-url https://rpc-amoy.polygon.technology --broadcast --interactives 1
```

The script prints `VirviBeat deployed at 0x...`.

**Verify the Amoy deploy on Polygonscan** (needs an Etherscan API key, which covers Polygonscan):

```
cd contracts && forge verify-contract <deployed address> src/VirviBeat.sol:VirviBeat --chain 80002 --constructor-args $(cast abi-encode "constructor(address,address,string)" 0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220 <minter address> https://api.virvi.io/api/beats/metadata/polygon-amoy/) --etherscan-api-key <etherscan api key> --watch
```

**Polygon (mainnet)**, which verifies in the same step:

```
cd contracts && BEAT_ADMIN=0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220 BEAT_MINTER=<minter address> BEAT_BASE_URI=https://api.virvi.io/api/beats/metadata/polygon/ forge script script/Deploy.s.sol --rpc-url https://polygon-rpc.com --broadcast --interactives 1 --verify --etherscan-api-key <etherscan api key>
```

## Slither

Run with `slither . --config-file slither.config.json` from `contracts/` (Slither 0.11.6). The config
filters out `lib/`. CI fails on any medium or high finding.

Last run: **0 findings** (24 contracts, 102 detectors). No findings are accepted.

One `forge lint` note is silenced in `_update` (`require-revert-in-loop`): reverting on the first
non-tradeable id in a batch transfer is the intended behaviour, not a gas mistake.
