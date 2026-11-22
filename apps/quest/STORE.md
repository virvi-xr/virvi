# Virvi AR: Meta Horizon Store notes

Package `io.virvi.ar`, Quest 3 and 3S only (`com.oculus.supportedDevices`). Uploading to the Store is the owner's step, with their Meta developer account.

## 1. Release key (owner, in your own Terminal)

The key is made outside the repo and its passwords never go in the repo, a chat or a commit.

```bash
mkdir -p ~/.android
keytool -genkeypair -v -keystore ~/.android/vlm-quest-release.jks -alias vlm-quest -keyalg RSA -keysize 4096 -validity 10000
```

`keytool` asks for the keystore password and key password. Then add these four lines to `~/.gradle/gradle.properties` (not the repo's `gradle.properties`), with your own passwords:

```properties
VIRVI_QUEST_KEYSTORE=~/.android/vlm-quest-release.jks
VIRVI_QUEST_KEYSTORE_PASSWORD=<keystore password>
VIRVI_QUEST_KEY_ALIAS=vlm-quest
VIRVI_QUEST_KEY_PASSWORD=<key password>
```

Back the `.jks` file and both passwords up somewhere safe. A Store app can't be updated if the key is lost (unless Meta's key-reset applies).

Unless all four properties are set, the release build still assembles, unsigned, and Gradle prints a warning when a release task runs. An unsigned build can't be uploaded.

## 2. Build

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
cd apps/quest && ./gradlew :app:bundleRelease :app:assembleRelease
```

Outputs: `app/build/outputs/bundle/release/app-release.aab` and `app/build/outputs/apk/release/app-release.apk` (`app-release-unsigned.apk` when no key is set). Release builds allow no cleartext traffic (only `src/debug/AndroidManifest.xml` does) and minify is off (the Spatial SDK documents no keep rules).

Build record (2026-10-24, no key configured): see the task report; it built unsigned with the warning.

### Fingerprint for app links

With a signed APK:

```bash
$ANDROID_HOME/build-tools/34.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

Copy the `Signer #1 certificate SHA-256 digest` line, and the server accepts it with or without colons, in any case, and writes it as `AA:BB:...` in `assetlinks.json` (an entry that isn't 64 hex digits is dropped with a warning that names its position, not its value). Set it in the server environment as `ANDROID_CERT_SHA256` (comma-separated for several keys; plan 1 Task 12; `apps/server/src/config.ts`). Until it's set, `https://virvi.io/s/<code>` links don't verify and open in the browser. If Meta re-signs the app on upload (Play-style app signing doesn't apply to Horizon; check the Developer Dashboard), add that certificate's fingerprint too.

## 3. VRC checklist (owner)

From Meta's published list, https://developers.meta.com/horizon/distribute/publish-quest-req/ (checked 2026-10-24). Meta Quest Developer Hub wasn't available here, so none of this is run yet. Run MQDH's pre-submission checks and tick these on a headset. Required items are marked R, recommended ones r.

**Packaging**
- [ ] R Packaging.1 Manifest meets release requirements (check in the Developer Dashboard upload).
- [ ] R Packaging.2 APK signed with signature scheme v2 (`apksigner verify -v` shows v2 true).
- [ ] R Packaging.3 No unsupported Android features required (the manifest requires only head tracking and passthrough, both Quest features).
- [ ] R Packaging.4 Supported SDK and engine version (Spatial SDK, Horizon OS SDK 69, API 34).
- [ ] R Packaging.5 and .6 Under 1 GB; 64-bit.

**Functional**
- [ ] R Functional.1 Installs and runs without crashes or freezes, including leaving a space, taking the headset off and on, and builder mode.
- [ ] R Functional.3 Never stuck: Close on the space page, Look at the ARC again, and Done in builder mode all work.
- [ ] R Functional.4 No lost user data: unsaved builder drafts survive a short break (10 minutes).
- [ ] R Functional.5 Positional tracking responds.
- [ ] R Functional.12 Works for several users on the headset.
- [ ] R Functional.14 Launches in passthrough: passthrough loading screen, opens from MR Home in passthrough.
- [ ] r Functional.7 Offline: the app tells the user when it needs the internet.
- [ ] r Functional.10 Avoid headlocked UI (hint card and menus are world or wrist placed).

**Security and permissions**
- [ ] R Security.2 Minimum permissions. Requested: `INTERNET`, `CAMERA` and `HEADSET_CAMERA` (read the passthrough camera to find ARCs), `USE_SCENE` and `USE_ANCHOR_API` (room geometry for occlusion and snapping), `HAND_TRACKING`, `RENDER_MODEL` (controller models). Confirm each is used; remove any that isn't. Rationale wording is in `res/values/strings.xml`.
- [x] r Security.1 Platform entitlement check within 10 s of launch: decided not to add it. The app is free and the check is only recommended.

**Performance**
- [ ] R Performance.1 Runs at the declared refresh rate with the scene, occlusion and ARC detection on.
- [ ] R Performance.3 Head-tracked graphics within 4 s of launch.
- [ ] r Performance.4 Render scaling 85% or higher.

**Input**
- [ ] R Input.4 Focus-aware: with the system menu up, the app keeps rendering, hides hands and controllers and ignores input.
- [ ] R Input.7 Switching between hands and controllers works, also while carrying an item in builder mode.
- [ ] R Input.8 The system gesture triggers nothing else.
- [ ] r Input.1 In-game menu opens with the left controller menu button.
- [ ] r Input.2 Grip for pickup.

