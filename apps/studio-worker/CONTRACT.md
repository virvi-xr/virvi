# Studio worker contract

How a studio worker machine talks to Virvi's API. This file is the source of truth: `studio_worker/api.py` is the
worker's side, `tests/fake_api.py` implements Virvi's side for tests, and the server routes (Plan 3) implement it for
real.

One machine works on one design. It restores the design's workspace, takes that design's jobs one at a time, and
exits after `STUDIO_IDLE_EXIT_SEC` with no job, which stops the machine. The worker always pulls; Virvi never calls
the machine.

## Machine environment

| Variable | Meaning |
|---|---|
| `VIRVI_API_URL` | Virvi's API origin, such as `https://api.virvi.io`. Its host is added to the proxy allowlist. |
| `STUDIO_WORKER_TOKEN` | Bearer token scoped to this one design. Never handed to an agent, never logged. |
| `STUDIO_DESIGN_ID` | The design this machine works on. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | Fly secrets, held by the key proxy alone. The agents get a placeholder and talk to it on loopback. |
| `STUDIO_IDLE_EXIT_SEC` | Seconds with no job before the worker exits. Default 600. |

## Endpoints

All under `$VIRVI_API_URL/api/studio/worker`, with `Authorization: Bearer $STUDIO_WORKER_TOKEN`. A token for another
design gets 403. Path segments are URL-encoded.

| Call | Body | Answers |
|---|---|---|
| `GET /designs/{designId}/workspace` | | 200 with the workspace tar.gz, or 404 for a new design |
| `PUT /designs/{designId}/workspace` | the workspace tar.gz (`application/gzip`) | 2xx |
| `GET /designs/{designId}/jobs/next` | | 200 with a Job, or 204 when there is none. Handing out a job marks it taken. |
| `POST /jobs/{jobId}/events` | an Event (JSON) | 2xx |
| `PUT /jobs/{jobId}/files/{path}` | the file's raw bytes, with its content type | 2xx |
| `GET /jobs/{jobId}/inputs/{path}` | | 200 with the file's bytes. Only for a taken job, and only for the paths it lists: a finalize job's piece files, a prompt job's `uploads`. |
| `POST /jobs/{jobId}/result` | a Result (JSON) | 2xx; the job is finished |

The worker retries a call 3 times on a 5xx or connection error. It retries the result `POST` until it succeeds or
10 minutes pass. A 4xx is never retried. Virvi should time out a taken job that has no result after the job's
`limits.timeoutSec` plus 15 minutes.

### Workspace

A gzip tar with two top-level folders:

- `design/`: the agent's working files, `out/`, and the agents' session homes (`.claude-home/`, `.codex-home/`, `.grok-home/`). The
  agent owns this folder and can write anything in it.
- `state/`: the worker's own records, `state.json` (the conversation, sessions, running usage and the hashes of the
  pieces Virvi has). It lives outside the agent's reach, so an agent can't change what it's charged or what counts as
  changed.

Only regular files and folders are stored: a symlink the agent made is left out, and the worker refuses a workspace
holding links, absolute paths or `..`. The skills come from the image, never from a workspace. Virvi stores the
workspace as an opaque blob, privately.

### Files

| Path | What | Who may see it |
|---|---|---|
| `pieces/<category>/<name>_male.glb`, `_female.glb` or `<name>.glb` | a piece's GLBs | paid downloads only |
| `pieces/<category>/piece.json` | the piece's settings, as below | Virvi only |
| `checks/<category>.txt` | the skills checker's full report | Virvi only |
| `renders/<category>/<viewKey>/<nnn>.webp` | render frames, `000` up | the browser |
| `renders/set/<viewKey>/<nnn>.webp` | an emote view's frames, every piece worn together | the browser |
| `final/<category>/package.zip` | a paid revision's package (finalize jobs only, and the only file they upload) | paid downloads only |

