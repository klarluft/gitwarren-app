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
