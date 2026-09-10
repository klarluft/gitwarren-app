# GitWarren across hosts

*Design and implementation plan. Draft of 10 September 2026, baseline 0.1.6.*

Review code that lives on another machine, from whichever machine you are
sitting at, with the agent working next to the code. One person, their
machines, their agents, no one else's server.

Scope: a single user. Two shells (the Electron app and a browser). Sharing with
other people is a non-goal.

This file is the source of truth for the work. Spike results and changed
decisions are written back here as they happen.

---

## Contents

- [The model in six rules](#the-model-in-six-rules)
- [What runs where](#what-runs-where)
- [Spikes first](#spikes-first)
- [Milestones](#milestones)
- [Agent setup](#agent-setup)
- [Decisions already made](#decisions-already-made)
- [Non-goals](#non-goals)
- [Where each known gap is closed](#where-each-known-gap-is-closed)

---

## The model in six rules

Every decision below follows from these. When a new question comes up during
the build, check it against this list before inventing a mechanism.

1. **A host owns its repositories.** SQLite, git and the MCP server for a repo
   live on the machine the repo is on. Reviews never move.
2. **Nothing syncs.** The GUI is a window onto hosts. It caches nothing across
   a disconnect; a host that is offline is shown as offline.
3. **One protocol, several carriers.** A message protocol (requests,
   responses, events) runs unchanged over a child-process pipe, `wsl.exe`,
   `ssh`, or a WebSocket.
4. **Links resolve where they are clicked.** Loopback links name the host in
   the fragment and open on whichever GitWarren the user clicked from. A
   tailnet link is offered in addition when a host listens.
5. **Identity is a principal, not a string.** The local user is a principal;
   Tailscale supplies the same principal on every device. Authorisation is
   "same login as the owner".
6. **Agents never cross the network.** MCP stays stdio, local to the host,
   reading real paths. The daemon is for humans elsewhere.

## What runs where

| Machine | Runs | Reached by | Installed by |
| --- | --- | --- | --- |
| Mac, Windows, Linux desktop | The GUI app, resident in the tray — or, without Electron, `gitwarren serve` and a browser tab; owns local repos; optional tailnet listener | Its own window; other GUIs over the tailnet | User, as today |
| WSL distro | Headless daemon (`gitwarren serve --stdio`) | Windows GUI over `wsl.exe`; other GUIs over SSH or tailnet if Tailscale runs inside the distro | The Windows app, automatically |
| VPS / any SSH box | Headless daemon; optional service with listener | GUI over `ssh host gitwarren serve --stdio`, spawned on demand | The GUI over SSH on first use, or by downloading the daemon tarball from a release |
| Phone | Nothing | Browser to a listening host's web view over the tailnet | — |

The only always-on process is a tray app, and a service on a headless host is
opt-in. On every host, Claude Code and friends keep launching `gitwarren-mcp`
over stdio exactly as now.

## Spikes first

Six assumptions the plan rests on. Each is a day or less, has a pass/fail, and
names what changes on fail. Do them before M1; none produce shippable code.
Record the outcome under each one.

### S1 — Tailscale inside WSL, Tailscale SSH from the Mac into it

- **Question.** Can the Mac reach a daemon in WSL as a first-class tailnet
  node, with `tailscale status --json` and `whois` working inside the distro?
- **Pass.** `ssh <wsl-node> true` from the Mac with Tailscale SSH;
  `tailscale status` inside WSL lists the Mac.
- **On fail.** Run `sshd` in WSL and reach it through the Windows host's
  tailnet IP (mirrored networking), or place the daemon on the Windows side and
  reach WSL from there (the M5 path).
- **Outcome.** *Pass, 10 September 2026. Windows 11, WSL2 Ubuntu, Mac on the
  same tailnet.* Tailscale 1.102.3 runs inside the distro as its own node,
  `pc-wsl.tail688c0c.ts.net` / `100.78.0.23`, distinct from the Windows host's
  `100.96.73.13`. systemd was already enabled (`/etc/wsl.conf` carries
  `systemd=true`) and networking mode is NAT, so the fallback's mirrored
  networking is not needed: Tailscale running *inside* the distro is enough to
  make it a first-class node. After `sudo tailscale up --ssh`, from the Mac:

  ```
  $ ssh xfor@pc-wsl true; echo "exit=$?"
  # Tailscale SSH requires an additional check.
  # To authenticate, visit: https://login.tailscale.com/a/lbaadd3d30abde
  # Authentication checked with Tailscale SSH.
  exit=0
  ```

  Inside WSL, `tailscale status` lists the Mac as `100.96.164.43 mac
  michal-wrzosek@ macOS active; direct 192.168.178.155:41641`, and `tailscale
  whois 100.96.164.43` returns `mac.tail688c0c.ts.net` with user
  `michal-wrzosek@github`. Three things M4 has to account for:

  - **The SSH target carries the Unix user.** Bare `ssh pc-wsl` requests the
    *client's* username and is refused with `tailscale: tailnet policy does not
    permit you to SSH as user "michalwrzosek"`. The `hosts` row must store
    `xfor@pc-wsl`; the MagicDNS name alone is not a usable target.
  - **The default SSH policy is `"action": "check"`**, which sends the user to a
    browser roughly every twelve hours. Fine for a human, fatal for a carrier
    spawned on demand. With the tailnet rule changed to `"action": "accept"` the
    same command returns `exit=0` with no prompt. The Hosts screen should say so
    when a check-mode denial is what failed.
  - **`tailscaled` wins port 22 on the tailnet** even with `sshd` bound to
    `0.0.0.0:22`, so the fallback's `sshd` can stay installed alongside
    Tailscale SSH without a `ListenAddress` change.

### S2 — `wsl.exe` stdio from an Electron main process on Windows

- **Question.** Is the pipe clean (UTF-8, no console window, no CRLF mangling)
  when Electron spawns `wsl.exe -d Ubuntu -- cat` and round-trips JSON lines?
- **How.** `node scripts/spikes/s2-wsl-stdio.mjs --distro Ubuntu --mb 10` on
  the PC.
- **Pass.** 10 MB of newline-delimited JSON round-trips byte-exact with
  `windowsHide: true`, and a small line round-trips well under 10 ms.
- **On fail.** Daemon binds a localhost port inside WSL; Windows connects over
  TCP (WSL2 forwards localhost by default).
- **Outcome.** *Pass, 10 September 2026.* Run by Windows Node v24.19.0 — the
  distro's own Node is v22.12.0 and was not used — spawning `wsl.exe -d Ubuntu
  -- cat` with `windowsHide: true`:

  ```
  > node C:\Users\micha\s2-wsl-stdio.mjs --distro Ubuntu --mb 10
  small line round trip: median 0.19ms, min 0.16ms, max 29.97ms
  bulk: 49696 lines, 10 MB in 0.19s (52.4 MB/s)
  PASS: all 49716 lines identical

  > node C:\Users\micha\s2-wsl-stdio.mjs --distro Ubuntu --mb 50
  small line round trip: median 0.19ms, min 0.16ms, max 29.65ms
  bulk: 248478 lines, 50 MB in 0.89s (56.1 MB/s)
  PASS: all 248498 lines identical
  ```

  Byte-exact both times, including the emoji outside the BMP, the Polish
  diacritics and the escaped CR/LF inside the JSON strings: no encoding or
  newline translation on the pipe. The median round trip is some fifty times
  under the 10 ms bar. The ~30 ms maximum is the first trip of each run —
  `wsl.exe` process start — and does not recur, so M5 pays it once when the
  carrier starts rather than on every request.

### S3 — The self-contained daemon tarball

- **Question.** Build `gitwarren-daemon-<version>-linux-x64.tar.gz` containing
  a Node binary, `serve.cjs`, the MCP `server.cjs` and the matching
  `better_sqlite3.node`; same for linux-arm64. Does it run with nothing
  installed?
- **Pass.** `./node serve.cjs --stdio` answers a request in a fresh Ubuntu
  container and on an arm64 box, and the MCP server starts from the same
  directory.
- **Output.** Tarball size (expect ~30 MB compressed per platform), the CI job
  that builds them alongside a release, and confirmation that the
  Electron-binary-as-Node trick from `src/main/mcp-launch.ts` is *not* usable
  on a display-less box, so this is the only path.
- **Outcome.** *Pass, 10 September 2026.* `scripts/spikes/s3-daemon-tarball.mjs`
  builds `gitwarren-daemon-0.1.6-linux-{x64,arm64}.tar.gz`, 44 MB each with
  gzip (xz would be about 28 MB but needs `xz` on the host; gzip is
  everywhere). Contents: the official Node 24.20.0 binary, `server.cjs` from
  `npm run build:mcp`, the one matching `better_sqlite3` prebuild — which
  better-sqlite3 13 already ships in `node_modules/better-sqlite3/prebuilds/`
  for both Linux arches, so nothing is compiled — the drizzle migrations, and
  a `bin/gitwarren-mcp` launcher that sets `GITWARREN_MIGRATIONS_DIR`.

  In a bare `ubuntu:24.04` container with no Node, arm64 natively and x64
  under emulation on the Mac, `bin/gitwarren-mcp` answered an MCP
  `initialize` and exited 0:

  ```
  [gitwarren-mcp] ready (database: /root/.config/GitWarren/gitwarren.db)
  {"result":{"protocolVersion":"2025-06-18",…,"serverInfo":{"name":"gitwarren","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
  ```

  So Node ran, the addon loaded, the database was created and migrated, and
  the protocol answered. The daemon will run wherever this does. Two notes for
  M2–M4: the Electron-binary-as-Node trick was not tried on Linux because the
  tarball makes it moot; and the CI job is the same script per target,
  attached to the release — not yet written.

### S4 — Editor deep links to remote files

- **Question.** Does `vscode://vscode-remote/ssh-remote+host/path:42` land on
  line 42 in current VS Code and Cursor? Same for `wsl+Ubuntu`.
- **Pass.** Both editors open the file at the line from `shell.openExternal`.
- **On fail.** Use the CLI form `code --remote ssh-remote+host --goto path:42`,
  which `src/main/editors.ts` already knows how to spawn.
- **Outcome.** *URL forms pass; the CLI fallback needs more than the plan
  assumed. 10 September 2026, VS Code 1.136.2 and Cursor 0.40.4 on Windows 11,
  repo at `/home/xfor/github.com/klarluft/gitwarren-app`.* Both URL forms,
  opened with `Start-Process`, put the cursor on line 5 of `README.md` in a
  window connected to `WSL: Ubuntu`:

  - `vscode://vscode-remote/wsl+Ubuntu/<path>/README.md:5` — VS Code. On a cold
    start the window appears empty, already labelled `WSL: Ubuntu`, for several
    seconds before the file and the line arrive. `shell.openExternal` needs no
    retry, but the user sees a blank editor first.
  - `cursor://vscode-remote/wsl+Ubuntu/<path>/README.md:5` — Cursor, same
    result.

  `code --remote wsl+Ubuntu --goto <path>/README.md:5`, run by Windows VS Code,
  also honours the line and is the form `src/main/editors.ts` should prefer on
  Windows.

  The `code` shim *inside* the distro honours the line too, but not as a daemon
  would spawn it:

  - Bare invocation fails with `Command is only available in WSL or inside a
    Visual Studio Code terminal.` It needs `VSCODE_IPC_HOOK_CLI` set to a live
    `/run/user/<uid>/vscode-ipc-*.sock`, which VS Code exports only into its own
    integrated terminal.
  - Both editors create sockets under that same `vscode-ipc-*` name, and the
    name says nothing about the owner. Choosing the most recent one drove
    *Cursor* from the `~/.vscode-server` shim. The socket has to be matched to
    the editor by reading the owning process's exe path — `~/.vscode-server`
    against `~/.cursor-server`.
  - The shim path moved from `e4c7e7b1…` to `88e44fa0…` mid-spike, when VS Code
    updated its server. It must be globbed at
    `~/.vscode-server/bin/*/bin/remote-cli/code`, never cached.

  There is also no `code` on `PATH` in a plain WSL shell here, so spawning a
  bare `code` inside the distro is not an option.

### S5 — How chatty is a screen today?

- **Question.** Count IPC calls and their dependency depth for: the repository
  list, opening a review, the files tab.
- **How.** Start the app with `GITWARREN_TRACE_IPC=1`; every call is logged
  with its duration.
- **Output.** A number per screen and the list of calls that could be one. Sets
  the coarse endpoints in M1. Target: opening a review costs at most three
  sequential round trips.
- **Outcome.** *Target already met, 10 September 2026, macOS, the seeded demo
  database (3 repositories, review 1 with 5 threads), driven over CDP.* Calls
  per screen, with start offsets showing which ones wait on which:

  | Screen | Calls | Sequential depth | Notes |
  | --- | --- | --- | --- |
  | Home, cold load | 3 | 1 | `repositories:list` (53 ms) plus two trivial `system`/`updates` reads |
  | Review → conversation tab | 4 | 2 | `reviews:get`, `comments:list`, `reviews:commits` (93 ms), `reviews:diff` (105 ms); diff starts 29 ms after get |
  | → commits tab | 0 | — | already fetched |
  | → files tab | 3 | 1 | `reviewedFiles`, `system:editors`, `comments:list`; the diff is reused |
  | Back to home | 2 | 1 | `repositories:list` again, as designed (nothing is cached) |
  | Review files tab, cold load | 11 | 2 | `reviews:get`, `comments:list`, `system:editors` and `reviewedFiles` each fetched **twice** - a second wave 45 ms after the first, on the same keys. *The doubling was the spike script; see the amendment below.* |

  The renderer is already coarse: the heavy calls are `commits` and `diff` at
  ~100 ms each locally, and everything else is under 5 ms. A network carrier
  adds one round trip per level of depth, so the two-deep review open costs
  about 2 × RTT plus the git work, which is fine. What M1 should actually fix:

  - the duplicated wave on a cold review load (same SWR keys fetched twice
    within 45 ms - a remount or a key that is not stable across the first
    render), which doubles the cost over a network for no benefit;
  - `system:appInfo` and `system:editors` refetched on navigation, which are
    static for the life of the process;
  - fold `reviews:get` + `comments:list` + `reviewedFiles` into one
    `reviews.open(id)`, taking the review open from depth 2 to depth 1; keep
    `commits` and `diff` as their own calls, since they are heavy, independently
    refreshed, and already run in parallel.

  Not measured here: the 15-second comment poll, which over a network becomes
  one request per open review per host every 15 s until M6 replaces it with
  events.

  **Amended during M1.** The first of those three findings was not the app. The
  spike script set the location hash and *then* reloaded, so the screen mounted
  twice - once on the hashchange, once on the new document - and every key was
  fetched twice about 40 ms apart. That is the "duplicated wave", and it is a
  measurement of the navigation helper. Re-measured against the pre-M1 build
  with the helper fixed (it now navigates for real, so a cold load is one
  document and one mount), the cold review load is seven calls with nothing
  duplicated. The other two findings were real and are confirmed in the M1
  numbers below: `system:appInfo` was re-read on every return to the home
  screen, `system:editors` on every visit to the files tab, and the review open
  was two deep. Worth keeping in mind for the spikes still to come: a number
  produced by driving the app is a number about the driver too.

### S6 — The fixed loopback port

- **Question.** Pick a port outside common ranges, check it is free by default
  on macOS, Windows and Ubuntu, and define behaviour when it is taken (the
  Agent Access panel warns; links are still emitted).
- **Output.** One constant in `src/shared/` and a sentence for the README.
- **Outcome.** *Port 41427.* Chosen
  because it is outside every default ephemeral range (Windows and macOS use
  49152–65535, Linux 32768–60999), absent from `/etc/services`, not on
  Chromium's restricted-port list (which would make a browser refuse the
  loopback link), and unclaimed by any well-known service. Free on this Mac
  and on a default Ubuntu, which listens on nothing in that range.

  Windows is the one to check: Hyper-V and WSL reserve blocks of ports at
  boot, and the blocks move. On the PC, in PowerShell:

  ```
  netsh interface ipv4 show excludedportrange protocol=tcp
  ```

  Checked on the PC the same day: the exclusions there are 5357, 49680 and
  eighteen blocks between 50000 and 63520, so 41427 is clear. **41427 it is.**
  If a user's machine reserves it anyway, the plan is unchanged and the port
  is simply a different number for them — see the runtime behaviour below.

  Behaviour when the port is taken at runtime: the app still starts, links are
  still emitted (they are the same on every machine, so a link printed on
  another host must not depend on this one's luck), and the Agent Access
  panel says which process holds the port. The constant lands in
  `src/shared/` with M2, where the link server first uses it.

## Milestones

Each one ships as a release. M0–M2 change nothing a single-machine user would
notice except the tray icon; M3 is GitWarren without Electron; M4 is the
milestone for the Mac → PC workflow; M6 is where hosts find each other and the
phone arrives.

### M0 — Foundations

*Ships: an update with no visible change.*

The migrations that are cheap now and painful once hosts exist. Every later
milestone assumes these.

- **Instance id.** A UUID generated once into the data directory
  (`src/core/paths.ts`), read by GUI, daemon and MCP. It is how hosts and links
  name this install.
- **Principal.** New `principals` table; `comments` gains `author_id`.
  Existing `"Human"` rows migrate to the local principal; agent rows keep their
  MCP-derived identity (`src/shared/actors.ts`, `src/mcp/identity.ts`).
- **Repository identity.** `repositories.host_id` (nullable, null = this
  instance); `UNIQUE(path)` becomes `UNIQUE(host_id, path)`
  (`src/core/db/schema.ts`, `npm run db:generate`). That index alone is not
  enough: SQLite treats NULLs in a unique index as distinct from one another,
  and NULL is how a local row is spelled, so `(NULL, '/work/app')` twice would
  satisfy it and local repositories would silently lose the duplicate guard
  they have today. A second, partial index — `UNIQUE(path) WHERE host_id IS
  NULL` — is what keeps that guard, and the two together say what `UNIQUE(path)`
  used to say, once per host.
- **Routes with a host segment.** `src/shared/routes.ts` accepts
  `h/<instance>/review/4/…`; the segment is optional and omitted for local, so
  every existing link keeps working.
- **Git hygiene.** Refs and paths separated at every `runGit` call site in
  `src/core/git.ts` and `git-compare.ts`; refs validated with
  `git check-ref-format`; worktree file reads confined to the worktree root.
  Note which way round the `--` goes: for a command that takes a revision it
  means "everything after this is a *path*", so `git rev-parse -- main` reads
  the ref as a filename and answers the wrong question instead of failing. `--`
  therefore goes before pathspecs only, and refs are validated instead —
  suffixes like `HEAD~3` and `main^{commit}` peeled off first, so nothing that
  works today starts being refused.

**Verify:** existing test suite green; a pre-M0 database opens, shows the same
reviews and comments, and new comments carry the local principal.

### M1 — One protocol

*Ships: no visible change; faster review opening.*

Put the core behind a message protocol while everything still runs in one
process. This is the load-bearing refactor; every carrier after it is small.

- **`src/shared/rpc.ts`.** Request `{id, method, params}`, response
  `{id, result | error}`, event `{event, data}`. Errors carry `AppError` codes
  as today.
- **Object-centric methods.** `reviews.open(id)`, `reviews.diff(id)`,
  `reviews.commits(id)`, `reviews.file(id, path)`, `comments.list(reviewId)`…
  never a raw ref or path outside a review. The daemon resolves refs itself.
- **Coarse endpoints from S5.** The hot screens get one call each: everything
  needed to render a review, everything for the files tab.
- **Dispatcher.** `src/core/rpc/dispatcher.ts` maps method → service;
  `src/main/ipc.ts` becomes a thin carrier over it.
- **Renderer side.** `src/renderer/src/lib/api.ts` implements
  `window.gitwarren` over a `Carrier` interface; the preload supplies the IPC
  carrier. `system`, `updates` and `navigation` stay client-side and
  Electron-only.
- **Contract tests.** Drive the dispatcher directly against temp repos,
  following `src/core/__tests__`. These become the tests for every carrier.

**Verify:** S5's counts re-measured; a review opens in at most three sequential
round trips. UI checked over CDP with a scratch data dir.

- **Outcome.** *Done, 10 September 2026, macOS, the same seeded demo database
  S5 used (3 repositories, review 1 with 5 threads), both sides built with
  `npm run build` and driven over CDP by
  `scripts/spikes/s5-ipc-per-screen.mjs`.* Before is the merge of M0; after is
  this milestone. Calls include the Electron-only ones -
  `system`, `updates` - because the renderer pays a round trip for those too,
  and a count that left them out would flatter itself.

  | Screen | Calls before | Calls after | Depth before | Depth after |
  | --- | --- | --- | --- | --- |
  | Home, cold load | 3 | 3 | 1 | 1 |
  | Review → conversation tab | 4 | **3** | **2** | **1** |
  | → commits tab | 0 | 0 | — | — |
  | → files tab | 3 | 2 | 1 | 1 |
  | Back to home | 2 | **1** | 1 | 1 |
  | Review files tab, cold load | 7 | **5** | **2** | **1** |

  Opening a review is now three calls that start together - `reviews.open`,
  `reviews.commits`, `reviews.diff`, all within 6 ms of each other - so it is
  one round trip, not the three the target allowed. Two changes got it there.
  `reviews.open` folds `reviews:get`, `comments:list` and `reviewedFiles` into
  one answer, and the three hooks that used to hold three cache keys now share
  the one it lands under, so however many of them mount at once, SWR issues a
  single request. And the diff is asked for by the review screen at mount
  rather than by whichever tab is showing: it used to wait for the review to
  come back before the tab existed to ask for it, which is exactly the wait a
  network multiplies.

  The static reads, measured on their own by walking home → files → home →
  files → home inside one document, after the first paint:

  | | Before | After |
  | --- | --- | --- |
  | Calls over four navigations | 14 | 7 |
  | of which `system:appInfo` | 2 | 0 |
  | of which `system:editors` | 2 | 1 |

  Both are memoised in `renderer/src/lib/api.ts` for the life of the window -
  the promise, not the value, so two callers racing on the first render still
  share one call. Once per document is the floor; a reload is a new process and
  asks again, which is correct.

  What did not need fixing: the duplicated wave, which was the spike script -
  see the amendment under S5. The carrier coalesces identical reads that are in
  flight at the same moment anyway, because SWR's deduplication is a property of
  one renderer and M3's and M4's carriers will have callers that are not SWR.
  Writes are never coalesced; the list of methods that may be is in
  `shared/rpc.ts` and a test asserts no write is on it.

  Checked over CDP against a scratch data directory: all three tabs render, a
  reviewed tick survives leaving the review and coming back - a real read of the
  composite endpoint, so the optimistic patch matched what was written - and a
  comment typed into the app is stored as the person's, not an agent's.

### M2 — Always on, locally

*Ships: tray icon, start at login, links that survive restarts.*

The GUI becomes something that keeps running, the daemon bundle exists, and
the DB has one owner per machine.

- **Tray mode.** `window-all-closed` in `src/main/index.ts` hides instead of
  quits; tray menu with Open and Quit; the single-instance lock already focuses
  the window on relaunch.
- **Start at login**, opt-in in settings:
  `app.setLoginItemSettings({ openAtLogin, openAsHidden })` on macOS and
  Windows; `~/.config/autostart/gitwarren.desktop` on Linux. The updater
  relaunches hidden.
- **Daemon bundle.** `vite.daemon.config.ts` → `out/daemon/serve.cjs` with a
  `--stdio` carrier over the dispatcher; unpacked from asar like the MCP
  script; also runnable as `GitWarren --serve`.
- **One owner.** `src/core/gui-runtime.ts` generalised to
  `daemon-runtime.json`: instance id, pid, link port, owner. The GUI is the
  owner when it runs; the MCP server talks to the owner when there is one and
  opens SQLite directly when there is none, as today.
- **Stable launcher.** The app maintains `~/.gitwarren/bin/gitwarren-mcp` (a
  `.cmd` on Windows) pointing at the current install, replacing the
  per-install command in `src/main/mcp-launch.ts`. One path per OS, on every
  machine and every harness; retires the AppImage caveat.
- **Links.** `src/main/link-server.ts` listens on the fixed port from S6;
  `src/mcp/gui-link.ts` emits `http://127.0.0.1:<port>/#h=<instance>/review/4/…`
  unconditionally; the static page builds `gitwarren://<instance>/…`; the GUI
  resolves its own id. `guiUrl` stops being nullable and the tool text in
  `src/mcp/server.ts` says what a dead link means.

**Verify:** close the window, have an agent create a review, click its link:
the window comes back on the review. Quit fully: the MCP server still works
against SQLite.

- **Outcome.** *Done, 10 September 2026, macOS 15 (Darwin 25.6), Electron 44,
  driven over CDP against a scratch data directory and a scratch
  `--user-data-dir`.* The acceptance test passes end to end. With the window
  closed, an agent created review 4 through
  `~/.gitwarren/bin/gitwarren-mcp` and got back

  ```
  http://127.0.0.1:41427/#h=d8b0e181-4bb1-4c7b-80e0-aedc58db1de7/review/4/conversation
  ```

  the served page turned that fragment into
  `gitwarren://d8b0e181-…/review/4/conversation`, and delivering that URL put
  the window back on `#/reviews/4/conversation` with the agent's title on it.
  Then, with the app fully quit - runtime file gone, port 41427 refusing
  connections - the same launcher wrote a comment on review 4 and still handed
  back a `guiUrl`, which is the half of the test that would have been a `null`
  before M2.

  The link was delivered by launching the binary again with the URL in argv -
  the door Windows and Linux use, which the single-instance lock turns into
  `second-instance` - rather than through the OS protocol handler, because
  `gitwarren://` on this Mac is registered to the *installed* GitWarren and
  asking the OS to open one would have driven that app against the real
  database. Everything from `receiveDeepLinkFromArgv` on is the same code.

  #### What the protocol needed in order to survive a byte stream

  One thing. The contract tests in `core/rpc/__tests__` run twice since M2 -
  once as a function call, once over the newline-delimited JSON carrier - and
  every assertion that existed before M2 passed over the pipe unchanged, first
  try. That is the result the arrangement was built to produce, and it is the
  headline: the protocol is carrier-independent as written.

  The gap the tests did *not* catch is `attachments.ingest`, and the reason
  they did not is instructive - the existing test already sent the `number[]`
  form, which JSON carries fine. But the params were typed
  `ArrayBuffer | number[]`, and an `ArrayBuffer` is exactly what
  `JSON.stringify` destroys: it becomes `{}`, which reaches `Buffer.from` and
  throws `TypeError: The first argument must be of type string or an instance
  of Buffer, ArrayBuffer, or Array…`, surfacing as `INTERNAL` from somewhere
  inside the dispatcher. Over an `ssh` pipe in M4 that is indistinguishable
  from the daemon being broken. Found by reading the one param type in the map
  that is not plain data against what JSON can carry, rather than by a failing
  test - which is an argument for doing that reading at every milestone, not
  only for adding carriers to the suite.

  So `bytes` gained a `string` form (base64, 1.33 bytes on the wire per byte of
  image rather than the four a stringified `number[]` costs), and an
  unrecognised shape is now an `INVALID_INPUT` that names the three accepted
  forms. Nothing else moved. In particular every timestamp in the schema is
  already a `text` column, so no result carries a `Date` for JSON to flatten -
  which is the failure this exercise was most likely to have found.

  The framing itself needed no argument: `JSON.stringify` never emits a raw
  newline, so `\n` is an unambiguous frame boundary, and S2 had already put
  50 MB of exactly these frames through `wsl.exe` byte-exact. Responses come
  back in completion order rather than request order, which the `id` field
  exists for and which the tests now assert by matching on it.

  #### Tray and login item, per platform

  Closing hides rather than quits, on every platform including macOS, and it is
  a `close` handler rather than `window-all-closed`: a closed window is
  destroyed, so hiding is what keeps the review the user was reading on screen
  for when they come back. Verified over CDP - after a ⌘W the renderer is still
  attached and `location.hash` is unchanged, which a destroyed window could not
  manage. The tray menu is two items, Open and Quit; Quit is now the only way
  out, so it is labelled with the app name.

  | | macOS | Windows | Linux |
  | --- | --- | --- | --- |
  | Tray | Menu bar item, 18px, colour rather than a template image - a template renders a logo as a filled blob | Notification area, 16px; left click opens | System tray, 22px; left click opens. Absent on desktops with no tray, and the app says so and carries on |
  | Login item | `SMAppService` via `setLoginItemSettings` | `Run` registry value, with `--hidden` | `~/.config/autostart/gitwarren.desktop`, `Exec=… --hidden` |
  | Starting hidden | `wasOpenedAtLogin` - Electron 44 dropped `openAsHidden` when macOS moved to `SMAppService`, so this is what is left, and it means the same thing | `--hidden` in argv | `--hidden` in argv |
  | Reading it back | `getLoginItemSettings()` | Same, *with the same `args`* - the registry value is keyed by the whole command line, so omitting them reports false for an entry we wrote ourselves | The `.desktop` file exists |

  Toggling it on and off through the panel was checked over CDP on macOS and
  read back correctly both ways. The `--hidden` and Linux paths were not
  exercised on their own platforms.

  The updater relaunches hidden by leaving a note in the data directory rather
  than by passing an argument, because `electron-updater` restarts the app
  itself and there is no supported way to hand argv to what comes back. The
  note carries a timestamp and is ignored after five minutes, so a crash
  between writing it and quitting cannot leave the app starting invisibly
  forever.

  #### One owner: what the rule actually turned out to be

  The plan said the MCP server would talk to the owner when there is one and
  open SQLite when there is not. **It opens SQLite in both cases**, and the
  reason is rule 6 rather than expedience. An agent never crosses the network,
  so the MCP server is always on the machine holding the database, and WAL is
  already what makes two local processes safe - it is what `db/client.ts` is
  configured for. Routing agent reads through the owner would buy nothing and
  cost the property the milestone is verified on: quit GitWarren, and the agent
  keeps working. The owner branch would have had to fall back to SQLite the
  moment the window closed, which is two paths to keep in agreement in exchange
  for nothing.

  What genuinely needs the owner is a *push* - telling a running GUI that an
  agent has just written a comment, instead of the window finding out fifteen
  seconds later. That needs a channel the MCP process may dial, and M2 has
  none: the link server is inert by design, and the stdio carrier only serves a
  process someone else spawned. M3's WebSocket is that channel and M6 is where
  the poke goes in.

  So `daemon-runtime.json` holds `{instanceId, pid, linkPort, owner}` and is
  written by whoever holds the loopback port - the GUI today, a listening
  `gitwarren serve` in M3. A `--stdio` daemon deliberately writes nothing and
  checks nothing: it binds no port, answers one pipe, and lives as long as its
  parent, so refusing to start next to a running GUI would break the M4 case
  outright, where the Mac spawns a daemon on a PC that is quite reasonably
  running its own GitWarren.

  #### Links, and what a fixed port cost

  41427 is bound or nothing is - there is no fallback to an OS-assigned port,
  because links are now minted against the constant whoever reads them, and
  falling back would mean handing out URLs that point at whatever else took the
  port. When it is taken the app starts anyway, logs which port and why, writes
  `linkPort: null`, and the Agent Access panel says so. Checked by holding the
  port from another process and starting the app against it.

  The instance id moved into the deep link's authority -
  `gitwarren://<id>/review/4/…` - which is the position a URL reserves for
  "whose". `gitwarren://review/4/…` still parses and still means the local
  install, so every link already sitting in a terminal scrollback keeps
  working. A link naming *another* install lands on the home screen and logs
  the id rather than opening the local review with that number, which is the
  honest failure until M4 has a hosts table to resolve it in. Verified.

  #### The stable launcher

  `~/.gitwarren/bin/gitwarren-mcp` (a `.cmd` on Windows), rewritten whenever its
  contents would change, so it survives an update and a move. `getMcpLaunchInfo`
  reports it as the command with no arguments and no environment, which is what
  makes the one-sentence agent prompt in [Agent setup](#agent-setup) possible -
  it is now what the Agent Access panel leads with, snippet behind a disclosure.

  The AppImage caveat is retired. An AppImage's only stable path is the
  `.AppImage` file, which the runtime exports as `APPIMAGE`, so the launcher
  names that and reaches the script through `APPDIR` at run time. This was
  written blind and is now verified - see the verification addendum below.

  #### Not done here

  - `GitWarren --serve` implies `--stdio`; there is no argv parser worth the
    name until M3 adds `--listen`.

- **Verification addendum.** *10 September 2026, against the artifacts of the
  `v0.1.7-beta.1` draft release - the first build of any of M0-M2 - rather than
  against a development build.* M2 shipped with three code paths that had never
  run on the platform they target, and two of them could not be tested without
  a packaged build at all. This closes most of that; what is left needs the PC.

  **The daemon tarball's CI job now exists.** `scripts/build-daemon-tarball.mjs`,
  promoted out of the S3 spike, built by a `daemon` job in `release.yml` - one
  ubuntu runner for both architectures, since better-sqlite3 ships prebuilds for
  each and nothing is compiled. It carries both bundles now rather than only the
  MCP server: a remote host has to answer a GitWarren over a pipe *and* be
  reached by the agent working next to the code, and rule 6 makes those
  different processes. `bin/gitwarren serve --stdio` is the line M4 spawns, so it
  works against this tarball rather than against a name invented later.

  Downloaded from the draft and run in a bare `ubuntu:24.04` arm64 container
  with no Node installed: `bin/gitwarren serve --stdio` answered
  `{"id":1,"result":[]}` and `bin/gitwarren-mcp` answered an MCP `initialize`,
  each having created and migrated the database first. Exit 0 both times. The
  asset names are a contract - M4 maps `uname -sm` to one of them and fetches a
  single URL - and the README says so.

  **The AppImage launcher works, for a reason the code does not say.** Checked
  by running the real arm64 AppImage inside a container with `--device
  /dev/fuse`, which is enough to make an AppImage mount itself properly:

  ```
  APPDIR      = "/tmp/.mount_gw.AppaTGlSt"
  APPIMAGE    = "/tmp/gw.AppImage"
  execPath    = /tmp/.mount_gw.AppaTGlSt/gitwarren
  via APPDIR  = RESOLVES
  ```

  and then, through a byte-for-byte copy of the launcher the app writes, at
  `~/.gitwarren/bin/gitwarren-mcp` against an AppImage in `~/Apps`, the MCP
  server started and answered `initialize` and `list_repositories`.

  The reason worth writing down: **`AppRun` only assigns `APPDIR`, it never
  exports it.** The launcher works because the AppImage's ELF runtime puts
  `APPDIR` into the environment before `AppRun` is exec'd at all - so the
  assumption holds, but not for the reason someone reading `AppRun` would
  conclude. `process.execPath` resolves the same file and depends on none of
  that; if this ever breaks, that is the anchor to move to.

  Also, and consistent with S3: the Electron binary needs GTK to load **even
  under `ELECTRON_RUN_AS_NODE`**, so the AppImage launcher wants a desktop
  stack. That is fine for an AppImage user and is exactly why the tarball exists
  for headless hosts.

  **The packaged macOS build.** Everything in M2 was checked under
  `electron-vite dev`, where `app.isPackaged` is false - so `mcp-launch.ts`'s
  packaged branch, which is a different code path, had never run. Against the
  draft's `arm64.dmg`, copied out of the volume to a scratch location and driven
  with a scratch data directory:

  | | |
  | --- | --- |
  | `packaged` | `true` - the branch under test |
  | `mcp.command` | `~/.gitwarren/bin/gitwarren-mcp`, `args: []`, `env: {}` |
  | launcher contents | names `Contents/MacOS/GitWarren` and `Contents/Resources/app.asar.unpacked/out/mcp/server.cjs` |
  | `linkPort` | 41427, and the loopback page answers 200 |
  | login item | off → on → read back on → off → read back off, through `SMAppService` with a real bundle id |
  | closing | hides; the renderer stays attached |

  With the window closed, an agent created review 4 through that launcher and
  got back
  `http://127.0.0.1:41427/#h=0e37f642-…/review/4/conversation`. So the whole
  chain holds in a packaged build, not only in dev.

  **A finding about tags and the updater**, which matters for how the rest of
  this work is released. Pushing `v0.1.7-beta.1` makes the *tag* public even
  though the release is a draft, and the packaged beta's updater duly found it
  and 404'd fetching `latest-mac.yml` - a draft's assets are not downloadable.
  Harmless, but it raised the question of whether existing users were affected.
  They are not: the installed 0.1.6, run against scratch directories, reported

  ```
  [updater] Update for version 0.1.6 is not available (latest version: 0.1.6, downgrade is disallowed).
  ```

  because `allowPrerelease` defaults to true only when the *running* version is
  itself a prerelease. A stable install filters a `-beta` version out and never
  sees it. So a beta tag is a safe way to get artifacts, and the draft is a safe
  place to leave them.

  **Still unverified, and needing the PC:** the Windows tray item and its `Run`
  registry login item with `--hidden`; the Linux
  `~/.config/autostart/gitwarren.desktop` file on a real desktop; and the
  hidden relaunch after an update, which by construction cannot be tested until
  there are two published releases to move between.

### M3 — The web view, locally

*Ships: GitWarren without Electron.*

The same renderer served by the daemon on loopback, opened in a browser. A
second distribution that shares every line except the shell — for people who
will not install an Electron app — and the surface the phone will use later.
Brings the WebSocket carrier forward.

- **WebSocket carrier.** Server in the daemon and the tray app; a bootstrap
  script in the web build provides `window.gitwarren` over it. Same messages as
  stdio; requests multiplexed by id; ping/pong heartbeats.
- **Static serving.** The daemon serves `out/renderer` on the loopback port
  from S6 — the link server grows into the web UI, so a `guiUrl` opens the
  review directly with no "Open in GitWarren" hop when no Electron app is
  present. URL path ↔ the hash grammar in `src/shared/routes.ts`.
- **Blobs over HTTP.** `/attachments/<id>` GET for images in markdown;
  clipboard paste and a file input for new ones; very large file reads use GET
  past a size threshold.
- **Loopback security, Jupyter-style.** Bind `127.0.0.1` only; a per-launch
  token printed by `gitwarren serve` and carried by `gitwarren open`,
  exchanged for a cookie; strict `Origin` and `Host` checks on every request
  and on the WebSocket upgrade. The static link page stays as inert as
  `src/main/link-server.ts` insists.
- **Electron-only features handled.** Tray, protocol handler and the updater
  are absent; open-in-editor uses `vscode://file/…:line` links or the daemon
  spawning `code --goto` locally; reveal-in-Finder hidden.
- **Distribution.** The self-contained tarball from S3 for macOS and Linux; a
  Homebrew *formula* (the cask stays for the app); `npx gitwarren`. Commands:
  `gitwarren serve`, `gitwarren open`, `gitwarren service install` (LaunchAgent
  / `systemd --user` / at-logon task) so it starts at login like the tray app.
- **Agent setup, one sentence.** The Agent Access page (in both shells) leads
  with a copy-paste prompt for any agent — see [Agent setup](#agent-setup).
  Per-harness snippets become secondary.
- **Responsive pass.** Files list and diff as separate screens on narrow
  widths; composer above the keyboard; paths wrap at separators and stay
  selectable. Done here so the phone in M6 is only a network away.

**Verify:** on a Mac with no GitWarren.app, `brew install` the formula,
`gitwarren serve`, open the browser, add a repo, review, comment; Claude Code
and Codex both reach the MCP server from the pasted prompt; a `guiUrl` from an
agent opens the review in the browser. A page on another origin cannot reach
the API.

### M4 — SSH hosts

*Ships: review the PC's WSL repos from the Mac; any VPS.*

The first real remote. A host is added by SSH target; the app installs the
daemon there and spawns it over the pipe on demand. This is the milestone for
the Mac → PC workflow, via S1. Depends on M2; M3 is not required, so it can run
in parallel with it.

- **Hosts.** `hosts` table: instance id (learned on first connect), label,
  kind `ssh`, target, editor target, last seen. Hosts screen: list with status,
  add, remove.
- **SSH carrier.** Spawns
  `ssh -o ControlMaster=auto -o ControlPersist=10m <target> ~/.gitwarren/bin/gitwarren serve --stdio`;
  keeps the daemon alive for a few minutes idle; reconnects with backoff;
  requests fail fast with `HOST_OFFLINE`.
- **Installer over SSH.** Runs `uname -sm` on the host, fetches the matching
  daemon tarball from the GitHub release once (cached in the data directory),
  streams it into `~/.gitwarren/daemon/<version>/`, and maintains
  `~/.gitwarren/bin/gitwarren` and `gitwarren-mcp` launchers so agent configs
  survive upgrades. The host needs nothing installed but git; air-gapped hosts
  work because the GUI does the download. Re-runs on version mismatch.
- **Repositories on hosts.** Add-repository picks a host and browses paths
  through a `fs.list` method on the daemon. Reviews are listed under their
  host; routes carry the host segment; clones are grouped by root commit across
  hosts.
- **Attachments.** Ingest runs on the host (bytes travel over the carrier);
  `src/main/attachment-protocol.ts` resolves `(host, id)` through
  `attachments.read`.
- **Editors.** `src/main/editors.ts` takes `(host, path, line)`;
  `ssh-remote+<target>` forms per S4; reveal-in-Finder hidden for remote hosts;
  the custom command template gains `{host}`.
- **Agent access per host.** The Agent Access page for a remote host shows the
  same one-sentence prompt with that host's launcher path, to paste into the
  agent session running there. `gitwarren agent-setup` on the host prints it
  too.
- **Disconnection.** Banner on the open review, content kept visible but
  marked stale, silent refetch on reconnect.

**Verify:** from the Mac, add the WSL node as an SSH host, add a repo, review
the uncommitted work Claude Code left there, comment; the agent in WSL reads
the comment over its local MCP and replies; the reply appears on the Mac after
refresh. Pull the network cable mid-review and plug it back.

### M5 — WSL from Windows

*Ships: the Windows app reviews WSL repos.*

The same daemon, spawned through `wsl.exe` instead of `ssh`. Small delta on
M4; large for Windows users who keep code in WSL.

- **WSL carrier.** `wsl.exe -d <distro> -- ~/.gitwarren/bin/gitwarren serve --stdio`
  per S2; distro picker from `wsl.exe -l -q`; lifetime tied to the Windows app.
- **Installer.** Same linux tarball, delivered over the pipe or via
  `\\wsl.localhost\<distro>\…`; nothing to install inside the distro.
- **Editors.** `wsl+<distro>` forms; Explorer reveal via `\\wsl.localhost`
  kept.
- **Guard.** Adding a `\\wsl.localhost` path as a *local* repository is
  refused with a pointer to "add as WSL host".

**Verify:** Windows app, repo in Ubuntu, Claude Code running inside WSL. Native
Windows repos unaffected.

### M6 — Tailnet and live updates

*Ships: hosts appear by themselves; comments arrive live; reviews on the
phone.*

A listening carrier, identity from Tailscale, discovery, and the event
channel.

- **The WebSocket carrier from M3, listening beyond loopback.**
  `serve --listen` and the tray app accept the tailnet through
  `tailscale serve`; the app gains a WebSocket client for remote hosts.
- **Tailnet exposure.** Settings toggle "Reachable on your tailnet" runs
  `tailscale serve` in front of the loopback port. Every request must carry
  `Tailscale-User-Login` equal to the owner's login (from
  `tailscale status --json` → `Self`); anything else is refused before
  dispatch.
- **Discovery.** Peers from `tailscale status --json` are probed; those
  answering appear as hosts with their instance id. Manual entry stays for
  everything else.
- **Events.** Daemon emits `reviews.changed`, `comments.changed`,
  `host.state`; the renderer treats them as refetch hints, never as data. The
  MCP process pokes the owner (counter in `daemon-runtime.json` or a local
  socket) so agent writes push too. The 15-second poll stays as the fallback.
- **`webUrl`.** Added to MCP results when the host listens:
  `https://<host>.<tailnet>.ts.net/review/4/…`. Tool text explains both fields.
- **The phone.** Nothing new to build: the web view from M3 is now reachable
  at the `webUrl` from any device on the tailnet, with `tailscale serve`
  supplying identity instead of the local token.

**Verify:** PC appears on the Mac with no configuration. An agent comment shows
on the Mac within a second. Turn the PC off: greyed within seconds, no stale
data left behind. Phone on the tailnet opens a `webUrl` from a herdr session,
leaves a comment, the agent reads it.

After M6: README, site and tagline move from "single user, single machine, no
server" to "your machines, your agents, no one else's server". Update Known
limitations as each milestone retires one ("nothing is pushed to the UI" goes
at M6).

## Agent setup

One sentence instead of a snippet per harness. Agents know their own
configuration format better than a panel can; what they need from us is a
stable command.

The Agent Access page leads with a prompt to paste into whatever agent the user
runs, on whatever machine it runs:

```
Set up the GitWarren MCP server for yourself. It speaks MCP over stdio and is
started with the command ~/.gitwarren/bin/gitwarren-mcp (no arguments, no
environment). Register it under the name "gitwarren" in your own MCP
configuration, then call its agent_identity tool to confirm it works.
```

- **Same on every host.** The launcher path is maintained by the tray app
  (M2), the local web daemon (M3) and the SSH/WSL installer (M4, M5). On a
  remote host the user pastes the same prompt into the session running there —
  no config editing over SSH.
- **Per-harness snippets stay, as a fallback.** The `mcpServers` JSON already
  covers Claude Code, Cursor, Windsurf and Gemini CLI; Codex needs TOML
  (`[mcp_servers.gitwarren]`) and VS Code uses `servers`. Show them behind a
  "configure by hand" disclosure, generated from the same launcher path.
- **`gitwarren agent-setup`** prints the prompt on any host, for people who
  never open the UI.
- **Attribution unchanged.** Identity still comes from the MCP handshake
  (`src/mcp/identity.ts`), never from the prompt.

## Decisions already made

Recorded so they are not re-argued mid-build. Each was weighed against at
least one alternative.

- **Ownership over sync.** Replicating the review DB would buy reading old
  threads with no code under them, at the cost of UUIDs, conflict rules and
  tombstones. Not worth it.
- **Message protocol over stdio and WebSocket; HTTP only for static files and
  blobs.** Three of four carriers are byte streams; HTTP would mean two
  protocols.
- **Tailscale is discovery and identity, never a dependency.** SSH is the
  universal fallback for own machines. No home-grown pairing tokens for other
  mesh VPNs.
- **Authorisation is "same Tailscale login as the owner".** Single user. Roles
  and per-review shares were designed but are out of scope.
- **`guiUrl` is always loopback; `webUrl` is added when a host listens.**
  Loopback depends on nothing and works on a plane. The MCP server never
  guesses where the human is.
- **The daemon is self-contained: a Node binary ships in the tarball.** Asking
  users to keep Node 24 installed on every host was the alternative; ~30 MB
  per platform is cheaper than that prerequisite. Tarballs are release assets,
  fetched by the GUI on demand, not bundled into the desktop installer.
- **IDs stay autoincrement, scoped by instance id.** A review is "4 on host X"
  everywhere: routes, links, cache keys.
- **A review belongs to a clone.** Two clones of one project are two
  repositories with two review sets, grouped visually by root commit. Reviews
  that follow a branch are the git-native model, a separate decision.
- **Windows-native repos are first class; WSL is a host.** Most Windows
  developers do not run WSL and agents run natively there since late 2025. The
  Windows app is never made worse for them.
- **Two shells, one UI.** Electron for people who want a tray and a protocol
  handler; the daemon plus a browser for people who will not install Electron.
  Nothing is built twice.
- **Agent setup is a prompt, not a per-harness snippet.** A stable launcher
  path and one sentence the agent applies to its own configuration; snippets
  remain as a manual fallback.
- **Agents stay on stdio, local to the host.** Real paths, readable
  screenshots, no network for the agent. The daemon exists for the human.

## Non-goals

- Sharing reviews or repositories with other people. GitHub has that job;
  revisit when someone asks with a concrete case.
- Sync or replication of review data between hosts.
- Git-native reviews (threads as refs or notes that travel with the branch).
  Kept in view for the cloud-agent case; not started.
- Anything hosted: relays, redirectors, push-notification services, accounts.
- A native mobile app. The phone gets the web view.
- Making the Windows app read WSL repositories over `\\wsl$`. Wrong
  architecture even when it works.

## Where each known gap is closed

| Gap | Closed in | How |
| --- | --- | --- |
| Chattiness over a network | S5, M1, M3 | Measure, then coarse endpoints; a multiplexed WebSocket removes per-request setup. |
| Disconnection | M4, M6 | Fail-fast errors, stale banner, reconnect with backoff, heartbeats, refetch on reconnect. |
| Colleague permissions | — | Non-goal. Object-centric RPC from M1 keeps the door open. |
| Git argument and path hardening | M0 | Hygiene now; not a security boundary while every caller is the owner. |
| Host-scoped routes and IDs | M0, M4 | Optional host segment in the route grammar; hosts table; links carry the instance id. |
| Which GUI a link opens | M2, M6 | Loopback resolves on the clicker's machine; tailnet URL for the phone. |
| Attachments across hosts | M3, M4 | Ingest on the host; HTTP for the web view, the carrier for the app. |
| Version skew between hosts | M4 | The GUI installs the daemon version it wants; protocol version in the handshake; unknown fields ignored. |
| Daemon process on headless hosts | M2, M3, M4 | Bundle in M2, service install in M3, spawned on demand over SSH in M4. |
| Users who will not run Electron | M3 | The same renderer served by the local daemon; brew formula and npm. |
| MCP setup per harness and on remote hosts | M2, M3, M4 | Stable launcher path plus a one-sentence prompt the agent applies to its own config. |