Render frames are the only files the browser ever receives. A `viewKey` is `<mode>-<bodyShape>-<outfit>`, plus
`-<emote>` when the view plays a base emote: `spin-male-default`, `spin-female-outfit-2-dance`,
`emote-male-default`. Two modes differ:

- `orbit-<bodyShape>` (Inspect): the item alone, no avatar, from every angle. Frame `r * 24 + c` is column `c` (15°
  steps round from the front) of row `r`, the rows being camera elevations 90°, 60°, 120°, 30° and 150° (90° is eye
  level, 0° straight down). Frame 120 looks straight down and 121 straight up: 122 frames. A ring is frames 0–23
  only.
- `walk-<bodyShape>-<outfit>-<emote>` (an emote view, under `renders/set/`): the emote stepped through its timeline
  at 24 frames a second while the camera turns once round, over at least 4 s (a short emote loops) and at most 120
  frames. `<emote>` is `own` for an emote design's own animation.

## Job

```json
{
  "jobId": "job_123",
  "type": "prompt",
  "kind": "wearable",
  "agent": "claude",
  "model": "claude-opus-5-5",
  "prompt": "a neon cap with a glowing visor",
  "selectedSlots": ["hat"],
  "limits": {"timeoutSec": 1500, "maxTurns": 80, "costCeilingUsd": 3.0},
  "render": null
}
```

- `type`: `"prompt"` runs the agent; `"render"` renders a view of the current pieces; `"finalize"` builds the
  package of a paid revision of each listed piece, from that revision's own files (read with `inputs`, never the
  workspace), and saves no workspace.
- `kind`: `"wearable"` or `"emote"`.
- `agent`: `"claude"`, `"codex"` or `"grok"`; `model`: the model id the agent runs (`claude-opus-5-5`, `gpt-6.1-sol`,
  `grok-build-0.1`). Both are null on a render or finalize job.
- `selectedSlots`: the categories to build, or null when the user hasn't chosen yet. With null, the agent may answer
  with a slot proposal instead of building.
- `limits`: defaults `timeoutSec` 1500, `maxTurns` 80 (Virvi sends 150 for Grok, which counts each tool call as a
  turn), `costCeilingUsd` 3.0. Claude and Grok are stopped once their running cost passes the ceiling; Codex reports
  usage only at the end of a turn, so time alone caps it. Codex has no turn limit.
- `uploads`, on a prompt job: the files the owner uploaded for the design, `[{"path": "uploads/<id>/<name>", "name":
  str, "kind": "image" | "model"}]` (empty when there are none). Images are PNG, JPEG or WebP (Virvi turns other
  formats into PNG); models are GLB, VRM, FBX, OBJ, STL or .blend. The worker reads each through `inputs` into the
  workspace's `uploads/<name>` before the agent runs, replacing what was there, and the prompt names them. The folder
  is never saved with the workspace.
- `check`, on a prompt job: true when `prompt` is the user's own words. The worker then runs the scope check (Claude
  Haiku, `studio_worker/scope.py`) before anything else, and an off-topic message ends the job as `off_topic` without
  running the agent. False or missing for the server's own text (Continue, fixing the checks), which is never checked.
- `render`, on a render job: `{"categories": ["hat"], "bodyShape": "male"|"female", "outfit": "default"|"outfit-2"|
  "outfit-3", "emote": null|"idle"|"wave"|"dance"|"clap"|"walk"|"run"|"jump"}`. A wearable view is a 36-frame spin;
  an emote design's view is 36 frames through its animation. Two more shapes:
  - `{"categories": ["hat"], "bodyShape", "mode": "orbit", "ring": bool}`: a wearable's Inspect view, `orbit-<shape>`,
    122 frames (24 with `ring`).
  - `{"set": true, "bodyShape", "outfit", "emote": <base emote>|"own"}`: every current piece worn together in a
    walk-around, uploaded to `renders/set/<viewKey>/`. The result carries `set` and an empty `pieces`.
