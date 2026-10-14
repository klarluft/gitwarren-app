# Notes for coding agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) first - its pull request expectations
apply to agents exactly as they do to people. What follows is what an agent
tends to skip.

## Pull requests show what they change

Any pull request that changes something a person can see gets screenshots, and
anything that moves - a scroll, an animation, a transition - gets a short video
or GIF. Reviewing a picture takes seconds; reviewing the same change from the
diff alone is slow and misses things. If a change has no visible effect, say so
in the description instead of leaving the reviewer to wonder.

- Capture the real app, not a mock-up: build, launch Electron with
  `--remote-debugging-port`, and drive it with the helpers in `scripts/cdp.mjs`.
  Point `GITWARREN_DATA_DIR` at a scratch directory and pass a scratch
  `--user-data-dir`, so neither the real database nor an already-running
  GitWarren is touched.
- Show light and dark when colours are involved, and before and after when the
  change is to something that already existed.
- Images are not committed to the branch under review. Push them as a commit of
  their own to a `pr-assets/<topic>` branch, with the files at its root, and
  embed them from that commit's SHA:
  `https://raw.githubusercontent.com/klarluft/gitwarren-app/<sha>/<file>.png`.
  Pinning the SHA keeps the images in the description stable even if the
  branch moves.
- Say what each picture is showing in a line above it. A screenshot without a
  caption makes the reviewer guess which part of it changed.

## Every UI change works on a phone too

GitWarren is used from phones - the web build is served over the tailnet - so a
change is not done until it has been checked at a phone's size, and the pull
request shows it there as well as on the desktop.

- Check at a phone viewport, 390×844, with touch emulated - not a narrowed
  desktop window. Over CDP that is `Emulation.setDeviceMetricsOverride`
  (`mobile: true`), `Emulation.setTouchEmulationEnabled`, and
  `Emulation.setEmulatedMedia` with `hover: none` and `pointer: coarse`, so the
  `(hover: none)` styles the app relies on actually apply. Drive it with
  `Input.dispatchTouchEvent`, not mouse events.
- Attach mobile screenshots beside the desktop ones, and a GIF for any gesture.
- Everything that can be done on the desktop must be doable on a phone. Smaller
  elements are fine, and so is rearranging the layout for a narrow screen -
  dropping a label to its icon, wrapping a row, moving something behind a
  screen of its own. Losing a capability is not. Hover in particular does not
  exist on a phone: anything a hover reveals needs a touch way to reach it.
- Touch targets can be smaller than they look, but not smaller than a thumb:
  extend the hit area with an invisible pseudo-element rather than making the
  control bigger.
- Nothing on the page may scroll sideways at 390px except code, inside its own
  container.
