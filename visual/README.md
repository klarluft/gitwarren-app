# Looking at the app without running it

```
npm run visual                    every shot, light
npm run visual -- --dark          every shot, dark
npm run visual -- --only browse-tree
npm run visual -- --width 900     the narrow layout
```

PNGs land in `visual/shots/`, which is gitignored.

## One-time setup

```
npx playwright-core install chromium-headless-shell
```

`playwright-core` is the dependency rather than `playwright` so that installing
this project never downloads 114 MB of browser onto a machine that will never
take a screenshot — CI included. The price is this one command, and running it
again after a `playwright-core` upgrade moves the revision it expects. The
harness says so when it happens rather than leaving Playwright's own banner to
be puzzled over.

## What it actually does

There is no server. `gitwarren serve --listen` binds 41427 on purpose and
forever (`shared/link-port.ts`), so a harness that wanted a real one would have
to fight whatever GitWarren you already have running.

Instead it goes in at the seam M1 drew. `window.gitwarren` is a carrier plus a
shell, and a carrier is one function; this is a third one, beside Electron IPC
and the WebSocket. Playwright exposes a function on the page, `visual/carrier.ts`
calls it, and on the other side is the *real* `dispatch` — against a real SQLite
database and a real git repository built by `visual/fixture.ts`. Nothing on the
screen is stubbed, and there is no port, no token and no socket in the way.

`visual/main.ts` is then `src/web/main.ts` with one word changed: install the
bridge, then import the same renderer. That is why `installBridge` takes a
carrier parameter.

## What it is not

It is not a visual-regression suite. Nothing compares against a baseline,
because a committed baseline of a UI under active design is a file somebody
re-blesses every time they move a border — and re-blessing is a habit that
outlives looking.

So the shots are artefacts, not fixtures: take them, look at them, throw them
away. `SHOTS_TO_TAKE` in `visual/capture.ts` describes *this branch* and is
meant to grow in the same commit as the screen it photographs. A shot naming a
control that does not exist yet fails the run, which is the right way round.

## The fixture

`visual/fixture.ts` builds the repository the shots are of, rather than
borrowing yours: paths deep enough to wrap a narrow column, two files sharing a
basename, enough changed files to cross the threshold where Files changed grows
a filter box, and one uncommitted edit so the head is a worktree and the banner
that says so is in shot. The same repository on every machine, so the only thing
that differs between two runs is the code under review.
