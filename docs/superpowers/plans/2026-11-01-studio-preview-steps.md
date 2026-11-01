# Design Studio preview steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The preview gets steps (Inspect, On avatar, Emotes, Finalize). Inspect turns the item in every direction. Emotes play smoothly with every piece worn, including run and jump. A clipping report gets the agent to fix it for free, and finalizing renders every emote and encourages a check.

**Architecture:**
- **Worker render modes:** the renderer gains two modes. `orbit` is the item alone over a sphere of angles. `walk` is an emote stepped through its timeline while the camera turns.
- **Orbit views:** these are per-piece `studio_renders` rows. The eye-level ring renders with each prompt; a background job swaps in the full sphere.
- **Emote views:** these are design-level rows in a new `studio_set_renders` table, keyed by the set of piece revisions.
- **Check state and fixes:** check state lives in `studio_emote_checks`. A clipping report is a free prompt, like the existing `fixChecks` path.

**Tech Stack:**
- **Worker:** Python 3 (Playwright, pytest).
- **Server:** Fastify, Drizzle and Postgres, tested with vitest.
- **Web:** Next.js and React, tested with vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-studio-preview-steps-design.md`

## Measured on the worker (2026-11-01)

Measured on a performance-4x Fly machine with image `daced58` and the neon cap fixture. Boot is about 3 s, or 7 s cold.

| Render | Frames | Total | Per frame |
|---|---|---|---|
| spin | 36 | 19.3 s | 0.34 s |
| spin | 120 | 39.2 s | 0.30 s |
| spin with dance playing | 36 | 15.1 s | 0.34 s |
| dance, stepped with `goTo` | 60 | 21.6 s | 0.31 s |
| item alone (`type=wearable`), spin | 24 | 11.1 s | 0.33 s |

**What follows from these numbers:**
- **Orbit grid:** 24 round × rows at 90°, 60°, 120°, 30° and 150°, plus one frame at each pole: 122 frames, about 40 s. The ring alone is 24 frames, about 11 s, and adds that much to each wearable prompt.
- **Walk:** 24 fps, at least 96 frames (a 4 s turn) and at most 120. That's 32–40 s per emote.
- **Finalize:** 7 emotes × 2 body shapes is about 14 × 36 s, roughly 8½ minutes of rendering, which arrives while the person is checking.

## Global Constraints

- No GLB, glTF or texture reaches a browser before payment. Browsers only get rendered frames, through signed URLs (`render-urls.ts`).
- `BASE_EMOTES` = `['idle', 'wave', 'dance', 'clap', 'walk', 'run', 'jump']`, in `designs.ts`, the worker's `config.py` and the web.
- A clipping fix is free (`counted: false`), uses server-written text, and skips the scope check (`check: false`). Each design and emote gets 2 fixes since the person's last counted prompt. Only fixes whose outcome is `ok` count toward the 2.
- The third report's refusal copy is exactly: `We've tried to fix the clipping in the {emote} twice. Describe what you see in a prompt and the agent will take another look.`
- The report's conversation message is exactly: `It clips in the {emote} ({bodyShape}, {outfit label} outfit). Please fix it.`
  - `{emote}` is the emote's name (`the dance`). For an emote design it's `the emote`.
  - The outfit labels are `default`, `outfit 2` and `outfit 3`.
- The emote checklist is never a gate on paying.
- A failed render never replaces good frames, and saves none of its own.
- A view someone asks for runs before background renders (`studio_jobs.background`).
- Node 22: prefix commands with `PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH`.
- Server tests need Docker's Postgres. Isolate runs with `TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_preview_steps`.

## Review Focus

1. **A change mid-check:** a prompt lands while the person is checking emotes. The set views and checks must go stale (new revisions mean a new key), never show the old frames as current.
2. **A full orbit that fails after the ring:** the 24-frame ring must stay visible, and the failed full job must not blank it. Covered by a test in Task 4.
3. **A clipping report while a prompt runs, or on a view never rendered:** both are refused with the existing `busy` code or `not_seen`, and no fix is queued. Tests in Task 6.
4. **An emote design reporting clipping:** the view key uses `own`, the copy says "the emote", and the cap still counts. Test in Task 6.
5. **Pieces added or removed between renders:** the set key is built from every piece's latest revision. A design whose pieces changed never shows a set view rendered from fewer pieces. Test in Task 5.

---

### Task 1: Worker render modes `orbit` and `walk`, and `studio-preview --emote`

