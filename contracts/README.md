# VirviBeat contract

BEATs are free attendance tokens for Virvi events. This folder holds the contract (the program on the
blockchain) that creates them, on Polygon.

## What this contract can and can't do

**Words used here:**
- **Wallet:** an account on the blockchain, with an address starting `0x`.
- **BEAT:** one attendance token design for one event, identified by a number (its id, e.g. `7`).
- **Mint:** create a token and put it in a wallet. **Burn:** destroy it for good. This can't be undone.
- **Polygon** is the blockchain. **POL** is its coin, used to pay fees (called **gas**). **Amoy** is
  Polygon's practice network, with free test POL. **Mainnet** is the real network.
- **Admin:** the owner's wallet that controls the settings. **Minter:** Virvi's server wallet that
  creates and sends BEATs.

**What it does:**
- The minter creates a BEAT once, and decides then whether it can be traded. That choice can never change.
- The minter sends a BEAT to a list of wallets, up to 200 at a time.
- The minter sends a given BEAT to a wallet **only once, ever**. A wallet is skipped if it's on the list
  twice, if the list is sent again, or if it already burned or traded its BEAT away. (If a BEAT is
  tradeable, a wallet can still get more of it from other holders.)
- A BEAT that isn't tradeable can't be moved to another wallet by anyone.
- **Only the holder can burn their own BEAT.** Nobody else can, not even a wallet or site the holder
  approved.
- A BEAT can be **closed** by the minter or the admin. A closed BEAT can never be minted again. BEATs
  already in wallets stay where they are.
- If a wallet in a list can't accept the token (some smart-contract wallets), it's skipped and the rest
  of the list still gets theirs. Virvi can send to that wallet again later.

**What the admin can do:**
- Change the web address where every BEAT's name and image are looked up, including BEATs already given
  out. **Names and images are not stored on the blockchain.** They come from Virvi's server, so how a BEAT
  looks can change. Who owns it can't.
- Add or remove minters, including making itself a minter. A minter added this way can create and send
  new BEATs.
- Hand the admin role to another wallet. This takes two steps: the admin starts the handover, and the new
  wallet accepts it **after a 1-day wait**. The admin can't simply give the role away or drop it by
  accident.

**What nobody can do:**
- Nobody, not the admin and not the minter, can move, burn or take back a BEAT that's in someone's wallet.
- There is no pause switch, no upgrade, and no way to delete the contract.
- It can't be paid and can't pay anyone out. Sending POL to it fails.

**Good to know:**
- The admin is a single wallet. Whoever holds its key can do everything listed above. If that key is lost,
  nobody can change the minter or the web address again.
- There's no limit on how many BEATs Virvi can create or send, and Virvi can send a BEAT to any wallet
  without asking. You can burn one you don't want.
- This contract has been checked with an automatic tool (Slither), which found nothing serious. That is
  **not** an audit: no independent auditor has reviewed it.

## Deploying (for the owner)

### Before you start you need

1. **Foundry**, the tool that deploys the contract. In Terminal run `brew install foundry`, then check it
   with `forge --version`.
2. **A deployer wallet's private key** (the secret that controls a wallet; never share it). Use a fresh
   wallet that only holds POL for fees. It gets no permissions in the contract.
3. **POL in the deployer wallet.** The deploy uses about 2.8 million gas, and the tool asks for about
   30% extra up front to be safe. Have about 0.2 test POL on Amoy (free from a faucet), and about 1.5 POL
   on mainnet (the real cost is usually under 1 POL, depending on the gas price that day). What isn't
   spent stays in the wallet.
4. **The minter address**: Virvi's server wallet.

   **One contract and one minter for each server.** Staging and production each get their own contract
   and their own minter wallet. Never share either between them, even on Amoy: each server numbers its
   BEATs from 1, so two servers on one contract would clash, and minting would stop.
5. For publishing the code on Polygonscan (below): a free **Etherscan API key** from etherscan.io (My
   Account, API Keys). It also works for Polygonscan.

### Where to run it

Open Terminal in the project's top folder (the one that contains the `contracts` folder). Each command
below starts with `cd contracts` for that reason. If you're already inside `contracts`, run `cd ..` first.

### Step 1: fill in the settings

Paste these lines, after replacing `PASTE_MINTER_ADDRESS_HERE` with the minter address. Keep the quotes.

```
export BEAT_ADMIN="0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220"
export BEAT_MINTER="PASTE_MINTER_ADDRESS_HERE"
```

