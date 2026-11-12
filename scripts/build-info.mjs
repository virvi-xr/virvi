#!/usr/bin/env node
// What this image was built from (LIV-165), printed as JSON for /app/build-info.json. Run inside the Docker build, where
// the build args are in the environment. Only public values: NEXT_PUBLIC_* are inlined into the website's JavaScript.
const env = process.env
const commit = (env.VIRVI_COMMIT || env.RAILWAY_GIT_COMMIT_SHA || '').trim() || null
const PUBLIC_ARGS = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_WSS_URL', 'NEXT_PUBLIC_DOCS_URL', 'NEXT_PUBLIC_DISCORD_URL', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'NEXT_PUBLIC_RELEASE']
const buildArgs = Object.fromEntries(PUBLIC_ARGS.map((k) => [k, env[k] ?? '']))
process.stdout.write(JSON.stringify({ commit, buildUrl: env.VIRVI_BUILD_URL || null, buildArgs }, null, 1) + '\n')