**Files:**
- Modify: `apps/studio-worker/studio_worker/render.py`
- Modify: `apps/studio-worker/studio_worker/config.py:13` (`BASE_EMOTES` gains `'run', 'jump'`)
- Modify: `apps/studio-worker/tests/fixtures/preview_stub.html` (answers `changeCameraPosition` with `beta`, and `goTo` in walk mode, as it does today)
- Test: `apps/studio-worker/tests/test_render.py`

**Interfaces:**
- Produces:
  - `ORBIT_ROWS = (90, 60, 120, 30, 150)`, in degrees of camera `beta`, ring first; `ORBIT_COLS = 24`; `ORBIT_FRAMES = 122`.
  - Frame index: row `r` and column `c` give `r * 24 + c`. The pole at 0° (looking down) is frame 120, and the pole at 180° (looking up) is frame 121.
  - `orbit_steps(ring: bool) -> list[dict]`: the controller params sent before each frame, as relative moves `{'alpha': rad, 'beta': rad}`. Today's spin already relies on `changeCameraPosition` being relative. The camera starts at `beta = π/2`. It returns 24 entries for the ring, 122 otherwise. The camera ends each row back at column 0 before changing `beta`.
  - `walk_schedule(length: float) -> tuple[list[float], float]`: `T = max(length, 4.0)`, `n = min(120, round(T * 24))`, times `[(i * T / n) % length for i in range(n)]`, `fps = n / T`. A `length` of 0 or less returns `([0.0] * 96, 24.0)`.
  - `render(...)` view modes gain:
    - `'orbit'`: the item alone, so the query adds `&type=wearable`. `view.get('ring')` limits it to the ring. The `frames` argument is ignored.
    - `'walk'`: pause, `getLength`, then per frame `goTo(t_i)` plus `changeCameraPosition({'alpha': 2π/n})`. The `frames` argument is ignored.
  - A walk result gains `'fps'`.
  - `studio-preview DIR... --emote NAME [--body male|female] [--out review]`: renders walk mode for the pieces together and keeps 16 evenly spaced frames, saved as `NN.png`. It prints their paths.

- [ ] **Step 1: Write the failing tests**

```python
def test_orbit_steps_cover_the_sphere():
    steps = render.orbit_steps(ring=False)
    assert len(steps) == 122
    beta, betas = math.pi / 2, []
    for s in steps:
        beta += s.get('beta', 0)
        betas.append(round(math.degrees(beta)))
    assert betas[:24] == [90] * 24 and betas[24:48] == [60] * 24 and betas[96:120] == [150] * 24
    assert betas[120] == 0 and betas[121] == 180
    assert sum(s.get('alpha', 0) for s in steps[:24]) == pytest.approx(2 * math.pi * 23 / 24)

def test_orbit_ring_is_the_first_24():
    assert render.orbit_steps(ring=True) == render.orbit_steps(ring=False)[:24]

def test_walk_schedule_spreads_a_short_emote_over_four_seconds():
    times, fps = render.walk_schedule(2.0)
    assert len(times) == 96 and fps == pytest.approx(24.0)
    assert max(times) < 2.0  # loops the animation

def test_walk_schedule_caps_a_long_emote_at_120():
    times, fps = render.walk_schedule(10.0)
    assert len(times) == 120 and fps == pytest.approx(12.0) and times[-1] == pytest.approx(9.9166, abs=1e-3)

def test_orbit_renders_the_item_alone(tmp_path, stub):
    calls = stub()
    r = render.render([HAT], {**SPIN, 'mode': 'orbit', 'ring': True}, tmp_path, watchdog_sec=60)
    assert r['ok'] is True, r and len(r['frames']) == 24
    assert 'type=wearable' in render._query({**SPIN, 'mode': 'orbit'})

def test_walk_steps_time_and_turns_together(tmp_path, stub):
    calls = stub()  # the stub's emote length is 3.0 s
    r = render.render([WAVE], {**SPIN, 'mode': 'walk'}, tmp_path, watchdog_sec=60)
    assert r['ok'] is True, r and len(r['frames']) == 96 and r['fps'] == pytest.approx(24.0)
    goes = [c['params'][0] for c in calls if c['method'] == 'goTo']
    turns = [c for c in calls if c['method'] == 'changeCameraPosition']
    assert len(goes) == 96 and len(turns) == 96 and goes[1] == pytest.approx(4.0 / 96)
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd apps/studio-worker && python3 -m pytest tests/test_render.py -q`
Expected: FAIL with `AttributeError: module 'studio_worker.render' has no attribute 'orbit_steps'`.

