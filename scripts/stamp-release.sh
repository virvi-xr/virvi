#!/usr/bin/env bash
# Stamps the checkout's commit SHA into RELEASE before `railway up`, so error reports (LIV-66) know which build they
# came from: `railway up` from a local checkout passes no RAILWAY_GIT_COMMIT_SHA. Run from the checkout being deployed:
#   bash scripts/stamp-release.sh && railway up . --path-as-root -s virvi-server --ci
# `git checkout -- RELEASE` puts the committed 'dev' placeholder back.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git rev-parse --short=12 HEAD > RELEASE
echo "RELEASE=$(cat RELEASE)"
