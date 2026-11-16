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
- **Admin:** the owner's wallet that controls the settings. On mainnet it's a **Safe multisig** (a shared
  wallet where 2 of its 3 signers must approve each action). **Minter:** Virvi's server wallet that
  creates and sends BEATs.
- **Reissuer:** a permission to give a wallet a fresh copy of a BEAT in place of another wallet's (see
  below). It's meant for compromised wallets, but works on any wallet. An address gets it when it becomes
  admin and loses it when it stops being admin. The admin can also drop it while staying admin, or give it
  to other addresses, which keep it until the admin takes it back (forever, if the admin role was renounced). The minter isn't given it at deploy.

**What it does:**
- The minter creates a BEAT once, and decides then whether it can be traded. That choice can never change.
- The minter sends a BEAT to a list of wallets, up to 200 at a time.
- The minter sends a given BEAT to a wallet **only once, ever**. A wallet is skipped if it's on the list
  twice, if the list is sent again, or if it already burned or traded its BEAT away. (If a BEAT is
  tradeable, a wallet can still get more of it from other holders.)
- A BEAT that isn't tradeable can't be moved to another wallet by anyone.
- **Only the holder can burn their own BEAT.** Nobody else can, not even a wallet or site the holder
  approved.
- A BEAT can be **closed** by the minter or the admin. A closed BEAT can never be minted again, except by
  a reissue (below). BEATs already in wallets stay where they are.
- If a wallet in a list can't accept the token (some smart-contract wallets), it's skipped and the rest
  of the list still gets theirs. Virvi can send to that wallet again later.

**What the admin can do:**
- Change the web address where every BEAT's name and image are looked up, including BEATs already given
  out. **Names and images are not stored on the blockchain.** They come from Virvi's server, so how a BEAT
  looks can change. Who owns it can't.
- Add or remove minters, including making itself a minter. A minter added this way can create and send
  new BEATs.
- **Reissue a BEAT to a new wallet.** It's meant for this: someone's wallet is compromised, Virvi support
  checks it's really them, and then the reissuer (the admin) can:
  - give their new wallet a fresh copy of a BEAT their old wallet was minted, **even after the BEAT is
    closed**;
  - which marks the old wallet **replaced** for that BEAT: any copy of it in the old wallet, now or later,
    can never move to another wallet again, even if the BEAT is tradeable. Only its holder can still burn
    it.

  The contract doesn't know whether a wallet was really compromised. **A reissuer can do this to any
  wallet that was ever minted a BEAT**, sending the fresh copy to any wallet it chooses: it can freeze an
  innocent holder's tradeable copy so they can never sell it, and it can hand out extra copies of closed
  BEATs, with no upper limit (by chaining reissues from wallet to wallet). That's why, on this shared contract, the reissuer role must stay on the admin
  Safe and **never be given to a server or support hot key**.

  Limits:
  - It works only once for each old wallet and BEAT.
  - It works only to a wallet that was never **minted** that BEAT. A wallet that bought a copy can still
    get a reissued one and end up with two.
  - For a **tradeable** BEAT, the old wallet must still hold a copy. If the copy was sold, sent away or
    burned first (for example by a thief racing the reissue), the reissue fails, so there are never two
    tradeable copies where there was one. A **non-tradeable** BEAT can't have moved, so it can be reissued
    even if its holder burned it.

  The old copy itself isn't moved or burned: it stays in the old wallet, marked replaced, and **wallets and
  explorers still show it**. Anyone can look this up with `replacedBy(id, oldWallet)`.
- Add or remove reissuers, including removing the permission from itself.
- Hand the admin role to another wallet. This takes two steps: the admin starts the handover, and the new
  wallet accepts it **after a 1-day wait**. The admin can't simply give the role away or drop it by
  accident.

**What nobody can do:**
- Nobody, not the admin, a reissuer or the minter, can move, burn or take back a BEAT that's in someone's
  wallet. A reissue gives out a new copy; it doesn't touch the old one except to stop it moving to another
  wallet.