- [ ] **Step 3: Implement the modes in `render.py`**

`orbit_steps`, `walk_schedule`, the two branches in `_run` next to today's `emote` branch, `_query` adding `type=wearable` for orbit, and `--emote` in `main`. Name orbit frames `NNN.webp` like spin, and walk frames `NNN.webp`. The `--emote` frames are PNGs, so the agent can open them.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd apps/studio-worker && python3 -m pytest tests/test_render.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/studio-worker && git commit -m "feat(studio-worker): orbit and walk render modes, studio-preview --emote"
```

### Task 2: Worker jobs: the ring with each prompt, orbit and set render jobs, clipping-fix frames

**Files:**
- Modify: `apps/studio-worker/studio_worker/jobs.py`
- Modify: `apps/studio-worker/CONTRACT.md` (Job `render`, `fixClipping`, Result `set`, the files table)
- Test: `apps/studio-worker/tests/test_jobs.py`

**Interfaces:**
- Consumes: Task 1's modes. `render_fn(...)` returns `'fps'` for walk.
- Produces (contract):
  - A prompt job on a wearable: each changed piece's `renders` holds `spin-male-default` and `orbit-male` (24 frames).
  - A render job with `render: {"categories": [c], "bodyShape": s, "mode": "orbit", "ring": bool}` gives `pieces: [{"category": c, "renders": {"orbit-<s>": n}}]`.
  - A render job with `render: {"set": true, "bodyShape", "outfit", "emote"}` renders every current piece together in walk mode. For an emote design, `emote` is `"own"` and the page plays the design's emote.
    - It uploads `renders/set/<viewKey>/NNN.webp`, where `viewKey` = `walk-<bodyShape>-<outfit>-<emote>`.
    - The result carries `set: {"viewKey", "frames", "fps"}` and `pieces: []`.
  - A prompt job with `fixClipping: {"emote", "bodyShape", "outfit"}`: before the agent runs, the worker writes 16 frames of that emote, with every piece worn, to `review/clipping/<emote>/NN.png`. It does this through `render.look`'s walk counterpart, Task 1's `--emote` function. The prompt sent to the agent is `job['prompt']` + `\nFrames of the clipping are in review/clipping/<emote>/: open every one before you change anything, and after your fix run studio-preview <piece folders> --emote <emote> --body <bodyShape> and open those frames to check it.`
  - `view_key(view)` handles `orbit` (`orbit-<shape>`) and `walk` (`walk-<shape>-<outfit>-<emote>`).

- [ ] **Step 1: Write the failing tests** (in `test_jobs.py`'s style, with its fake render function and `FakeApi`)

```python
def test_wearable_prompt_renders_the_inspect_ring(...):
    # one changed hat → render_fn called with mode 'spin' and with {'mode': 'orbit', 'ring': True, 'bodyShape': 'male'}
    assert result['pieces'][0]['renders'] == {'spin-male-default': 36, 'orbit-male': 24}

def test_emote_prompt_renders_no_ring(...):
    assert 'orbit-male' not in result['pieces'][0]['renders']

def test_orbit_render_job_full_sphere(...):
    # render {'categories': ['hat'], 'bodyShape': 'female', 'mode': 'orbit', 'ring': False}
    assert result['pieces'] == [{'category': 'hat', 'renders': {'orbit-female': 122}}]
    assert api.files has 'renders/hat/orbit-female/121.webp'

def test_set_render_job_wears_every_piece(...):
    # two pieces (hat, upper_body); render {'set': True, 'bodyShape': 'male', 'outfit': 'default', 'emote': 'run'}
    assert len(render_calls[0].pieces) == 2 and render_calls[0].view['mode'] == 'walk'
    assert result['set'] == {'viewKey': 'walk-male-default-run', 'frames': 96, 'fps': 24.0}
    assert 'renders/set/walk-male-default-run/000.webp' in api.files

def test_set_render_failure_uploads_nothing(...):
    assert result['outcome'] == 'error' and not [f for f in api.files if f.startswith('renders/set/')]

