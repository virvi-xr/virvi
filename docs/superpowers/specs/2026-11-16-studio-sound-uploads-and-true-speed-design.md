# Studio: sound uploads, and On avatar at the emote's real speed

Two small Design Studio changes, shipped together.

## 1. Upload your own sound for an emote

**Why.** A creator (Fancy) wanted a fart sound on an emote, found the agent's synthesised sounds not realistic enough,
and wanted to upload their own recording. More generally: a player brings a sound effect or track, and either it becomes
the emote's sound or it guides the design (timing a move to it).

**How it works today.** Uploads (`apps/server/src/studio/uploads.ts`) accept images and 3D models only, sniffed by
contents, 12 per design. Every prompt job lists them and the worker fetches them into the agent's `uploads/`. The agent is
told to make any emote sound itself, "never a sample you found" (`apps/studio-worker/studio_worker/instructions.py`), and
ships at most one `.ogg`/`.mp3` in `out/emote/`; the previews already play it.

**Approaches considered.**
- **A. Upload it like any other file; the agent fits it in (picked).** Reuses the whole pipeline; the agent can trim,
  convert, time it to the animation, or time the animation to it. Costs a prompt and relies on the agent placing it.
- B. A direct "Replace sound" button on a finished emote: instant and free, but no trimming or timing, and the server would
  have to create revisions itself (today only the worker does). Could be added later on top of A.

**Design.**
- **Server:** a third upload kind, `audio`, sniffed from the bytes: MP3 (ID3 tag or MPEG frame sync), OGG (`OggS`),
  WAV (`RIFF…WAVE`) and M4A/AAC (`ftyp` box), stored as uploaded (no server-side transcoding). Limit 15 MB an audio file
  (chosen by the owner: room for a raw WAV recording, which the agent re-encodes). Counts toward the 12 per design.
- **The 3 MB emote allowance.** Decentraland caps an emote item at 3 MB (GLB + sound + thumbnail). The upload is raw
  material and may be bigger; what ships must not be. The agent's emote checker already FAILs GLB + sound over 3 MB, and
  the server now also refuses a prompt result whose emote GLB + sound in `pieces/emote/` totals more than 3 MB (from the
  stored objects' sizes), so an oversized emote can never become a revision.
  `cleanName` falls back to `sound.<ext>`. `studio_uploads.kind` comment becomes `image | model | audio`; no migration
  (it's a text column).
- **Website:** the Uploads control accepts `.mp3,.ogg,.wav,.m4a`; an audio upload shows a sound icon and a small play
  button (read through the existing authenticated upload route); `uploadProblem`/`uploadHint` know the audio size limit.
- **Agent:** `uploads_text` lists audio as "sound". New guidance: an uploaded sound is the user's own and may be used —
  when they ask for it to be the emote's sound, use it (cut to the part that matters, trimmed/padded and faded to the
  animation's length, timed to it, encoded as one `.ogg` or `.mp3` so GLB + sound stays within 3 MB); it can also be a
  reference to time the moves to (ffmpeg can find where the loud parts are). The "never a sample you found" rule stays
  for everything else. Only emotes carry sound; on other kinds the agent says so.
- **In-world panel:** unchanged (uploads stay on the website).

**Non-goals.** Beat-matching analysis on the server; sound on wearables or buildings; the direct-swap button (B).

## 2. On avatar plays an emote at its real speed

**Why.** On avatar is the only still-camera view of an emote on the website, but it renders 36 frames spread over the
whole emote and plays them at a fixed 12 fps, so every emote loops in exactly 3 s (an 8 s emote looks 2.7× too fast).
That makes it impossible to judge the speed of a move, especially a spin inside the emote. The Emotes step's walk-around
is at real speed but its camera circles, which also confuses a spin.

**Design.**
- **Worker:** the `emote` render mode samples the emote the way a play view does (`play_schedule`: 12 frames a second
  through one pass, at most 72) instead of a fixed 36, and returns `fps` *(my call: 36 frames over a long emote at real
  speed would be choppy)*. The prompt result reports each view's `fps` beside its frame count.
- **Server:** `studio_renders` gets a nullable `fps` column (as `studio_set_renders` already has), filled from the result
  and returned with each view in the design detail.
- **Website:** `Preview.tsx` passes the view's `fps` to `SpinStage`; a view rendered before this (no `fps`) keeps the
  old 12 fps until it's rendered again.
- **In-world scene:** unaffected — it plays piece emote views as drag-to-turn frames and uses set views' own `fps`.

**Non-goals.** Re-rendering existing designs' views; fixed front/side/back views on the website.

## Left to the builder

Exact sniffing helpers, icon choice, test layout, and migration naming, following the existing code.