- `fixClipping`, on a prompt job: `{"emote": <base emote>|"own", "bodyShape", "outfit"}` when the prompt is the
  server's free clipping fix. Before the agent runs, the worker writes 16 frames of that emote, every piece worn, to
  `review/clipping/<emote>/NN.png`, and the prompt tells the agent to open them first and to check its fix with
  `studio-preview <pieces> --emote <emote> --body <shape> --outfit <outfit>`. If the frames can't be rendered, the
  job ends `error` without running the agent.

- `finalize`, on a finalize job: `{"designName": str, "pieces": [{"category", "name", "revision": n, "files":
  [contract paths]}]}`. `files` are the paid revision's files (its GLBs, `piece.json` and checker report). Virvi may add
  fields of its own (such as `sourceJobId`); the worker ignores them. `limits` is `{"timeoutSec": 1800, "maxTurns": 0,
  "costCeilingUsd": 0}`: no agent runs.

Switching agent between prompts is allowed: the new agent is given the conversation it missed.

## Event

```json
{"type": "phase", "phase": "building"}
{"type": "progress", "text": "Running: blender -b /opt/assets/AvatarShape_A.blend --python build_cap.py"}
```

A prompt job's phases come in order: `building`, `checking`, `rendering` (only when a piece changed), `saving`. A
render job sends `rendering`. Progress texts are the agent's messages and the commands it runs. Events are best
effort: one that fails to send is dropped.

## Result

```json
{
  "jobId": "job_123",
  "outcome": "ok",
  "agent": "claude",
  "model": "claude-opus-5-5",
  "skillsSha": "3430ce2ef5b7f9d388fcb7c923f50e0dcb505420",
  "wallSec": 412.3,
  "tokens": {"input": 2100, "cachedInput": 820000, "cacheWrite": 61000, "output": 18000},
  "costUsd": 0.74,
  "reply": "I built a rounded cap with a neon visor strip...",
  "proposal": null,
  "pieces": [
    {
      "category": "hat",
      "changed": true,
      "changeKind": "new",
      "meta": {"name": "Neon Cap", "description": "...", "category": "hat", "hides": [], "replaces": [],
               "tags": ["cyberpunk"], "changeKind": "new"},
      "checker": {"pass": true, "failures": 0, "warnings": 1},
      "files": ["pieces/hat/neon_cap_male.glb", "pieces/hat/neon_cap_female.glb", "pieces/hat/piece.json",
                "checks/hat.txt"],
      "renders": {"spin-male-default": 36}
    }
  ],
  "error": null,
  "scope": null
}
```

`outcome`:

| Outcome | When |
|---|---|
| `ok` | at least one piece changed, and every changed piece rendered |
| `needs_input` | the agent wrote a slot proposal (`proposal` is set); nothing was rendered |
| `no_change` | the agent finished without changing any piece's GLBs |
| `off_topic` | the scope check turned the message down: the agent didn't run and nothing was saved. `scope` is set; `costUsd` is the check's |
| `declined` | the agent wrote `out/declined.json` and changed no piece: it stopped on a request that isn't design work. `scope` is set |
| `ceiling` | Claude was stopped at the cost ceiling |
| `timeout` | the agent was stopped at the time limit |
| `turns` | the agent reached the prompt's turn limit (`limits.maxTurns`); Continue resumes it |
| `error` | anything else; `error` says what. Includes a wrong output layout (GLBs outside `out/<category>/`, a piece file that is a link), a failed render, and a workspace that couldn't be saved. |

- **Pieces are keyed by category.** A design holds at most one piece per category, and an emote design has the one
  category `emote`. `pieces` lists every piece in the design (none on `ceiling`, `timeout`, `turns`, a wrong layout or a failed save).
