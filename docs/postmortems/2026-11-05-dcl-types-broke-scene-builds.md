# Post-mortem: `@virvixr/dcl` types broke every scene that installed it

**Date found:** 2026-11-05 · **Status:** fix built and verified as `@virvixr/dcl` 2.10.1; publish waiting on the owner's npm one-time code · **Severity:** high (a core feature could not work at all; no data lost)

## Summary

Every published version of `@virvixr/dcl` from 2.4.0 (2026-10-28) to 2.10.0 shipped a `dist/index.d.ts` that imported three packages that are not on npm: `@virvixr/core`, `@virvixr/adapter-dcl` and `@virvixr/shared`. A Decentraland scene's build type-checks its dependencies, so any scene that installed the package failed with four `TS2307: Cannot find module` errors and never built.

Scene Import installs the package into every uploaded scene, so **every Scene Import build failed**, for Creator Hub and SDK7 scenes alike. Anyone who followed the install guide (`apps/docs/.../sdk/decentraland/install.md`, `packages/dcl/README.md`) by hand hit the same wall.

## Impact

- **Scene Import:** no import could ever reach the Deploy step. In production that held from the moment the rollout steps (`docs/scene-import-rollout.md`) were completed, if they have been. We don't know whether any real user tried.
- **Manual installs:** creators who `npm install @virvixr/dcl` per the docs got a scene that wouldn't build. npm counted 697 downloads between 2026-10-28 and 2026-11-05 (bots and mirrors included). We had no report of it, which is itself a signal (see "Why nobody told us").
- **Not affected:** Worlds built by Virvi's wizard and HUD redeploys. They use the prebuilt runtime (`apps/server/dcl-runtime/<n>/bin/index.js`), which is the bundled JavaScript only and is never type-checked against the npm package. This is why Virvi's own deploys kept working and hid the problem.

## Timeline (UTC)

| When | What |
|---|---|
| 2026-10-28 14:06 | 2.4.0, the first real release, is published with the broken type file. |
| 2026-11-01 | Scene Import lands: `installVirvi` adds `@virvixr/dcl` to uploaded scenes, and the build box runs `npm install` then `sdk-commands build --production`. All tests use stand-ins (see below). |
| 2026-11-04 → 11-06 | 2.7.0, 2.8.0, 2.9.0 and 2.10.0 are published; each carries the same type file. |
| 2026-11-05 | While filming the Scene Import tutorial on a local copy with the real build runner, every import build fails. The build log shows the four `TS2307` errors in `node_modules/@virvixr/dcl/dist/index.d.ts`. Confirmed on npm for 2.4.0 to 2.10.0. |
| 2026-11-05 | Fix written and tested (`f6b88dc`), 2.10.1 built from the 2.10.0 release commit plus the fix, and checked end to end: the tutorial's rooftop scene builds with "Type checking completed without errors". |
| (pending) | 2.10.1 published. Scene Import's `^2.8.0` range picks it up on the next build, with no server deploy. |

## Root cause

`packages/dcl` builds in two halves that disagreed about what "self-contained" means:

- **The code** is bundled by esbuild (`build.mjs`, `bundle: true`), which inlines the workspace packages. `dist/index.js` needs nothing but `@dcl/*` and `~system/*`.
- **The types** were whatever `tsc` emitted: one `.d.ts` per source file, keeping every `import ... from '@virvixr/...'` as written. Those packages are `workspace:*` dev dependencies and have never been published.

So the JavaScript worked anywhere, and the types worked only inside this monorepo, where the workspace packages are linked in `node_modules`.

## Why it wasn't caught

Each of these alone would have stopped it; none was in place.

1. **Nothing ever consumed the published artifact.**
   - The package's own tests exercise `bin/sync.mjs` and never touch `dist/`.
   - Inside the monorepo, the workspace links make the broken imports resolve, so local type checks pass.
   - No step packed the package and installed it somewhere outside the repo.
2. **The Scene Import tests used stand-ins at every layer that would have shown it.**
   - `import-build.test.ts` and `import-routes.test.ts` use a fake build runner.
   - The build box's `smoke.sh` builds a hand-made scene with a pre-written `bin/index.js` and never runs `npm install` or `sdk-commands build`.
   - No test sent the output of `installVirvi` through a real build.