- `BEAT_ADMIN` is the wallet that will control the contract's settings. It's filled in already. **Check
  every character.** A wrong admin address can't be fixed later.
- `BEAT_MINTER` must be a different wallet from the admin. The deploy stops if they're the same.

These settings last until you close the Terminal window.

### Step 2: Amoy (the practice network) first

Set the network settings for Amoy:

```
export BEAT_BASE_URI="https://api.virvi.io/api/beats/metadata/polygon-amoy/"
export EXPECTED_CHAIN_ID=80002
```

**Dry run.** This simulates the deploy and spends nothing:

```
cd contracts && forge script script/Deploy.s.sol --rpc-url https://polygon-amoy-bor-rpc.publicnode.com --interactives 1
```

**Real deploy.** The same command with `--broadcast` added:

```
cd contracts && forge script script/Deploy.s.sol --rpc-url https://polygon-amoy-bor-rpc.publicnode.com --broadcast --interactives 1
```

### What happens when you run it

1. Terminal asks for the deployer wallet's **private key**. Paste it and press Enter. **Nothing shows on
   screen as you paste. That's normal.** The key isn't saved in your history or in any file.
2. It checks the settings, then (with `--broadcast`) sends the deploy. Wait for it to finish, which takes
   up to a minute or two. Don't close the window.
3. Near the end you'll see `VirviBeat deployed at 0x...`, the chain id, the base address, the admin and
   the minter.

**Save these:** the contract address `0x...`, which network (Amoy or Polygon), the date, and the admin
and minter addresses. Virvi's server needs the contract address. The tool also writes a record to
`contracts/broadcast/Deploy.s.sol/<network number>/run-latest.json`. That folder isn't kept in git, so
keep your own copy.

### Step 3: publish the code on Polygonscan (Amoy)

Publishing ("verifying") lets anyone read the code behind the address. It costs nothing. Paste these
lines, after replacing the two placeholders:

```
export BEAT_ADDRESS="PASTE_DEPLOYED_ADDRESS_HERE"
export ETHERSCAN_API_KEY="PASTE_ETHERSCAN_KEY_HERE"
```

```
cd contracts && forge verify-contract "$BEAT_ADDRESS" src/VirviBeat.sol:VirviBeat --chain 80002 --constructor-args $(cast abi-encode "constructor(address,address,string)" "$BEAT_ADMIN" "$BEAT_MINTER" "$BEAT_BASE_URI") --watch
```

The Etherscan key ends up in your Terminal history. That's fine: it isn't a wallet key.

Then open `https://amoy.polygonscan.com/address/` followed by the contract address, and check that the
"Contract" tab shows a green tick.

### Step 4: Polygon mainnet

Only after Amoy has worked end to end. **Mainnet can't be undone and costs real POL.**

```
export BEAT_BASE_URI="https://api.virvi.io/api/beats/metadata/polygon/"
export EXPECTED_CHAIN_ID=137
```

Dry run first (spends nothing):

```
cd contracts && forge script script/Deploy.s.sol --rpc-url https://polygon-bor-rpc.publicnode.com --interactives 1
```

Then the real deploy, which also publishes the code on Polygonscan in the same step (it uses the
`ETHERSCAN_API_KEY` you set in step 3):

```
cd contracts && forge script script/Deploy.s.sol --rpc-url https://polygon-bor-rpc.publicnode.com --broadcast --interactives 1 --verify
```

Check it at `https://polygonscan.com/address/` followed by the contract address.

The `--rpc-url` is the address of a server that lets the tool talk to the network. Any Polygon RPC
provider's URL works in its place, as long as it's for the same network.

### If something goes wrong

- **"insufficient funds" or "Failed to estimate gas":** the deployer wallet has too little POL. Add POL
  and run it again. Nothing was spent.
- **`WrongChain`:** the `--rpc-url` points at a different network from `EXPECTED_CHAIN_ID`. Use the Amoy
  URL with `80002` and the `polygon-amoy` base, or the mainnet URL with `137` and the `polygon` base.
  Nothing was sent.
- **`AdminIsMinter`:** `BEAT_ADMIN` and `BEAT_MINTER` are the same. Nothing was sent.
- **"environment variable ... not found":** a setting from step 1 or 2 is missing (perhaps the Terminal
  window was closed). Paste the `export` lines again. Nothing was sent.