- There is no pause switch, no upgrade, and no way to delete the contract.
- It can't be paid and can't pay anyone out. Sending POL to it fails.

**Good to know:**
- The admin is one address. On mainnet it's meant to be a Safe multisig, so no single key can act alone.
  Whoever controls it can do everything listed above. If it's lost for good, nobody can change the minter,
  the reissuers or the web address again, and any reissuer it had given the role to keeps it forever.
  Replacing a lost or compromised Safe signer happens inside the Safe (its owners swap the signer there);
  the contract doesn't change.
- **If the minter's key leaks,** the admin can revoke the old minter and grant a new one, and do the same
  for reissuers, at once (no wait). Only the admin role itself takes the 1-day handover.
- **If the admin is handed to a new address,** the reissuer permission moves with it: the new admin gets
  it when it accepts, and the old admin loses it. If the admin role is renounced, the old admin loses it
  too. Anyone else the admin gave the reissuer role to keeps it until the admin takes it back, or forever if the admin role was renounced.
- **When reissuing a mix of BEATs,** send the non-tradeable ones in one reissue and each tradeable one in its own. Otherwise a thief who still has the old key can move one tradeable copy out and make the whole reissue fail. Nothing gets duplicated, but you'd have to sign again.
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
3. **POL in the deployer wallet.** The deploy uses about 3.2 million gas, and the tool asks for about
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

### Release order for the consent change (`@virvixr/dcl` 2.17.0)

This version changes the text visitors agree to before tracking a BEAT (consent version 2), and the server
refuses tracking from scenes that still show the old text. Release it in this order:

1. Publish `@virvixr/dcl` 2.17.0 to npm. Until it's published, importing a scene that installs Virvi fails,
   because the importer asks for `^2.17.0`.
2. Deploy the server.
3. Redeploy every scene that runs BEATs (including the Amoy test scene) on 2.17.0. Until a scene is
   redeployed, its visitors can't track: an old scene says "This BEAT's terms have changed. Reload the scene
   and try again.", and reloading doesn't help.

### Step 1: fill in the settings

Paste these lines, after replacing `PASTE_MINTER_ADDRESS_HERE` with the minter address. Keep the quotes.

```
export BEAT_ADMIN="0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220"
export BEAT_MINTER="PASTE_MINTER_ADDRESS_HERE"
```

- `BEAT_ADMIN` is the wallet that will control the contract's settings and do reissues. It's filled in
  already for Amoy. **For mainnet, set it to the Safe multisig's address** (step 4, part 5). **Check every
  character.** A wrong admin address can't be fixed later. A Safe (or any contract) works as the admin;
  the deploy checks that it got the admin and reissuer permissions and the minter didn't.
- On Amoy an ordinary wallet is allowed as the admin; the deploy prints a warning. On mainnet the deploy
  stops unless the admin is a Safe on Polygon that needs at least 2 signers. It prints the Safe's
  threshold and owners: check them in the dry run.
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

**Tell the server (Amoy).** Claude gives you the exact `! railway variables` lines. They set
`BEAT_CONTRACT_POLYGON_AMOY` to the contract address, and `BEAT_CONTRACT_COMMIT_POLYGON_AMOY` to the commit
it was deployed from (the Transparency page links to the code at it), which this prints:

```
git rev-parse HEAD
```

**Replacing a contract on the same network.** A server uses one contract per network. Each BEAT records
the contract it was created on, so when `BEAT_CONTRACT_POLYGON_AMOY` changes, BEATs on the old contract
are retired: their pages and token details stay up, but Virvi never sends, closes or retries them again,
and no alert is raised for them. A retired BEAT can't be reissued either: the reissue page shows it as
"Unavailable on this chain". Token numbers carry on from where they were, so the first BEAT on the new
contract isn't number 1. That's fine.

### Rehearsing a reissue on Amoy (plain-wallet admin)