3. **Virvi's own deploys don't use the npm package's types.** Wizard and HUD deploys ship the prebuilt runtime, so every scene Virvi built looked healthy.
4. **There is no CI**, and the package's `build` script is a no-op ("skip in CI, build locally"). `prepublishOnly` bundled but didn't test.
5. **Releases are cut from `main`**, so the release step gets no check of its own. We also found that `main` already held unreleased work (005c696, the HUD click-action editor) after 2.10.0. A patch published straight from `main` would have shipped that work too.
6. **Why nobody told us:** a scene that won't build looks to a creator like their own setup problem. There was no in-product signal, and Scene Import's failure only surfaced in a build log.

## What we changed (done)

- **Self-contained types** (`f6b88dc`): `build.mjs` now bundles `dist/index.d.ts` with `rollup-plugin-dts`, inlining Virvi's workspace packages just as esbuild does for the code. Only `@dcl/*` and `~system/*` stay as imports. The JavaScript output is unchanged.
- **A test that consumes the real artifact** (`packages/dcl/test/published-types.test.mjs`):
  - It bundles the package, then runs `npm pack`, the same step `npm publish` uses.
  - It `npm install`s the tarball beside the pinned `@dcl/sdk` in an empty folder.
  - It runs `tsc` with Decentraland's scene tsconfig.
  - It also fails if the type file imports anything a scene doesn't have.
  - Against 2.9.0/2.10.0 it reports exactly the four production errors.
- **No publish without tests** (`4fa4dea`): `prepublishOnly` is now `pnpm run bundle && pnpm test`.
- **2.10.1 built from a release commit** (`bbdb05d`, on the `.worktrees/dcl-2.10.1` worktree): 2.10.0's release commit plus the fix. Its `dist/index.js` is byte-identical to 2.10.0, so the only change users get is the type file.

## What we should change (proposed)

Ordered by how much risk each removes for its cost.

| # | Action | Why | Owner |
|---|---|---|---|
| 1 | **A real end-to-end Scene Import test.** Run `installVirvi` on a minimal Creator Hub fixture and a minimal SDK7 fixture, then run the build box's `build.mjs` locally against them. Assert the build succeeds and `bin/index.js` exists. Run it before any release of `@virvixr/dcl`, the scene builder image or `install-virvi.ts`. | It's the test that would have caught this on 11-01, and it guards the whole pipeline, not just the types. | Scene Import |
| 2 | **Change `smoke.sh` to build a real scene**, with `npm install` and `sdk-commands build`, instead of a pre-written `bin/index.js`. | The Fly smoke test is run on every new image; it should prove the image can build. | Scene Import |
| 3 | **Add CI** (GitHub Actions) running `pnpm test` on every push to `main`, including `packages/dcl`. | Today every check depends on someone remembering to run it locally. | Repo |
| 4 | **Release from tags, not `main`.** Cut each `@virvixr/dcl` release from a `release/dcl-x.y` branch or tag, and patch from there. | Releases ship exactly what was tested, and fixes don't drag in unreleased work. | Releases |
| 5 | **Check after publishing.** Install the just-published version from the registry into an empty scene and build it. A small script `packages/dcl/scripts/verify-published.sh <version>` is enough. | It catches anything `npm pack` and the registry disagree on (files, `exports`, dist-tags). | Releases |
| 6 | **Surface build failures in the product.** Show the first error line of a failed import build on the Import page, and alert us when import builds fail. | Users saw a generic "didn't build". A spike of identical failures should page us, not wait for a video shoot. | Scene Import |
| 7 | **Test the install guide's steps.** The published-types test follows the install guide's commands; keep the two in step when either changes. | The docs were the other door into the same bug. | Docs |

## Lessons

- **Test what you ship, not what you build.** The monorepo's workspace links hid the bug; only a consumer outside the repo could see it.
- **Every stand-in in a test is a place a real failure can hide.** The import pipeline had stand-ins at exactly the two steps where this broke: `npm install` and the build.
- **"It works for our own deploys" proved nothing about the package.** Our deploys used a different artifact, the prebuilt runtime, from the one creators install.