- **"transaction underpriced":** add `--priority-gas-price 30gwei` to the command and run it again.
- **The deploy worked but publishing the code failed:** **don't deploy again.** Run the step 3 command
  (with `--chain 137` for mainnet).
- **It timed out or says "rate limited":** wait a few minutes. Before running it again, check on
  Polygonscan that no contract was created from the deployer wallet, so you don't deploy twice.
- **A typo in the admin address can't be fixed.** If it happens, deploy a new contract with the right one
  and don't use the old one.

## For developers

The owner can skip this section.

**Build and test.** Install Foundry and Slither once (`brew install foundry slither-analyzer`), then:

```
cd contracts
forge build
forge test -vv
forge snapshot --check --no-match-test "testFuzz_"
forge lint
slither . --config-file slither.config.json
```

- Solc 0.8.28, EVM `cancun`. Dependencies are committed under `lib/` (OpenZeppelin Contracts `v5.4.0`,
  only its `contracts/` source, license and readme; forge-std `v1.9.7`), so nothing needs installing.
- `forge snapshot --no-match-test "testFuzz_"` rewrites `.gas-snapshot`; commit it when gas changes on purpose. Fuzz tests are left out because their gas differs between machines.
- CI (`.github/workflows/contracts.yml`) runs the same checks on every change under `contracts/`.

**Interfaces.** ERC-1155 with metadata URI, ERC-165, AccessControl with `AccessControlDefaultAdminRules`
(`owner()` is the admin, 1-day handover delay), ERC-6454 `isTransferable`, ERC-4906
`BatchMetadataUpdate` on a base change, and ERC-7572 `contractURI()` (`{base}contract.json`).
`createBeat` emits `URI(uri(id), id)`. `name()` is `Virvi BEAT` and `symbol()` is `BEAT`.
The admin can change the 1-day handover delay with `changeDefaultAdminDelay`. A decrease is scheduled
so that no handover can finish sooner than the current delay would allow (it waits current minus new);
an increase waits the new delay, at most 5 days.

**Recipients with code.** `mintTo` mints directly to addresses without code. An address with code (a
contract, or an EIP-7702 delegated wallet) is minted through `this.mintOneGuarded` with
`RECEIVER_GAS = 120_000`. If its receiver hook reverts or runs out of gas, `MintSkipped(id, to)` is
emitted, its `minted` flag stays unset, and the batch carries on. `mintTo` returns only the successes.
On that path the ERC-1155 `operator` (in `TransferSingle` and in `onERC1155Received`) is the contract
itself, not the minter. A Safe-style proxy uses about 77k of the 120k. If the transaction runs low on gas
(less than `RECEIVER_GAS * 64 / 63 + GUARD_RESERVE`, about 132k, left at that point), the whole call
reverts with `InsufficientGas` rather than skip a good receiver, so gas estimation always budgets the full
cap. A one-recipient mint to a contract wallet needs a gas limit of about 145k.

**Gas** (forge 1.9.0, measured in tests):
- Deploy: about 2.76M gas.
- `mintTo` with 200 new plain wallets: about 10.5M gas. At 30 gwei that's about 0.3 POL; at 280 gwei, about
  3 POL. A batch skipping bad receivers costs at most `RECEIVER_GAS` for each of them.
- `createBeat`: 60k to 81k. `closeBeat`: about 50k.

## Slither

Run with `slither . --config-file slither.config.json` from `contracts/` (Slither 0.11.6). The config
filters out `lib/`. CI fails on any medium or high finding.

Last run: 28 contracts, 102 detectors, **1 low finding, accepted**:

- **calls-loop** (low) in `mintTo`: `this.mintOneGuarded{gas: RECEIVER_GAS}(id, account)` is an external
  call inside the loop. This is deliberate. The call is to this contract itself, capped at
  `RECEIVER_GAS` and wrapped in `try`/`catch`, so a failing recipient is skipped instead of failing the
  batch (that isolation is the point of the call).

`forge lint` notes silenced inline, each with a reason in the code: `require-revert-in-loop` in `_update`
(any locked id must fail the whole transfer) and on the `InsufficientGas` check in `mintTo` (a starved
guarded mint must fail the whole call), `calls-loop` (as above), and `reentrancy-events` on the
`URI` emit in `createBeat` (it calls this contract's own `uri` view, not an external contract) and on
`MintSkipped` (it reports the outcome of the guarded call, so it must come after it).
