#!/usr/bin/env bash
# A Chrome with a debugging port and nothing else in it, for the ad captures.
# The scratch profile keeps it to one tab, which is the one the storyboard
# attaches to. Usage: scripts/ad/chrome.sh '<the URL serve printed>'
set -euo pipefail
PROFILE="${CHROME_PROFILE_DIR:-${TMPDIR:-/tmp}/gw-ad-chrome}"
exec '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --remote-debugging-port="${CDP_PORT:-9222}" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --window-size=1200,760 \
  "$1"
