---
title: Checking what Virvi runs
description: How to check that virvi.io runs the code in the public GitHub repo, yourself or with an AI agent.
---

Virvi's code is public at [github.com/virvi-xr/virvi](https://github.com/virvi-xr/virvi). The [Transparency page](/transparency/) shows which commit production runs and how to check it.

## How a release is built

1. A commit lands on `main`.
2. GitHub Actions ([`.github/workflows/release.yml`](https://github.com/virvi-xr/virvi/blob/main/.github/workflows/release.yml)) builds the Docker image from that commit and pushes it to `ghcr.io/virvi-xr/virvi:<commit>`.
3. It signs a record of where the image came from (a build provenance attestation), and builds the website a second time from scratch to check that both builds give the same files.
4. Production deploys that image.

The image carries `build-info.json` (the commit, the CI run and the public `NEXT_PUBLIC_*` build settings) and the website's `release-manifest.json` (the SHA-256 of every website file). `GET /api/transparency` returns both.

## Checking it yourself

With Git, Docker, Node and the [GitHub CLI](https://cli.github.com/) installed:

```bash
git clone https://github.com/virvi-xr/virvi.git && cd virvi
bash scripts/verify-release.sh
```

The script:
- asks the server for its commit;
- runs `gh attestation verify` on the image;
- rebuilds the website from that commit, with the same public build settings;
- compares every file with the manifest the site serves and with the files themselves.

It prints PASS, or the files that differ.

## Checking it with an AI agent

The Transparency page has a short prompt to paste into an AI agent that can read GitHub and websites. It asks the agent to check four things:
- every place the code asks a wallet to sign something, so nothing can leave your wallet without your approval;
- every smart contract the code talks to;
- that the code matches the [privacy page](/privacy/);
- that the live commit is in the public repo.

## What it proves

- **The website runs in your browser,** so its files can be checked byte for byte against a rebuild.
- **Server code can't be inspected from outside.** What can be checked is that the image was built by the public CI from that commit and signed.
- **Not in the repo:** secrets, environment settings, and the services Virvi uses (Stripe, Cloudflare R2, Fly.io, Railway, email delivery).

## Reporting a security issue

Email support@virvi.io. See [`/.well-known/security.txt`](/.well-known/security.txt).
