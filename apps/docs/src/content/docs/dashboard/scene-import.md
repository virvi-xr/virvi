---
title: Scene Import
description: Bring a Decentraland scene into Virvi and deploy it to a World or to Genesis City parcels.
---

Scene Import takes a Decentraland scene you built elsewhere (the Creator Hub or the SDK7) and deploys it from Virvi, so Virvi's ads, analytics and live controls can run in it.

## Upload your scene
Upload the scene's project folder from the Creator Hub or an SDK7 project. Virvi builds it in an isolated environment and reads `scene.json` to find where it goes.

## Worlds and Genesis City
What `scene.json` says decides the destination:

- **Worlds:** a scene with a World name deploys to that World.
- **Genesis City:** a scene with parcels deploys to those parcels.

## Who can sign for parcels
Deploying to parcels is signed with a wallet that can deploy to every parcel in the scene. Any verified wallet on your account that is, for each parcel, one of these will do:

- the owner
- the operator
- the update operator
- an update manager
- a wallet the owner approved for all of their land

Estate parcels count through the estate's owner and operators. If no single wallet covers every parcel, split the scene or sign with the wallet that does.

## Make Virvi an operator (optional)
By default you sign each deploy in your browser. If you would rather let Virvi deploy for you, you can make Virvi an operator on your parcels.

- It is an Ethereum mainnet transaction, so it costs gas, once.
- You can undo it with a second transaction, from the same page.
- It replaces an existing update operator on those parcels.
- Estate parcels are granted per parcel, not estate-wide.

After the transaction confirms, press **Check again** and Virvi starts deploying for you. If you left before it confirmed, come back to the deploy page and press **Let Virvi deploy**: that step is free, with no transaction.

To sign each deploy yourself again, press **Sign each deploy myself**. That is free too, and Virvi stays an operator on-chain until you remove it with **Remove Virvi as operator** (a second transaction).

Only the parcels' owner, operator or a wallet approved for all their land can send these transactions. An update operator can still press **Let Virvi deploy** once the owner has made Virvi an operator.

## Aetheria parcels
Aetheria parcels are managed by their deed. Sign with the deed holder's wallet. The operator option is not offered for them.

## Download what went live
After a deploy, use **Download what went live** to get the exact files that were deployed.

## Your backup without Virvi
Use **Download backup (no Virvi)** to get your scene as a Decentraland project that runs on its own. The button sits beside **Download what went live** on the Import page and on the deploy cards. It is on every plan, and it works for imported scenes (your scene plus the baked content) and for scenes built in Virvi (the baked content alone).

**What is in it**
- Only the live preset, as it is now.
- Models, images, video screens, sounds and ad spaces. Ad spaces come as empty slots at the ad's shape (with the space's own fallback image, if it has one), never the current advertiser's creative.
- A `README.md`, an `ATTRIBUTION.md` and a `MISSING-ASSETS.md`.

**Bundled, referenced or linked**
- Bundled: files you uploaded and catalog items under the MIT license are in the project, and `ATTRIBUTION.md` credits each MIT pack.
- Referenced: items under licenses that don't allow bundling (such as CC BY-NC) are not included. The project points at the local path each file would have, and `MISSING-ASSETS.md` lists where to get each one. Add the files there before you build.
- Links: live streams stay as a link, and the README says how they behave.

Click events (for example a button that opens a link or plays a sound) are not baked in. A sound clip does not start by itself.

**Size limit.** A backup can be at most 500 MB. If yours is bigger, Virvi names the largest files so you can shrink or remove them.

**Deploy it yourself**
1. Unzip the project and add any files listed in `MISSING-ASSETS.md`.
2. Run `npm install`, then `npx @dcl/sdk-commands build`.
3. Test with `npx @dcl/sdk-commands start`, then deploy with `npx @dcl/sdk-commands deploy` using the wallet that owns your World or parcels.
