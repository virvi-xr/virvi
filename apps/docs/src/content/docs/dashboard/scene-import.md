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