- **A piece's `files` and `renders` are set only when this job uploaded it.** An unchanged piece has empty lists, and
  the files Virvi already has for it stand. A changed piece is uploaded only once it has rendered and no proposal is
  pending; until then it stays "changed", so a later prompt uploads it. Files are never uploaded by a job whose
  result is not `ok`, apart from a render failure on another piece of the same job.
- `scope`: `{"by": "check" | "agent", "category": "coding" | "writing" | "research" | "chat" | "other", "note": str}`
  on `off_topic` and `declined`, null otherwise. `note` (at most 120 characters) is for the owner's log only, never
  shown to the user. `costUsd` on any checked prompt includes the check's cost.
- `changeKind`, from the agent: `"new"`, `"fix"` (a fix to a published piece) or `"design"` (a design change).
- `checker.pass` false means the skills checker found a FAIL. The piece is still reported.
- `costUsd` and `tokens` are this prompt's share only, even when the agent resumed a session. They are null for a
  render job.
- **The workspace is saved before the result is posted.** If the save fails, the outcome is `error` and `pieces` is
  empty: nothing claims the revision is saved.
- On a render job, `pieces` holds `{"category", "renders": {viewKey: frames}}` for each requested category. On a
  set render job `pieces` is empty and `set` is `{"viewKey", "frames", "fps"}` (absent unless the outcome is `ok`).
- On a wearable prompt, each uploaded piece's `renders` holds `spin-male-default` (36) and the Inspect ring
  `orbit-male` (24).

### Finalize result

On a finalize job `costUsd` and `tokens` are null, and `pieces` holds, for each piece that was packaged:

```json
{"category": "hat", "files": ["final/hat/package.zip"],
 "finalize": {"thumbnail": {"pass": true}, "listing": {"pass": true}, "clipping": {"pass": false, "failed": ["Dance"]},
              "emoteCheck": null}}
```

`listing` and `clipping` are null for an emote, `emoteCheck` (`{"pass"}`) is null for a wearable. `outcome` is `ok`
when every listed piece was packaged, else `error` (with `error` saying which and why); the pieces that did package are
still listed. A check that fails (thumbnail, listing, clipping) is reported in the package, never fatal: the customer
has paid. A tool that crashes, a failed render or a missing input fails that piece.

### Package

`package.zip` holds, at its top level:

| File | What |
|---|---|
| `<name>_male.glb`, `<name>_female.glb` or `<name>.glb` | the GLBs, as built |
| `thumbnail.png` | 256 px, transparent background (wearables: the item alone, rendered in Blender; emotes: the avatar mid-emote) |
| `builder.json` | `{"name", "category", "hides", "replaces", "tags"}`: the Builder's settings |
| `listing.json` | `{"name", "rarity", "description", "tags"}` (wearables) |
| `item.zip` | the Builder upload, from the skills' `package_item.py` (wearables) |
| `renders/<bodyShape>-<front|right|back|left>.png` | 1024 px renders in Decentraland's own renderer |
| `promo.mp4` | a 3-second clip: a wearable spins on the dancing avatar; an emote plays |
| `REPORT.md` | the curation report |

`REPORT.md` has a section per check: the wearable checker (or the emote checker), the thumbnail, the listing and
clipping through Decentraland's animations (wearables). It ends with "Not run here", saying what the customer does for
each gate the studio can't run: upload `item.zip` in the Builder, check the Builder's preview, self-preview in-world
in the desktop explorer, and Decentraland's `wearable-validator`.

`piece.json` (written by the agent while building) also carries, for a wearable, `"rarity"`: one of the Builder's
rarities. Its `description` is at most 64 characters, and `name`, `description`, `tags` and `rarity` follow the
`listing-dcl-wearables` skill.

### Proposal

```json
{"slots": [{"category": "hat", "recommended": true, "reason": "the visor is the idea"},
           {"category": "eyewear", "recommended": false, "reason": "goggles would match"}]}
```

These become the tick-boxes. The user's choice comes back as the next prompt job's `selectedSlots`.