def test_clipping_fix_shows_the_agent_frames_first(...):
    # job with fixClipping {'emote': 'dance', 'bodyShape': 'male', 'outfit': 'default'}
    assert (design / 'review/clipping/dance/00.png').exists() before the agent command runs
    assert 'review/clipping/dance/' in prompt_given_to_agent
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/studio-worker && python3 -m pytest tests/test_jobs.py -q`
Expected: the six new tests FAIL. The ring test fails on a missing `orbit-male` key.

- [ ] **Step 3: Implement in `jobs.py`**

- `_prompt_job`: after `spin`, render the ring for wearables, and add it to the piece's `renders`. A ring failure counts as a render problem, like spin's.
- `_render_job`: branch on `spec.get('set')` into `_set_render(...)`. Pass `mode` and `ring` through for orbit.
- The fix-clipping frames come before `_phase('building')`. If they fail, the result is `error`, saying `could not render the clipping frames: …`, and the agent doesn't run.
- Update `CONTRACT.md` alongside.

- [ ] **Step 4: Run the worker suite**

Run: `cd apps/studio-worker && python3 -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/studio-worker && git commit -m "feat(studio-worker): inspect ring per prompt, orbit and set render jobs, clipping-fix frames"
```

### Task 3: Server schema, emote list and view keys

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/studio/designs.ts`
- Modify: `apps/server/src/routes/studio-worker.ts:125-138` (queue order)
- Test: `apps/server/test/studio-schema.test.ts`, `apps/server/test/studio-worker-routes.test.ts`

**Interfaces:**
- Produces:
  - **Schema:**
    - `studio_jobs.background boolean NOT NULL DEFAULT false`.
    - `studio_renders.pending_job_id uuid NULL`: the full orbit job that will replace a ready ring.
    - `studioSetRenders` (`studio_set_renders`): `id`, `designId` (FK, cascade), `revisions` text (the sorted latest revision ids, comma-joined), `viewKey`, `jobId`, `frames` int default 0, `fps` double null, `status` (`queued | ready | failed`), and `createdAt`. Unique on `(designId, revisions, viewKey)`.
    - `studioEmoteChecks` (`studio_emote_checks`): `id`, `designId` (FK, cascade), `revisions`, `emote`, `bodyShape`, `state` (`fine | clipping`), and `createdAt`. Unique on `(designId, revisions, emote, bodyShape)`.
  - **`designs.ts`:**
    - `BASE_EMOTES` adds `run, jump`. `View['emote']` widens to match.
    - `OWN_EMOTE = 'own'`.
    - `orbitKey(bodyShape) => 'orbit-<bodyShape>'`.
    - `setViewKey(kind, view) => 'walk-<bodyShape>-<outfit>-<emote | own>'`.
    - `revisionsKey(pieces: { latestRevisionId: string | null }[]): string`, built from the sorted non-null ids. It's `''` when there are none.
    - `ORBIT_RING = 24`, `ORBIT_FRAMES = 122`.
  - **Queue order:** `jobs/next` orders by `background, created_at, id`.

- [ ] **Step 1: Write the failing tests**

```ts
it('takes asked-for jobs before background ones', async () => {
  // insert a background render job, then a normal render job a second later
  // GET jobs/next → the normal one's id
})
it('builds the set key from every piece, in a stable order', () => {
  expect(revisionsKey([{ latestRevisionId: 'b' }, { latestRevisionId: null }, { latestRevisionId: 'a' }])).toBe('a,b')
  expect(setViewKey('emote', { bodyShape: 'female', outfit: 'default', emote: null })).toBe('walk-female-default-own')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/server && npx vitest run test/studio-worker-routes.test.ts test/studio-schema.test.ts`
Expected: FAIL. `revisionsKey` isn't exported, and the order test gets the background job.

- [ ] **Step 3: Implement**

Use the schema and designs changes above. Run `npx drizzle-kit push` against the dev database, the way deploys apply it.

- [ ] **Step 4: Run the server suite**