The Safe app has no Amoy, so on Amoy the admin is a plain wallet (`0x7BC6…9220`), and you send the reissue
yourself instead of through Transaction Builder. You need a request that has been approved, with at least
one BEAT whose event has ended.

1. In `/admin/beats/reissue`, open the request and press **Prepare Safe files** under **Polygon Amoy**. Press
   **Download** for each file. Each file has one transaction: open it in a text editor and find
   `contractInputsValues`. It holds `from`, `to` and `ids`.
2. In Terminal, paste these, after replacing each placeholder with the value from the file. Keep the quotes.
   The ids keep their square brackets, for example `"[3,4]"`:

   ```
   export BEAT_ADDRESS="PASTE_AMOY_CONTRACT_ADDRESS_HERE"
   export REISSUE_FROM="PASTE_FROM_WALLET_FROM_THE_FILE_HERE"
   export REISSUE_TO="PASTE_TO_WALLET_FROM_THE_FILE_HERE"
   export REISSUE_IDS="PASTE_IDS_FROM_THE_FILE_HERE"
   ```
3. Send it from the admin wallet. Terminal asks for the admin wallet's **private key** (nothing shows as you
   paste):

   ```
   cast send "$BEAT_ADDRESS" "reissue(address,address,uint256[])" "$REISSUE_FROM" "$REISSUE_TO" "$REISSUE_IDS" --rpc-url https://polygon-amoy-bor-rpc.publicnode.com --interactive
   ```

   With more than one file, do steps 2 and 3 for each, in order: the non-tradeable file first.
4. Wait a minute or two, then reload the request in `/admin/beats/reissue`. Each file shows **Done**, the
   request shows **Done**, and the person's BEATs list the new wallet.

### Step 4: Polygon mainnet (the owner's runbook)

Only after Amoy has worked end to end. **Mainnet can't be undone and costs real POL.** Do these steps in
order, and don't skip one. Claude can walk you through any of them.

> **Safety first.**
> - **Send POL only on the Polygon network, never on Ethereum.** In your wallet or exchange the network
>   must say "Polygon" (sometimes "Polygon PoS" or "MATIC"). POL sent on Ethereum to these addresses is
>   lost or stuck.
> - **Never paste a private key into a chat, an email or a file.** Only into Terminal when it asks.
> - **Check every character of every address** before you press Enter. A wrong admin can't be fixed.

**What it costs** (fees read on 2026-11-15: about 280 gwei, with POL at about $0.08; fees and the price
move every day):
- The deploy: about 3 million gas, usually under 1 POL. Have about 1.5 POL in the deployer.
- Putting a BEAT on chain: about 0.02 POL. Closing it: about 0.01 POL.
- Sending a BEAT: about 0.015 POL each in a full batch, about 0.025 POL when they trickle in one at a time.
- A fully claimed BEAT of 100: about 1.5 POL in all (about $0.12). Hosts pay $5 for it.
- The minter must hold more than it spends: a full batch of 100 sets aside about 10 to 20 POL before it's
  sent, and minting pauses whenever the balance drops under 10 POL (`BEAT_MIN_GAS_POL_POLYGON`). Batches shrink to
  fit the balance, so a smaller top-up still lets minting carry on.