**Privacy**
- [ ] R Privacy.1 to .4 Privacy policy URL is https://virvi.io/privacy (section "Virvi AR on Quest"); it explains what is collected and how it is used. Privacy.4 asks how users request deletion: the page says visit events carry no identity, a builder revokes a headset on virvi.io, and anyone can email support@virvi.io to ask for their data to be deleted or for help.
- [ ] R Privacy.5 Data protection checks (Developer Dashboard, Data use; answers below).

**Content and publishing**
- [ ] R Content.2 Metadata matches the app.
- [ ] R Content.3 User-generated content needs a way to report Code of Conduct violations. Spaces are made by their owners on virvi.io, and visitors see only published spaces, but visitors can see owner-chosen media. Built the report route anyway: the menu has **Report this space** (Offensive, Unsafe, Spam, Something else); reports land on the virvi.io admin page ("Space reports") and are emailed to support@virvi.io once the server has SMTP set (until then the admin page is the only place they show).
- [ ] R Publishing.1 to .3 Website URL (https://virvi.io), support link, terms URL (if given) all load.
- [ ] R Publishing.4 to .8 Name, descriptions and keywords meet content guidelines; Meta brand use follows the brand guidelines ("Meta Quest", not "Oculus"; no other headsets named).
- [ ] R Asset.1, .2, .5, .6, .7 Logo transparent; cover art branded with no extra text; screenshots free of overlays; no other platforms' hardware in text or images; trailer 2 minutes or less.

**Accessibility (recommended)**: playable without audio, legible text, one-handed use, fixed-position interaction. Not reviewed yet.

## 4. Store listing

**Name:** Virvi AR

**Short description:** See a Virvi scene in a real room. Look at an ARC and the space lines up around you.

**Long description:**

Virvi AR shows a Virvi scene life-size in your real surroundings, in passthrough on Meta Quest 3 and 3S.

Walk into a place that has a space, look at its ARC (Augmented Reality Code) at eye level near the entrance, and the scene appears lined up with the room. Virtual things hide behind real walls and furniture. There's nothing to sign in to and nothing to set up.

If something moves your headset's tracking, the scene fades out rather than show up in the wrong place, and the app asks you to look at an ARC again.

For owners and editors: sign in once by approving a pairing code on virvi.io, then move things around and place items from your asset library while standing in the room. Your changes are the same ones you'd make in Decentraland, so they show there too.

Camera images and room scans never leave the headset. See the privacy policy at virvi.io/privacy.

Needs a Meta Quest 3 or 3S and an internet connection.

**Keywords (suggested):** mixed reality, passthrough, AR, spaces, venues, events, Virvi.

**Category (suggested):** Entertainment or Productivity (owner's choice in the dashboard).

### Age rating answers (Meta's questionnaire; owner confirms in the dashboard)

- Violence, sexual content, nudity, profanity, drugs, gambling, horror: none made by the app. A space's content is whatever its owner publishes; the app has none of its own.
- User-to-user communication: none (no chat, voice or avatars of other visitors).
- User-generated content: spaces authored by owners on virvi.io and shown to visitors. Answer "yes" if the questionnaire counts owner-published scenes.
- Real-money purchases and ads: none in the app.
- Location: none (the Quest has no GPS; the app doesn't ask for location).
- Expected rating: all ages as far as the app goes, subject to the UGC answer.

### Data use answers (Developer Dashboard, Data use)

Based on `docs/superpowers/specs/2026-10-22-ar-builder-and-visitor-modes-design.md`, `2026-10-22-ring-marker-design.md` and the code (`api/ArApi.kt`, `builder/BuilderApi.kt`, `api/VisitAnalytics.kt`).

- **Collected from every user:**
  - ARC code, to look up the space (`GET /api/ar/markers/by-code/:code`).
  - Space contents (`GET /api/ar/spaces/:id/feed`).
  - Anonymous visit events: arrive, leave and head position in scene coordinates, at most one every 5 s (`POST /api/ar/spaces/:id/analytics`). A fresh random id per visit, never stored. Not linked to the user, no token sent. Purpose: analytics for the space's owner.
  - A report, only if the visitor sends one from the menu (`POST /api/ar/spaces/:id/report`): the space, the chosen reason, the app name (`ar-quest`) and the time. Nothing that identifies the visitor is sent or stored (the network address only limits repeated reports and is not kept). Purpose: content moderation.
- **Collected from builders only:** pairing (`/api/ar/pair...`, the headset model as the device name, and a SHA-256 hash of the device secret; the headset proves who it is with a secret kept in its encrypted storage, sent over HTTPS to the pairing, pass and spaces calls, and the server stores only a hash of it), edits to the scene, ARC alignments, and draft previews.
- **Not collected:** camera images, room scans or room geometry, microphone, location, contacts, name, email, Meta account id, advertising id.
- **Camera and spatial data** are processed on the headset only: ARCs are found from the passthrough camera, and walls and surfaces are used for occlusion and snapping.
- **Media hosts:** Pictures, videos and 3D models in a space load from wherever its owner hosts them, which may be outside virvi.io; those hosts see the headset's network address like any website would. The app sends them no account, token or visit data.
- **Shared with third parties:** no user data. The media hosts above get the headset's network address with each request, as any website does.
- **Encrypted in transit:** yes (release builds have no cleartext).
- **Deletion:** visit events carry no identity; builders can revoke a paired headset on virvi.io.
