#!/usr/bin/env bash
# `gitwarren serve` from source, against the seeded demo database, for the ad
# captures. Run from source the daemon calls itself `0.0.0-dev`, and the
# tailnet host's card would then offer an update to that; APP_VERSION gives it
# the version the host actually runs instead. Usage:
#
#   GITWARREN_DATA_DIR=<seeded dir> APP_VERSION=0.1.16 scripts/ad/serve.sh
set -euo pipefail
: "${GITWARREN_DATA_DIR:?point GITWARREN_DATA_DIR at the seeded demo database}"
export NODE_OPTIONS="--import data:text/javascript,globalThis.__APP_VERSION__='${APP_VERSION:-0.1.16}'"
cd "$(dirname "$0")/../.."
exec npx tsx src/cli/gitwarren.ts serve