Run: `cd apps/server && npx tsc --noEmit -p . && npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit** `feat(studio): schema for set renders and emote checks; run and jump; background queue order`

### Task 4: Server orbit views: the ring now, the full sphere behind it

**Files:**
- Modify: `apps/server/src/studio/designs.ts` (`requestRender`, and a new `queueFullOrbit`)
- Modify: `apps/server/src/studio/results.ts` (prompt branch and render branch)
- Modify: `apps/server/src/routes/studio.ts:328-347` (`mode: 'orbit'` in the body)
- Test: `apps/server/test/studio-routes.test.ts`, `apps/server/test/studio-contract.test.ts`

**Interfaces:**
- Consumes: Task 3's `orbitKey`, `pending_job_id` and `background`.
- Produces:
  - `POST /api/studio/designs/:id/renders` accepts `{category, bodyShape, mode: 'orbit'}` for a wearable piece. Outfit and emote are ignored, and an emote design gets 400 `unknown mode`.
    - If no row exists, it inserts the row with the ring job's id, then queues a ring job (`ring: true`) and a full job (`background: true`, set as `pending_job_id`).
  - `queueFullOrbit(tx, designId, revisionId, category, bodyShape)`: queues the background full job and sets `pending_job_id`. It's called from `applyResult` for each new revision whose `renders` include `orbit-male`.
  - On a render result, the render branch matches rows on `jobId = job.id OR pendingJobId = job.id`.
    - A full job that succeeds sets `jobId`, `frames` and `status: 'ready'`, and clears `pendingJobId`.
    - A full job that fails clears `pendingJobId` and leaves a ready ring alone.

- [ ] **Step 1: Write the failing tests**

```ts
it('a wearable prompt with a ring queues the full sphere in the background', async () => {
  // apply okResult with renders {'spin-male-default': 36, 'orbit-male': 24}
  // → studio_renders orbit-male ready, frames 24, pendingJobId = a new background render job
  //   whose payload.render = { categories: ['hat'], bodyShape: 'male', mode: 'orbit', ring: false }
})
it('the full sphere replaces the ring when it lands', async () => {
  // post a render result for the background job with renders {'orbit-male': 122}
  // → frames 122, jobId = background job id, pendingJobId null; detail urls length 122
})
it('a failed full sphere keeps the ring', async () => {
  // post outcome 'error' for the background job → frames 24, status ready, pendingJobId null
})
it('asking for the female sphere queues the ring first and the rest behind it', async () => {
  // POST renders {category:'hat', bodyShape:'female', mode:'orbit'} → two jobs; the ring job not background, the full one background
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/server && npx vitest run test/studio-routes.test.ts test/studio-contract.test.ts`
Expected: the four new tests FAIL.

- [ ] **Step 3: Implement** as in Interfaces. `designDetail` needs no change: orbit rows are ordinary per-piece views.

- [ ] **Step 4: Run the server suite** (the command from Task 3). Expected: all pass.

- [ ] **Step 5: Commit** `feat(studio): inspect views, the ring with each prompt and the full sphere behind it`

### Task 5: Server set views: every piece worn, design-level

**Files:**
- Create: `apps/server/src/studio/sets.ts` (`currentRevisions`, `requestSetRender`, `setDetail`)
- Modify: `apps/server/src/studio/designs.ts` (`designDetail` adds `set`)
- Modify: `apps/server/src/studio/results.ts` (`parseResult` takes `set`, and the render branch applies it)
- Modify: `apps/server/src/routes/studio.ts` (the new route, and a `set` branch on the frame route)
- Test: `apps/server/test/studio-routes.test.ts`, `apps/server/test/studio-contract.test.ts`

**Interfaces:**
- Consumes: Task 3's `studioSetRenders`, `setViewKey`, `revisionsKey` and `OWN_EMOTE`.
- Produces:
  - `currentRevisions(designId, exec) => string`: `revisionsKey` over the design's pieces.
  - `POST /api/studio/designs/:id/set-renders` with body `{bodyShape, outfit, emote}`:
    - `emote` must be in `BASE_EMOTES` for a wearable, and null for an emote design.
    - It returns `{status: 'ready', frames, fps, urls}` or `{status: 'queued'}`. It returns 404 `piece_not_found` when the design has no pieces.
    - The job payload's `render` is `{set: true, bodyShape, outfit, emote: emote ?? 'own'}`. The row is keyed by the revisions at queue time.
  - `designDetail(...).set` is `{revisions: string, views: Record<viewKey, {status, frames, fps, urls, renderedAt}>, checks: {emote, bodyShape, state}[], freeFixesLeft: Record<emote, number>}`. It covers only rows whose `revisions` equal the current key. (Task 6 fills `checks` and `freeFixesLeft`; until then they're `[]` and `{}`.)
  - **Set frame URLs:** `signRenderFrame({designId, revisionId: <set row id>, viewKey, category: 'set', frame, jobId})`. On the frame route, `category === 'set'` looks the row up in `studio_set_renders` by id, design, view key, job and `ready`. Store path: `renders/set/<viewKey>/NNN.webp`, unchanged through `framePath`.
  - **`parseResult`:** `set` is optional. If present it's `{viewKey: VIEW_KEY, frames: 0..999, fps: number 0 < fps ≤ 60}`. The render branch updates the set row whose `jobId` is this job.

- [ ] **Step 1: Write the failing tests**

```ts
it('queues a set view with every piece and serves its frames once rendered', async () => {
  // design with hat + upper_body revisions; POST set-renders {male, default, 'run'} → queued
  // job payload.render = { set: true, bodyShape: 'male', outfit: 'default', emote: 'run' }
  // post result { outcome: 'ok', pieces: [], set: { viewKey: 'walk-male-default-run', frames: 96, fps: 24 } }
  // detail.set.views['walk-male-default-run'] → ready, 96 urls; GET one url → 200 image/webp (store seeded)
})
it('a new revision of any piece makes the set view stale', async () => {
  // after the above, apply a prompt result that adds a hat revision → detail.set.views is {}
})
it('a piece added after the render makes the set view stale', async () => { /* Review Focus 5 */ })
it('an emote design asks for its own emote', async () => {
  // kind 'emote', POST {male, default, emote: null} → payload.render.emote 'own', key 'walk-male-default-own'
})
it('a set frame token cannot reach another design', async () => { /* token with another design's set row id → 403 */ })
```

- [ ] **Step 2: Run them to see them fail.** Same test files. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run the server suite.** Expected: all pass.

- [ ] **Step 5: Commit** `feat(studio): design-level emote views with every piece worn`

### Task 6: Server emote checks, the free clipping fix and finalize renders

**Files:**
- Modify: `apps/server/src/studio/sets.ts` (`recordCheck`, `freeFixesLeft`, `queueFinalizeRenders`)
- Modify: `apps/server/src/studio/designs.ts` (`queuePrompt` takes `fixClipping`; adds `clippingText` and `clippingInstruction`)
- Modify: `apps/server/src/studio/results.ts` (after a fix ends `ok`, queue that emote's set view for the new revisions)
- Modify: `apps/server/src/routes/studio.ts` (three routes)
- Test: `apps/server/test/studio-routes.test.ts`

**Interfaces:**
- Consumes: Task 5's `currentRevisions`, `requestSetRender` and set rows.
- Produces:
  - `POST /api/studio/designs/:id/emote-checks` with body `{emote, bodyShape, state: 'fine'}`: upserts a check for the current revisions and returns 204.
  - `POST /api/studio/designs/:id/clipping` with body `{emote, bodyShape, outfit}`:
    1. **Not seen:** the set view must be `ready` for the current revisions, or it returns 409 `not_seen`.
    2. **Cap:** `freeFixesLeft` must be above 0, or it returns 409 `clipping_fix_limit`.
    3. **Queue the fix:** it calls `queuePrompt(d, { text: null, selectedSlots: null, continue: false, fixClipping: { emote, bodyShape, outfit } }, now)`. A prompt that's already running gives the existing 409 `busy`.
    4. **Record the check:** on success it upserts check `clipping` and returns `{jobId}`.
  - `queuePrompt` with `fixClipping` is `counted: false` and `check: false`:
    - The user message is `clippingText(kind, emote, bodyShape, outfit)`, the Global Constraints copy.
    - `payload.prompt` is `clippingInstruction(...)`: `Fix the clipping in the {emote name} emote on the {bodyShape} body with the {outfit label} outfit: find which piece passes through the body, the base outfit's clothes or another piece, and change only the parts that do. Change nothing else.`
    - `payload.fixClipping` is `{emote, bodyShape, outfit}`.
  - `freeFixesLeft(designId, emote, exec) => number`: 2 minus the prompt jobs with `payload->'fixClipping'->>'emote' = emote` and result outcome `ok`, created after the design's latest `counted` prompt job. The floor is 0.
  - `POST /api/studio/designs/:id/finalize-renders`, with no body: for each emote (a wearable's `BASE_EMOTES`, or `own`) × `male, female`, it calls `requestSetRender` with outfit `default`. It returns `{queued: n}`. Calling it again queues nothing new.
  - `refusalMessage` on the web (Task 7) maps `clipping_fix_limit` to the Global Constraints copy, and `not_seen` to `Play that emote first, then report what you see.`

- [ ] **Step 1: Write the failing tests**

```ts
it('a clipping report is a free prompt with the server’s own words', async () => {
  // ready set view walk-male-default-dance; POST clipping → job counted false, payload.check false,
  // payload.fixClipping {dance, male, default}; message text 'It clips in the dance (male, default outfit). Please fix it.'
  // usage promptsLeft unchanged; detail.set.checks contains {emote:'dance', bodyShape:'male', state:'clipping'}
})
it('two ok fixes per emote, then the person is asked to describe it', async () => {
  // two fix jobs for dance finished ok → third POST → 409 clipping_fix_limit; a fix for 'run' still allowed
})
it('a fix that errored or changed nothing does not use one up', async () => { /* outcomes error, no_change */ })
it('a prompt of the person’s own resets the free fixes', async () => { /* counted job after the fixes → freeFixesLeft 2 */ })
it('a report on an emote never rendered is refused', async () => { /* 409 not_seen, no job */ })
it('a report while a prompt runs is refused as busy', async () => { /* 409 busy, no check recorded */ })
it('an emote design’s report says “the emote”', async () => { /* 'It clips in the emote (female, outfit 2 outfit). Please fix it.' */ })
it('a fix that lands re-renders that emote for the new revisions', async () => {
  // apply ok result for the fix job with a new hat revision → a set render job queued for walk-male-default-dance
})
it('finalize renders every emote on both bodies, once', async () => {
  // wearable: POST finalize-renders → { queued: 14 }; again → { queued: 0 }
})
```

- [ ] **Step 2: Run them to see them fail.** Same file. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run the server suite.** Expected: all pass.

- [ ] **Step 5: Commit** `feat(studio): emote checks, free clipping fixes and finalize renders`

### Task 7: Web data layer

**Files:**
- Modify: `apps/web/src/lib/studio.ts`
- Modify: `apps/web/src/lib/api.ts` (four calls)
- Test: `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- Consumes: the server shapes from Tasks 4–6.
- Produces:
  - Types: `StudioDetail.set: StudioSet` and `RenderView.emote`. Add the constants:
    - `EMOTES = ['idle','wave','dance','clap','walk','run','jump'] as const`
    - `STEPS = ['design','inspect','avatar','emotes','finalize'] as const`
    - `type Step = typeof STEPS[number]`
  - `orbitKey(shape)`, and `setViewKey(kind, view)`, which mirrors the server.
  - `orbitFrame(row: number, col: number, frames: number): number`. Here `row` is the on-screen row, 0..6, from top to bottom: 0°, 30°, 60°, 90°, 120°, 150°, 180°. `col` is 0..23. The rows map to the worker's frame order (Task 1):
    - 0° is frame 120 and 180° is frame 121, whatever the column.
    - The other rows are `ORBIT_ROWS.indexOf(deg) * 24 + col`. So 90° is frames 0–23, 60° is 24–47, 120° is 48–71, 30° is 72–95, and 150° is 96–119.
    - If the frame isn't rendered yet (`index >= frames`), it returns the nearest rendered row's frame at the same `col`. With 24 frames, that's always the ring.
  - `orbitDrag(start: {row, col}, dx, dy, width, height): {row, col}`. One width is a full turn, so `col` wraps. One height spans all 7 rows, so `row` clamps.
  - `emoteState(detail, emote, bodyShape): 'unchecked' | 'fine' | 'clipping' | 'fixing'`. It's `fixing` when the active prompt job is a fix for this emote. (The detail's `activeJob` gains `fixClipping`, so `designDetail` returns `payload.fixClipping` for the active job.)
  - `emoteChecklist(detail): { emote, bodyShape, state }[]`, with 14 rows for a wearable and 2 for an emote design, plus `checkedCount`.
  - `stepsFor(kind): Step[]`: an emote design drops `inspect`.
  - `refusalMessage` handles `clipping_fix_limit` and `not_seen`, with the copy from Task 6.
  - `api`: `requestStudioRender` takes `mode?: 'orbit'`. Add `requestStudioSetRender(id, view)`, `checkStudioEmote(id, {emote, bodyShape})`, `reportStudioClipping(id, {emote, bodyShape, outfit})` and `requestStudioFinalizeRenders(id)`.

- [ ] **Step 1: Write the failing tests** in `studio.test.ts`:
  - `orbitFrame(3, 5, 122) === 5`, `orbitFrame(1, 5, 122) === 77`, `orbitFrame(0, 9, 122) === 120` and `orbitFrame(1, 4, 24) === 4`.
  - `orbitDrag` wraps `col` and clamps `row`.
  - `emoteChecklist` returns 14 rows for a wearable and 2 for an emote design.
  - `emoteState` returns `fixing` during a fix job.
  - `stepsFor('emote')` has no `inspect`.
  - `refusalMessage` returns the `clipping_fix_limit` text with "the dance".
- [ ] **Step 2: Run them to see them fail:** `cd apps/web && npx vitest run src/lib/studio.test.ts`. Expected: FAIL on the missing exports.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests to see them pass:** `cd apps/web && npx tsc --noEmit -p . && npx vitest run`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(web): studio steps, inspect and emote check helpers`

### Task 8: Web UI: steps, Inspect, Emotes and the finalize checklist

**Files:**
- Create: `apps/web/src/app/(dashboard)/studio/[designId]/Steps.tsx`, `InspectStage.tsx`, `EmotesStep.tsx`
- Modify: `Preview.tsx` (the step row. On avatar keeps the shapes and outfits and loses the emote buttons. It renders Inspect, Emotes and Finalize by step), `SpinStage.tsx` (a `fps` prop, default 12), `Finalize.tsx` (the checklist, plus a `finalize-renders` call when the dialog opens), `client.tsx` (passes the step state through)
- Test: the helpers are covered in Task 7. The UI is checked in the browser in Step 3.

**Interfaces:**
- Consumes: Task 7's helpers and API calls.
- Produces:
  - `Steps`: `{ steps: Step[]; current: Step; onPick(step) }` as a `role="tablist"` row. Design scrolls to and focuses the composer.
  - `InspectStage`: `{ urls: string[]; label: string }`. It drags in 2D through `orbitDrag` and `orbitFrame`, and the arrow keys move one column or row. It shows `Loading more angles…` while `urls.length < 122`. Opening Inspect calls `requestStudioRender(..., { mode: 'orbit', bodyShape })` when the view is missing. Its body toggle is male or female.
  - `EmotesStep`: the emote buttons, each with its state; the body and outfit toggles; and `SpinStage` with the set view's `urls`, `loop` and `fps`. Under it are `Looks fine` and `I see clipping`:
    - **Clipping:** "I see clipping" is disabled while a prompt runs, and its refusals show inline.
    - **Being fixed:** an emote being fixed shows `Being fixed…`.
    - **Free fixes left:** the step shows `{n} free fix{es} left for this emote` from `freeFixesLeft`.
  - `Finalize` dialog: the text `You've checked {k} of {n}.` Each row is a button that closes the dialog and opens Emotes at that emote and body. Paying never depends on it.

- [ ] **Step 1: Build the components and wire `Preview.tsx` as above.**
- [ ] **Step 2: Type-check and test:** `cd apps/web && npx tsc --noEmit -p . && npx vitest run`. Expected: all pass.
- [ ] **Step 3: Check it in the browser** against the local stack. Use the dev server, a design seeded with ready rows, and the `run` skill's patterns:
  - Steps switch.
  - Inspect drags in both directions, and stops at the ring while only 24 frames exist.
  - Emotes play at their `fps`.
  - "I see clipping" posts, and the conversation shows the report.
  - The checklist count changes after "Looks fine".
  - Check it at 390 px wide too, with no horizontal scroll.
- [ ] **Step 4: Commit** `feat(web): studio preview steps, inspect from every angle, emote checks`

### Task 9: End to end on Fly

**Files:**
- Modify: `apps/studio-worker/e2e/real_prompt.py` (an orbit and walk render check after the existing build)
- Modify: `apps/studio-worker/e2e/fly.sh` if the run needs a flag

**Interfaces:**
- Consumes: everything above, as built into a worker image.

- [ ] **Step 1: Add the e2e checks.** After the real prompt builds the cap:
  - Run a full orbit render job, and save frames 0, 48 (60° row), 120 and 121.
  - Run a set render job for `run` on male. Save frames 0, 24, 48 and 72, and assert `fps` is 24.
  - Run a `fixClipping` job for `dance`. Assert `review/clipping/dance/00.png` existed, and that the outcome is `ok` or `no_change`.
- [ ] **Step 2: Build the image** from a worktree with the `.blend` assets copied in from `hud-test`: `fly deploy --build-only --push --remote-only --image-label <sha>`. Then run `bash apps/studio-worker/e2e/fly.sh registry.fly.io/vlm-studio-worker:<sha>`. Retry once on `MANIFEST_UNKNOWN`.
  - Expected: `E2E-PASSED`.
- [ ] **Step 3: Look at the saved frames.**
  - Frame 120 looks down on the cap's top, and 121 looks up into it (the underside).
  - The run frames show the cap on a running avatar from turning angles.
  - If `beta` turns out to be absolute rather than relative, fix `orbit_steps` and its test (Task 1), and record the ruling.
- [ ] **Step 4: Commit** `test(studio-worker): e2e covers orbit, set and clipping-fix renders`
