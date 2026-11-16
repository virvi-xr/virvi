# Studio Sound Uploads and On Avatar True Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player upload their own sound (MP3, OGG, WAV, M4A) for the agent to use as an emote's sound or timing
reference, with the shipped emote held to Decentraland's 3 MB; and make the On avatar emote view play at the emote's
real speed.

**Architecture:** A third upload kind, `audio`, flows through the existing uploads pipeline (server sniff → store →
prompt job `uploads` → worker `uploads/` → agent instructions). The server refuses a prompt result whose emote GLB +
sound exceeds 3 MB. Separately, the worker's `emote` render mode samples at 12 frames a second (`play_schedule`) and
reports `fps` per view; the server stores it on `studio_renders` and the website plays the view at it.

**Tech Stack:** Fastify + Drizzle (Postgres) + Vitest (`apps/server`), Python + pytest (`apps/studio-worker`),
Next.js + Vitest (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-11-16-studio-sound-uploads-and-true-speed-design.md`

## Global Constraints

- Audio upload limit: **15 MB** a file (`UPLOAD_LIMITS.audioBytes = 15 * 1024 * 1024`); audio counts toward `perDesign: 12`.
- Accepted audio, judged by contents: MP3 (`audio/mpeg`, `.mp3`), OGG (`audio/ogg`, `.ogg`), WAV (`audio/wav`, `.wav`),
  M4A (`audio/mp4`, `.m4a`). Stored as uploaded, no transcoding.
- Emote allowance: GLB + sound **≤ 3 MB** (`3 * 1024 * 1024` bytes), matching `check_emote.py`.
- Only emotes carry sound (`store.ts` already refuses a sound file on other categories).
- Schema changes go in `apps/server/src/db/schema.ts` only (production applies them with `drizzle-kit push` at deploy).
- Views rendered before this change have no `fps` and keep playing at 12 fps.
- `CONTRACT.md` (`apps/studio-worker/CONTRACT.md`) is the worker↔server contract: update it with every shape change.

## Review Focus

- A video or text file renamed `.mp3`/`.m4a` must be refused (`unsupported_file`); an `.mp4` video's `ftyp` box is not audio unless the name says `.m4a`. → Task 1 test `refuses files that only look like audio by name`.
- A 14 MB WAV voice memo must be accepted; a 16 MB one refused with `file_too_large`. → Task 1 test `takes sounds up to 15 MB`.
- An agent result whose emote is over 3 MB must not become a revision, must not count the prompt, and must say why in the conversation. → Task 2 tests.
- An old On avatar view (no `fps`) must still play, at 12. → Task 6 test `stageState carries a view's fps, null for an old one`.
- A sound uploaded to a wearable design must not break the prompt: the agent says only emotes have sound. → Task 3 test asserts the words.

---

### Task 1: Server accepts audio uploads

**Files:**
- Modify: `apps/server/src/studio/uploads.ts` (`UPLOAD_LIMITS`, `Prepared`, `prepareUpload`, `cleanName`, `addUpload`)
- Modify: `apps/server/src/db/schema.ts:1937` (comment `image | model | audio`)
- Test: `apps/server/test/studio-uploads.test.ts`

**Interfaces:**
- Produces: `UPLOAD_LIMITS.audioBytes: number`; `Prepared.kind: 'image' | 'model' | 'audio'`; upload rows and
  `publicUpload` with `kind: 'audio'`; `uploadPaths` entries with `kind: 'audio'` (Task 3 relies on this string).

- [ ] **Step 1: Write the failing tests** in `studio-uploads.test.ts`, reusing the file's upload helper and fixtures:
  - `takes the sound formats, judged by their contents`: uploads `MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64, 1)])`,
    `MP3_SYNC = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x44]), Buffer.alloc(64, 1)])`, `OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 1)])`,
    `WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(64, 1)])`,
    `M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(64, 1)])` as `fart.mp3`, `pop.mp3`, `a.ogg`, `b.wav`, `c.m4a`;
    expects 201 each, `kind: 'audio'`, contentTypes `audio/mpeg`, `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/mp4`, and the stored bytes equal the uploaded bytes.
  - `refuses files that only look like audio by name`: `notes.mp3` with `Buffer.from('hello')`, and the `M4A` bytes as `clip.mp4` → 400 `unsupported_file`.
  - `takes sounds up to 15 MB`: a WAV header padded to `UPLOAD_LIMITS.audioBytes - 1024` → 201; padded to `UPLOAD_LIMITS.audioBytes + 1` → 413 `file_too_large`.
  - `names a nameless sound`: `OGG` as `.ogg` → name `sound.ogg`.
  - In the existing `a prompt job lists the uploads…` test, add a sound and expect its entry `{ name: 'fart.mp3', kind: 'audio' }`.

- [ ] **Step 2: Run them to see them fail**

  Run: `cd apps/server && pnpm vitest run test/studio-uploads.test.ts`
  Expected: the new tests FAIL (400 `unsupported_file`).

- [ ] **Step 3: Implement.** In `uploads.ts`: `UPLOAD_LIMITS.audioBytes = 15 * MB`; a `sound(b, name): Prepared | null`
  sniffer checked right after `model()` in `prepareUpload`: `ID3` at 0 or MPEG frame sync (`b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0`) → mp3;
  `OggS` → ogg; `RIFF` at 0 and `WAVE` at 8 → wav; `ftyp` at 4 **and** `ext(name) === 'm4a'` → m4a. `addUpload`'s first
  size check uses the largest of the three limits; the second picks the limit by kind. `cleanName`'s fallback stem is
  `model` for 3D, `sound` for audio, `image` otherwise (pass the kind, not the ext). Update the file's top comment to
  include sounds. Schema comment → `image | model | audio`.

- [ ] **Step 4: Run the tests to see them pass**

  Run: `cd apps/server && pnpm vitest run test/studio-uploads.test.ts && pnpm typecheck`
  Expected: all PASS, no type errors.

- [ ] **Step 5: Commit** — `feat(studio): sound uploads (MP3, OGG, WAV, M4A, up to 15 MB)`

### Task 2: Server refuses an emote over 3 MB

**Files:**
- Create: `apps/server/src/studio/emote-size.ts`
- Modify: `apps/server/src/routes/studio-worker.ts:179-182` (the result route)
- Modify: `apps/studio-worker/CONTRACT.md` (Result section: note the 3 MB refusal)
- Test: `apps/server/test/studio-emote-size.test.ts`

**Interfaces:**
- Consumes: `ContractResult` (`results.ts`), `getStudioStore().list(prefix): Promise<{ key: string; size: number }[]>`, `jobFileKey`, `soundFile`.
- Produces: `EMOTE_ALLOWANCE_BYTES = 3 * 1024 * 1024`; `enforceEmoteAllowance(job: { id: string; designId: string }, result: ContractResult): Promise<ContractResult>`.

- [ ] **Step 1: Write the failing tests** (`studio-emote-size.test.ts`, set up like `studio-scope.test.ts`: `queueJob` an
  emote prompt, take it, store files with the memory store, post via `/api/studio/worker/jobs/:jobId/result`):
  - `an emote and its sound within 3 MB become a revision`: GLB 2 MB + `pieces/emote/fart.mp3` 0.9 MB → revision created, files include the sound.
  - `an emote over 3 MB is refused, not counted, and the note says why`: GLB 2 MB + sound 1.5 MB → job `failed`, no
    `emote` piece/revision, the prompt is refunded (as other `error` outcomes are), and a system message equals
    `Something went wrong: the emote and its sound came to 3.5 MB, over Decentraland's 3 MB limit for an emote. Your prompt was not counted.`
  - `a result without an emote is untouched`: the `okResult` hat → unchanged behaviour.

- [ ] **Step 2: Run to see them fail** — `cd apps/server && pnpm vitest run test/studio-emote-size.test.ts` → the over-limit test FAILs (a revision is created).

- [ ] **Step 3: Implement `enforceEmoteAllowance`.** For the `emote` piece with `files`: list
  `jobFileKey(designId, jobId, 'pieces/emote/')`, take the largest `.glb` size plus the size of `soundFile('emote', files)`
  (0 when none). Over the allowance → return `{ ...result, outcome: 'error', error: \`the emote and its sound came to ${(total / MB).toFixed(1)} MB, over Decentraland's 3 MB limit for an emote\`, pieces: result.pieces.filter((p) => p.category !== 'emote') }`;
  otherwise return `result` unchanged. Call it in the route between `parseResult` and `applyResult`. Add one line to CONTRACT.md's Result section.

- [ ] **Step 4: Run to see them pass** — same command plus `pnpm vitest run test/studio-scope.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(studio): refuse an emote whose model and sound pass 3 MB`

### Task 3: The agent may use an uploaded sound

**Files:**
- Modify: `apps/studio-worker/studio_worker/instructions.py` (`uploads_text`, the emote `what` text at lines ~99-104)
- Modify: `apps/studio-worker/CONTRACT.md:110-113` (upload `kind` includes `audio`)
- Test: `apps/studio-worker/tests/test_uploads.py`

**Interfaces:**
- Consumes: upload entries `{'path', 'name', 'kind': 'image' | 'model' | 'audio'}` from Task 1.

- [ ] **Step 1: Write the failing tests** in `test_uploads.py`:
  - `test_a_sound_is_listed_and_what_it_can_be_for`: `uploads_text([{'path': 'uploads/1/fart.mp3', 'name': 'fart.mp3', 'kind': 'audio'}])`
    contains `- uploads/fart.mp3 (sound)`, `the user's own`, `within 3 MB`, `time the moves to`, and `Only an emote has a sound`.
  - `test_the_emote_brief_prefers_an_uploaded_sound`: the emote instructions (built as the existing emote tests build them)
    contain `use the sound the user uploaded` and still contain `never a sample you found`.

- [ ] **Step 2: Run to see them fail** — `cd apps/studio-worker && python3 -m pytest tests/test_uploads.py -q` → 2 FAIL.

- [ ] **Step 3: Implement.** `kinds` gains `'audio': 'sound'`. Append to the `uploads_text` paragraph, before "Leave the files…":
  `A sound is the user's own recording or track, so you may use it. When they ask for it as the emote's sound, cut it to the part they mean, trim or pad it to the animation's length with short fades, time it to the moves, and encode it with ffmpeg as the one .ogg or .mp3 in out/emote/, small enough that the GLB and the sound stay within 3 MB together. It can also be a reference to time the moves to: ffmpeg can find where its loud parts are. Only an emote has a sound: on anything else, say so in your reply.`
  In the emote `what` text, replace "When the request asks for sound, make it yourself (" with
  "When the request asks for sound, use the sound the user uploaded if they asked for it; otherwise make it yourself (".
  Update CONTRACT.md's `uploads` kinds.

- [ ] **Step 4: Run to see them pass** — `cd apps/studio-worker && python3 -m pytest tests/test_uploads.py tests/test_agent.py -q` → PASS.

- [ ] **Step 5: Commit** — `feat(studio-worker): the agent can use an uploaded sound for an emote`

### Task 4: Website takes and plays sound uploads

**Files:**
- Modify: `apps/web/src/lib/studio.ts:158` (`StudioUpload.kind`), `:574-575` (`uploadHint`), `:919-934` (`AUDIO_EXTS`, `UPLOAD_ACCEPT`, `uploadProblem`)
- Modify: `apps/web/src/app/(dashboard)/studio/[designId]/Uploads.tsx` (thumbnail for audio)
- Modify: `apps/web/src/components/icons*` (a speaker icon, if the set has none)
- Test: `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- Consumes: `kind: 'audio'` from the server (Task 1).

- [ ] **Step 1: Write the failing tests** in `studio.test.ts`:
  - `UPLOAD_ACCEPT` contains `.mp3`, `.ogg`, `.wav`, `.m4a`.
  - `uploadProblem({ name: 'fart.mp3', size: 15 * MB })` is `null`; `({ name: 'fart.wav', size: 15 * MB + 1 })` is `FILE_TOO_LARGE`; `({ name: 'a.flac', size: 10 })` is `UNSUPPORTED_FILE`.
  - `uploadHint('emote')` equals `Images, 3D files or sounds for the agent. Say what each is for, like “use whoosh.mp3 as the sound”.`;
    `uploadHint('wearable')` equals `Images, 3D files or sounds for the agent. Say what each is for, like “put logo.png on the chest”.`

- [ ] **Step 2: Run to see them fail** — `cd apps/web && pnpm vitest run src/lib/studio.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `AUDIO_EXTS = ['mp3', 'ogg', 'wav', 'm4a']`, limit `15 * MB`; `uploadHint` copy as tested
  (scene keeps `put sign.png over the door`). In `Uploads.tsx`, an `audio` upload shows a speaker icon that is a
  play/pause button: on first press it fetches the file through the same authenticated route the image thumbnail uses,
  plays it from an object URL, and revokes the URL on unmount; label `Play fart.mp3` / `Pause fart.mp3`.

- [ ] **Step 4: Run to see them pass** — `cd apps/web && pnpm vitest run src/lib/studio.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(web): attach and play sound files in the studio`

### Task 5: Worker renders On avatar emotes at their real rate

**Files:**
- Modify: `apps/studio-worker/studio_worker/render.py:233-235` (`emote` mode), docstring at `:84-94`
- Modify: `apps/studio-worker/studio_worker/jobs.py:434-454` (`_render_and_upload`), `:193`, `:356-357`, `:472`
- Modify: `apps/studio-worker/CONTRACT.md` (`emote-…` view key description; `pieces[].fps`)
- Test: `apps/studio-worker/tests/test_jobs.py`

**Interfaces:**
- Produces: each result piece may carry `'fps': {viewKey: float}` beside `'renders'`, present only for views whose
  render returned `fps` (Task 6 parses it). `_render_and_upload(...) -> tuple[dict, dict, str | None]` = `(renders, fps, error)`.

- [ ] **Step 1: Write the failing tests** in `test_jobs.py`, with the file's fake `render_fn`:
  - `test_a_render_job_reports_each_views_fps`: a render job for an emote design whose fake `render_fn` returns
    `{'ok': True, 'frames': [...24 paths], 'fps': 12.0}` → result piece `{'category': 'emote', 'renders': {'emote-male-default': 24}, 'fps': {'emote-male-default': 12.0}}`.
  - `test_a_view_without_fps_reports_none`: the fake returns no `fps` (a wearable spin) → the piece has no `fps` key.
  - The prompt path (line ~472) carries `fps` the same way.

- [ ] **Step 2: Run to see them fail** — `cd apps/studio-worker && python3 -m pytest tests/test_jobs.py -q` → FAIL.

- [ ] **Step 3: Implement.** `emote` mode: `times, fps = play_schedule(length)`; steps `goTo` each time (camera still,
  as now). `_render_and_upload` returns the view's `fps` alongside its count; callers add `'fps'` to the piece only when non-empty.
  CONTRACT.md: `emote-<bodyShape>-<outfit>` is stepped once through at 12 frames a second, at most 72 frames, and reports `fps`.

- [ ] **Step 4: Run to see them pass** — `cd apps/studio-worker && python3 -m pytest -q` → PASS (the existing `play_schedule` tests cover the timing).

- [ ] **Step 5: Commit** — `feat(studio-worker): On avatar emote views at the emote's real rate`

### Task 6: Server stores and serves a view's fps; the website plays at it

**Files:**
- Modify: `apps/server/src/db/schema.ts:1985` (`studioRenders.fps: real('fps')`, nullable, like `studioSetRenders.fps`)
- Modify: `apps/server/src/studio/results.ts` (`ContractPiece.fps?: Record<string, number>`; validate in `parseResult`; write on insert at ~236 and update at ~280-289)
- Modify: `apps/server/src/studio/designs.ts:245-252` (each view gains `fps: number | null`)
- Modify: `apps/web/src/lib/studio.ts:63-66` (`StudioView.fps?: number | null`), `:664-674` (`StageState` frames gains `fps: number | null`)
- Modify: `apps/web/src/app/(dashboard)/studio/[designId]/Preview.tsx:186` (pass `fps={spin.fps ?? undefined}`)
- Test: `apps/server/test/studio-preview-steps.test.ts`, `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- Consumes: result pieces' `fps` map from Task 5.

- [ ] **Step 1: Write the failing tests:**
  - Server: `a render result's fps is kept and shown with the view`: post a render result with `renders: {'emote-male-default': 24}, fps: {'emote-male-default': 12}` → the design detail's `pieces[0].renders['emote-male-default'].fps === 12`; a result without `fps` → `fps === null`.
  - Server: `parseResult` refuses `fps: {'emote-male-default': -1}`, `{ 'emote-male-default': 'x' }` and a bad view key with `a render's fps is malformed`; accepts `0 < fps <= 60`.
  - Web: `stageState carries a view's fps, null for an old one`.

- [ ] **Step 2: Run to see them fail** — `cd apps/server && pnpm vitest run test/studio-preview-steps.test.ts` and `cd apps/web && pnpm vitest run src/lib/studio.test.ts` → FAIL.

- [ ] **Step 3: Implement** as listed in Files. Push the schema to the local test database the way the test helpers
  expect (`cd apps/server && DATABASE_URL=$TEST_DATABASE_URL npx drizzle-kit push`).

- [ ] **Step 4: Run to see them pass** — both commands above, then `pnpm typecheck` at the repo root → PASS.

- [ ] **Step 5: Commit** — `feat(studio): On avatar plays an emote at the rate it was rendered`

### Task 7: Whole-branch check

- [ ] **Step 1:** `pnpm typecheck && pnpm --filter ./apps/server test && pnpm --filter ./apps/web test` and `cd apps/studio-worker && python3 -m pytest -q` → all PASS.
- [ ] **Step 2:** Run the app (the `run` skill) and, on an emote design, attach an MP3: it lists with a play button and plays.
  On an emote's On avatar view rendered after this change, the loop lasts as long as the emote.