1. **Create the Safe.** In [app.safe.global](https://app.safe.global), create a Safe on **Polygon** with
   these three signers, and a threshold of **2** (any 2 of the 3 must approve):
   - `0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220`
   - `0x01d871870CbBddE934526E17637c0cfEf0b3b38B`
   - `0x2319A029D05e52043f077c0684e3C0BF6d1c3dbB`

   Write down the Safe's address. Check the network shows Polygon, not Ethereum.
2. **Practise once.** Before anything depends on the Safe:
   - send a harmless transaction from it (for example 0 POL to one of the signers) and get two signers
     to approve and execute it;
   - open **Apps → Transaction Builder**, import any small file (Virvi's reissue page makes one), press
     **Simulate**, and check it would succeed. You don't need to send it.
3. **Make the mainnet minter wallet.** Create a **new** wallet for the server's minter. **Never reuse the
   Amoy minter.** Keep its private key safe: it goes into the server settings in step 9 and nowhere else.
   Fund it with **at least 20 POL**. Minting pauses whenever the balance drops under 10 POL, so with only
   10 the test BEAT in step 11 would pause minting before its claim is sent (see the costs above):
   - **To buy POL:** on an exchange (Coinbase, Kraken, Binance and others), buy POL, then withdraw it to
     the minter's address and pick **Polygon** as the network.
   - **If you already have POL or ETH on Ethereum:** bridge it at
     [portal.polygon.technology](https://portal.polygon.technology) to Polygon first, then send it.
   - **Never pick Ethereum as the network** when you send.
4. **Fund a deployer.** A fresh wallet with about **1.5 POL** on Polygon, sent the same way. It gets no
   permissions in the contract; what it doesn't spend stays in it.
5. **Set the deploy settings.** In a new Terminal window (settings from earlier windows are gone), paste
   these, after replacing the two placeholders. Keep the quotes:

   ```
   export BEAT_ADMIN="PASTE_SAFE_ADDRESS_HERE"
   export BEAT_MINTER="PASTE_NEW_MAINNET_MINTER_ADDRESS_HERE"
   export BEAT_BASE_URI="https://api.virvi.io/api/beats/metadata/polygon/"
   export EXPECTED_CHAIN_ID=137
   unset BEAT_ADDRESS
   ```

   `BEAT_ADMIN` is the Safe from step 1, `BEAT_MINTER` the new minter from step 3. `unset BEAT_ADDRESS`
   clears the Amoy contract's address so nothing below can use it by mistake.
6. **Dry run** (spends nothing):

   ```
   cd contracts && forge script script/Deploy.s.sol --rpc-url https://polygon-bor-rpc.publicnode.com --interactives 1
   ```

   It prints the Safe's owners and threshold. **Check they are the three signers from step 1 and a
   threshold of 2.** If not, stop.
7. **Deploy for real:**

   ```
   cd contracts && forge script script/Deploy.s.sol --rpc-url https://polygon-bor-rpc.publicnode.com --broadcast --interactives 1
   ```

   Save the contract address it prints (`VirviBeat deployed at 0x...`) and the commit it was deployed
   from, which this prints:

   ```
   git rev-parse HEAD
   ```
8. **Publish the code** on Polygonscan and Sourcify. Set the **new** contract's address (never the Amoy
   one) and your Etherscan key:

   ```
   export BEAT_ADDRESS="PASTE_MAINNET_CONTRACT_ADDRESS_HERE"
   export ETHERSCAN_API_KEY="PASTE_ETHERSCAN_KEY_HERE"
   ```

   ```
   cd contracts && forge verify-contract "$BEAT_ADDRESS" src/VirviBeat.sol:VirviBeat --chain 137 --constructor-args $(cast abi-encode "constructor(address,address,string)" "$BEAT_ADMIN" "$BEAT_MINTER" "$BEAT_BASE_URI") --watch
   forge verify-contract "$BEAT_ADDRESS" src/VirviBeat.sol:VirviBeat --chain 137 --verifier sourcify
   ```

   (The first line moves into `contracts`; the second runs there. If you're already inside `contracts`,
   leave out the `cd contracts && `.) Then open
   `https://polygonscan.com/address/` followed by the address, and check the "Contract" tab shows a green
   tick.
9. **Tell the server.** Claude gives you the exact `! railway variables` lines to paste, filled in. They
   set these on the production server (`virvi-server`):
   - `BEAT_CHAIN=polygon`: BEATs move to mainnet. From then on any host can create and pay for BEATs,
     and Amoy BEATs become admin-only.
   - `BEAT_CONTRACT_POLYGON`: the contract address from step 7.
   - `BEAT_CONTRACT_COMMIT_POLYGON`: the commit from step 7 (the Transparency page links to the code at
     it).
   - `BEAT_MINTER_KEY`: the new minter's private key from step 3. **It replaces the Amoy minter's key, so
     Amoy minting stops.** Finish or close any Amoy test BEATs first.
   - `BEAT_ADMIN_SAFE_POLYGON`: the Safe's address from step 1. The reissue files name it, so Transaction
     Builder can warn when a file was made for another Safe. Paste only the `0x…` part: the Safe app copies
     it with `matic:` in front (Virvi ignores that prefix, but the address alone is clearer).
   - `BEAT_MIN_GAS_POL_POLYGON` (optional): when minting pauses for low POL on Polygon. Leave it unset for
     the default, 10.
   - `BEAT_NETWORK_HASH_SECRET`: a new random secret of at least 32 characters (`openssl rand -hex 32`
     makes one). It keys the per-network claim counts.

   **Don't set `BEAT_MIN_GAS_POL` or `BEAT_MAX_FEE_GWEI`** (without a network at the end), and if Amoy
   testing left either set on `virvi-server`, remove it: each applies to both networks, so an Amoy floor of
   0.1 or 1 POL would also apply on Polygon. Use the per-network ones instead (`..._POLYGON` and
   `..._POLYGON_AMOY`), which win over them.

   Also worth setting: `BEAT_MAX_FEE_GWEI_POLYGON` (optional; the default ceiling, 1000 gwei on Polygon,
   pauses minting while fees are higher), and `POLYGON_RPC_URL` to a paid Polygon RPC (Alchemy, QuickNode or
   Infura), because the free default limits how often it can be used; choose one without a low transaction
   fee cap. Keep `BEAT_CONTRACT_POLYGON_AMOY` set: Amoy reissues still finish, and Amoy BEATs stay readable.
   After the redeploy, expect one "BEAT polygon-amoy is misconfigured" alert (the new minter has no role on
   the Amoy contract, so Amoy minting stays paused). Dismiss it.
10. **Redeploy** the server. Then open `/admin/beats`: the Polygon card should show the new minter, its
    balance and **Minting**, with nothing missing and no pause.
11. **Test one BEAT end to end** before telling anyone:
    - create a BEAT with a small supply that starts soon, and pay with a real card (check it in Stripe);
    - claim it from your own wallet in the scene;
    - check it shows **Delivered**, and that the transaction and the token show on Polygonscan and in
      your wallet;
    - open `https://api.virvi.io/api/beats/metadata/polygon/1.json` and check it shows your BEAT.
12. **Keep the hardware wallet and the paper backup offline.** The Safe's signer keys are what control the
    contract. Store the hardware wallet and its paper recovery words apart, somewhere safe and offline.
    Never type the recovery words into a computer or a phone.

**Every day afterwards:** look at `/admin/beats` for the minter's balance and any pause, and top up the
minter (on Polygon) before it nears 10 POL.

**Reissues on mainnet** go through the Safe: Virvi's reissue page makes one Transaction Builder file per
Safe transaction. A request with both kinds of BEAT gets separate files, the non-tradeable ones together
and each tradeable one on its own; the page does this for you. Send the non-tradeable file first, and if a
tradeable file fails, reject its Safe transaction before sending the next.

The `--rpc-url` is the address of a server that lets the tool talk to the network. Any Polygon RPC
provider's URL works in its place, as long as it's for the same network.

### If something goes wrong

- **"insufficient funds" or "Failed to estimate gas":** the deployer wallet has too little POL. Add POL
  and run it again. Nothing was spent.
- **`WrongChain`:** the `--rpc-url` points at a different network from `EXPECTED_CHAIN_ID`. Use the Amoy
  URL with `80002` and the `polygon-amoy` base, or the mainnet URL with `137` and the `polygon` base.
  Nothing was sent.
- **`AdminIsMinter`:** `BEAT_ADMIN` and `BEAT_MINTER` are the same. Nothing was sent.
- **`WrongBaseURI`:** `BEAT_BASE_URI` doesn't end in `/polygon/` on mainnet (or `/polygon-amoy/` on Amoy).
  Paste the `export BEAT_BASE_URI=...` line for that network again. Nothing was sent.
- **`AdminNotAContract`, `AdminNotASafe` or `SafeThresholdTooLow` (mainnet only):** `BEAT_ADMIN` isn't a
  Safe on Polygon mainnet, or the Safe needs fewer than 2 signers. Check you set `BEAT_ADMIN` to the Safe in
  step 4, part 5, and that the Safe exists on Polygon (a Safe on another network has a different address or none
  here). Nothing was sent.
- **"environment variable ... not found":** a setting from step 1 or 2 is missing (perhaps the Terminal
  window was closed). Paste the `export` lines again. Nothing was sent.
- **"transaction underpriced":** add `--priority-gas-price 30gwei` to the command and run it again.
- **The deploy worked but publishing the code failed:** **don't deploy again.** On Amoy, run the step 3
  command again. On mainnet, set `BEAT_ADDRESS` to the **mainnet** contract address, then run the
  commands in step 4, part 8.
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
- Deploy: about 3.15M gas.
- `mintTo` with 200 new plain wallets: about 10.5M gas. At 30 gwei that's about 0.3 POL; at 280 gwei, about
  3 POL. A batch skipping bad receivers costs at most `RECEIVER_GAS` for each of them.
- `createBeat`: 60k to 81k. `closeBeat`: about 50k.
- `reissue` to a plain wallet: about 119k for 1 id, 872k for 10, 4.22M for 50 and 16.5M for 200 (about
  83k per extra id).

**Reissue.** `reissue(from, to, ids)` needs `REISSUER_ROLE`. Its role admin is `DEFAULT_ADMIN_ROLE`, and
`_grantRole`/`_revokeRole` tie it to the admin seat: granting `DEFAULT_ADMIN_ROLE` (at deploy or on
`acceptDefaultAdminTransfer`) grants `REISSUER_ROLE` to the same account, and revoking or renouncing
`DEFAULT_ADMIN_ROLE` revokes that account's `REISSUER_ROLE`. Other holders keep the role until the admin
revokes it. For a tradeable id, `from` must still hold a copy, or it reverts with `NothingToReplace(id,
from)`. It checks and records every id first (`minted[id][to]`, `++mintedCount`, `replacedBy[id][from] =
to`, `Reissued(id, from, to)`), then mints them all to `to` in one checked `_mintBatch` (one transfer log:
`TransferSingle` for one id, `TransferBatch` for more; one receiver hook), so a recipient that rejects the
tokens reverts the whole call. It ignores `closed`. `mintedCount` counts the
new wallet too, so it stays equal to the number of addresses with `minted` set; subtract `Reissued` events
to count people. In `_update`, any move out of `from` of an id where `replacedBy[id][from] != 0` reverts
with `ReplacedCopy` (burns pass), and `isTransferable` returns false for it.

## Slither

Run with `slither . --config-file slither.config.json` from `contracts/` (Slither 0.11.6). The config
filters out `lib/`. CI fails on any medium or high finding.

Last run: 28 contracts, 102 detectors, **1 low finding, accepted**:

- **calls-loop** (low) in `mintTo`: `this.mintOneGuarded{gas: RECEIVER_GAS}(id, account)` is an external
  call inside the loop. This is deliberate. The call is to this contract itself, capped at
  `RECEIVER_GAS` and wrapped in `try`/`catch`, so a failing recipient is skipped instead of failing the
  batch (that isolation is the point of the call).

`forge lint` notes silenced inline, each with a reason in the code: `require-revert-in-loop` in `_update`
(any locked or replaced id must fail the whole transfer) and in `reissue` (any bad id must fail the whole
reissue) and on the `InsufficientGas` check in `mintTo` (a starved
guarded mint must fail the whole call), `calls-loop` (as above), and `reentrancy-events` on the
`URI` emit in `createBeat` (it calls this contract's own `uri` view, not an external contract) and on
`MintSkipped` (it reports the outcome of the guarded call, so it must come after it).
