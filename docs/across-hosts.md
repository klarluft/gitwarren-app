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

- **Outcome, the `ssh-remote` half.** *Checked before M4.4 was written, because
  the form the milestone actually ships had never been run. 11 September 2026,
  VS Code 1.135.0 on macOS 26.6 (arm64), against `xfor@pc-wsl`.* The spike above
  verified `wsl+Ubuntu` *from Windows*; a Mac opening
  `ssh-remote+xfor@pc-wsl` is a different extension over a different transport,
  and it passes:

  `vscode://vscode-remote/ssh-remote+xfor@pc-wsl/home/xfor/…/README.md:5`,
  handed to `open`, brings up a window whose workspace storage records
  `resource.authority.os.ssh-remote+xfor@pc-wsl`, starts
  `~/.vscode-server/code-08d4889f…` on the host — the Mac's own VS Code commit,
  not the one the WSL spike left there — and puts the cursor on line 5. The line
  is not a claim about what was on screen: VS Code writes its own
  `memento/workbench.editors.files.textFileEditor` per window, and that entry
  reads `lineNumber: 5` against the `vscode-remote://ssh-remote%2Bxfor@pc-wsl/…`
  URI. The same memento later recorded `lineNumber: 3` for
  `docs/across-hosts.md`, which was GitWarren's own button rather than a URL
  typed by hand.

  **Nothing happens at all without the Remote-SSH extension, and it is silent.**
  With a stock VS Code the URL opens no window, starts no `ssh`, and leaves no
  server on the host — the first run of this check produced exactly nothing, and
  it took looking at `ps` on `pc-wsl` to establish that rather than a message.
  `ms-vscode-remote.remote-ssh` was installed on the Mac for the check and is
  what makes the form work; a person without it sees a prompt from VS Code
  rather than a review file. That is not something GitWarren can detect —
  `main/editors.ts` can see that VS Code is installed and cannot see which
  extensions it has — so the honest position is that the button opens the
  editor and the editor says what it needs.

  Two things this did *not* separate. Both the URL form and
  `code --remote ssh-remote+xfor@pc-wsl --goto <path>:5` were fired within
  twenty seconds of each other on a cold start, and the server took ninety
  seconds to appear, so which of them brought it up is unknown; the URL form is
  what ships, and the memento above proves it lands. And a remote window already
  connected cannot be closed from a script, so the "first ever connection"
  timing was measured once and is not repeatable here.

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
  Agent Access page warns; links are still emitted).
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
  `linkPort: null`, and the Agent Access page says so. Checked by holding the
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
  it is now what the Agent Access page leads with, snippets behind a disclosure.

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

  **The Windows host.** *10 September 2026, Windows 11 Pro 26200 (x64), against
  the draft's `GitWarren-0.1.7-beta.1-x64.exe`. Driven against the **real**
  install and the real database rather than a scratch data directory, which is
  the opposite of how the macOS pass was run and is the point: the tray, the
  login item and the protocol handler are all machine state living outside the
  data directory, and a scratch `--user-data-dir` would have exercised none of
  them. GUI observations are the user's, at the machine; everything else is
  read from the process table, the registry and the wire.*

  This is the milestone's headline platform - M2 turned GitWarren into a tray
  app and none of that code had ever run on Windows. It works. Three things
  about it are wrong anyway, and one of them would have made a careful person
  report the feature as broken.

  | | |
  | --- | --- |
  | Install | No elevation prompt. The manifest declares `requestedExecutionLevel level="asInvoker"`, and it ran from a non-elevated shell (`IsInRole(Administrator)` false) to exit 0 in 13 s |
  | Where | `%LOCALAPPDATA%\Programs\gitwarren`; nothing in either `Program Files`; uninstall entry under `HKCU`. Per-user throughout, as `oneClick`/`perMachine: false` promises |
  | Tray | Icon present, tooltip `GitWarren`, left click opens, menu exactly `Open GitWarren` / separator / `Quit GitWarren` |
  | Closing | Survives. Same four PIDs and the same `instanceId` before and after, so the reopen was a re-show and not a relaunch; the window came back on the screen and the page it was left on |
  | Quit | Process gone, `daemon-runtime.json` gone, 41427 released, loopback refuses |
  | Login item | Written, removed and rewritten across four flips, always `"…\GitWarren.exe" --hidden`, with no `StartupApproved` byte to silently disable it |
  | Hidden start | Verified on a real reboot: Windows fired the `Run` entry unattended, the main process carries `--hidden`, `MainWindowHandle = 0` on all four, and the window opens from the tray |
  | Launcher | `%USERPROFILE%\.gitwarren\bin\gitwarren-mcp.cmd`, correct as the bare command with no args and no env: handshake, `tools/list`, `agent_identity` |
  | Links | Loopback page 200; clicking through it put the window back on review 2 |

  `daemon-runtime.json` read
  `{"instanceId":"f563a866-…","pid":36500,"linkPort":41427,"owner":"gui"}` -
  the four-field shape, on the fixed port rather than a fallback. The same
  `instanceId` came back after a full quit and again after a hidden start, so
  it is install-scoped rather than per-launch, which is what lets a link minted
  while the app is dead resolve to this install later.

  **The launcher writes three errors to stderr on every start.** `#` is not a
  comment character in a batch file:

  ```
  '#' is not recognized as an internal or external command,
  operable program or batch file.
  ```

  once per banner line, before `[gitwarren-mcp] ready`. The cause is that
  `launcherScript()` in `src/main/mcp-launch.ts` builds one `banner` with `#`
  prefixes and shares it across all three branches; the win32 branch translates
  the line endings to CRLF and nothing else. Batch comments with `REM` or `::`.
  Nothing breaks - the server starts and answers correctly, and MCP carries the
  protocol on stdout - but this lands in the log of every harness on Windows on
  every start, and a harness that treats stderr on startup as a failed spawn
  would reject the server outright. It is the exact shape of defect the rest of
  this addendum was written to find: the macOS and Linux branches emit the same
  bytes into `/bin/sh`, where they are correct, so no reading of the shared
  string finds it and no test on those platforms can.

  **The `Run` value is not called `GitWarren`.** It is
  `electron.app.GitWarren`, because that is what `setLoginItemSettings` names
  it absent an explicit `name` option. So

  ```
  reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v GitWarren
  ```

  reports *"unable to find the specified registry key or value"* while the
  feature is working perfectly, and the honest command is

  ```
  reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v electron.app.GitWarren
  ```

  This one is worth more than the noise it causes. The table above in this
  milestone says "`Run` registry value, with `--hidden`" and that is true, but
  anyone verifying it the obvious way concludes the login item was never
  written. Either the check gets documented correctly or `login-item.ts` passes
  `name: 'GitWarren'`; the latter is one line and makes the obvious check the
  right one.

  **On Windows 11 the tray icon is hidden by default.** It went into the
  overflow flyout and stayed there until dragged out - which is Windows 11's
  behaviour for every new tray icon, not something the app chose. It matters
  because the justification written into `src/main/tray.ts` is that "with no
  window and no tray icon, a running GitWarren would be invisible and unkillable
  except through a task manager", and on a default Windows 11 desktop the icon
  *is* invisible until the user goes looking. The safety net is one click
  further away than the design assumes, and there is no API to fix it: Windows
  11 removed the promotion path, leaving a drag or
  `Settings → Personalization → Taskbar → Other system tray icons`. Not a bug,
  but it belongs in whatever tells a Windows user the app is now always on.

  **The protocol handler was exercised here, and was not on macOS.**
  `HKCU\Software\Classes\gitwarren\shell\open\command` is
  `"…\GitWarren.exe" "%1"`, registered per-user like the rest of the install.
  The macOS pass deliberately delivered its link through argv instead, because
  `gitwarren://` on that machine belonged to the *installed* app and driving it
  would have hit the real database. Here the click went the whole way -
  browser, `gitwarren://`, shell, `%1`, the single-instance lock's
  `second-instance` - so the one hop the macOS run had to simulate is now
  covered on the platform that always uses it.

  Two smaller notes. With the app fully quit, `create_review` through the
  launcher wrote to SQLite and returned a non-null
  `guiUrl` - the half of the acceptance test that would have been `null` before
  M2 - reproducing the macOS result on Windows. And the loopback link is
  correctly *dead* while the app is quit: opened then, the browser refuses the
  connection, which is what `list_reviews`' tool text tells the agent to
  predict, and it loaded on the same URL once the app was up.

  **The login start, on a real reboot.** This is the one the milestone exists
  for, and it was the last thing left: the `Run` value and the `--hidden` argv
  path could each be checked alone, but not the join - Windows firing the entry
  at sign-in - because testing that means ending the session doing the testing.
  A reboot settled it, and covers strictly more than the sign-out it replaced.
  Two minutes after boot, with nobody typing anything:

  ```
  Pid              : 33744
  Started          : 10-Sep-26 14:38:20
  MainWindowHandle : 0
  CommandLine      : "…\Programs\gitwarren\GitWarren.exe" --hidden
  ```

  `--hidden` in a command line nobody typed is the `Run` value being read back
  by Windows and honoured; `MainWindowHandle = 0` on all four processes is the
  flag being obeyed rather than merely accepted; and the runtime file and port
  41427 came up carrying the same `instanceId` as before the reboot, so a link
  minted in an earlier session still resolves to this install. The icon was in
  the notification area, and the window opened from it. End to end, unattended,
  on the platform this was written blind for.

  **Not checked, and why.**

  - **SmartScreen.** The installer is **unsigned** (`Get-AuthenticodeSignature`
    → `NotSigned`). It was fetched with `gh`, which sets no mark-of-the-web, so
    no `Zone.Identifier` stream existed and SmartScreen never appeared. A
    browser download does set that mark and would very likely raise "Windows
    protected your PC", needing *More info → Run anyway*. Not observed either
    way; it needs a browser download to settle, and it is the first thing a
    real Windows user meets.

  **The Linux desktop.** *10 September 2026, Kubuntu 26.04.1 LTS - KDE Plasma 6
  on Wayland - in a VirtualBox VM, against the draft's
  `GitWarren-0.1.7-beta.1-x86_64.AppImage`. Driven over SSH and D-Bus, with the
  VM's framebuffer grabbed as PNGs to confirm each step visually.*

  The last of the three platforms, and the one where the tray was least certain:
  Linux is where a tray may not exist at all, and where the login item is a file
  the app writes rather than an API it calls.

  | | |
  | --- | --- |
  | Tray | Registers with `org.kde.StatusNotifierWatcher`: `Id=GitWarren_status_icon_1`, `Status=Active`, `Category=ApplicationStatus` |
  | Menu | `Open GitWarren`, separator, `Quit GitWarren` - read back out of `com.canonical.dbusmenu.GetLayout`, not off a screenshot |
  | Left click | `StatusNotifierItem.Activate` opens the window |
  | Closing | Hides. Same pid, same tray item, runtime file intact and the link server still answering 200 afterwards |
  | Quit | The menu item ends the process: runtime file gone, 41427 released, tray item deregistered |
  | Login item | The toggle writes and removes `~/.config/autostart/gitwarren.desktop`, and reads back correctly on the next start |
  | Hidden start | Cold boot: argv is `--hidden`, tray icon present, no window |
  | Launcher | The AppImage form, now on a real desktop rather than in a container |
  | MCP | `initialize` and `agent_identity` answered, exit 0, stderr clean |
  | Links | A deep link delivered through argv put the window back on the review |

  The login item is worth spelling out, because it is the claim the milestone
  rests on here. The file the app writes is

  ```
  [Desktop Entry]
  Type=Application
  Name=GitWarren
  Comment=Local code review for your git repositories
  Exec="/home/gw/GitWarren.AppImage" --hidden
  Terminal=false
  X-GNOME-Autostart-enabled=true
  ```

  - `linuxCommand()` resolving to `APPIMAGE`, which is the whole point of it -
  and after a cold boot the process that came up had `--hidden` in a command
  line nobody typed, a tray icon, and no window.

  **What honoured that file was systemd, not a session manager.** The parent of
  the autostarted process is `systemd`, because Plasma 6 routes XDG autostart
  through `xdg-desktop-autostart.target` rather than forking entries itself. The
  claim in the table above - "`~/.config/autostart`, which is what GNOME, KDE and
  the rest look at" - holds, but on this desktop it holds through a mechanism a
  reader of that sentence would not picture. Worth knowing before debugging a
  desktop where it does not work: the question to ask is whether that target is
  reached, not whether some session manager scanned the directory.

  **The `#` banner is correct here**, which is the other half of the Windows
  launcher bug. The identical bytes that make `cmd` write three errors per start
  are an ordinary comment to `/bin/sh`; stderr from the launcher on this platform
  carries only the two lines the server writes itself. No amount of testing here
  or on macOS could have found it.

  **One thing that is not a bug and is worth writing down anyway.** With no
  working GPU - VirtualBox with no 3D - GitWarren starts as a tray icon and
  nothing else, *even when it was not asked to start hidden*. The GPU process
  cannot create a command buffer:

  ```
  ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer
  ```

  so the renderer never paints, so `ready-to-show` never fires, and the window
  built by `createWindow` is never shown - `window.once('ready-to-show', () =>
  window.show())` is the only thing that shows it. `--disable-gpu` fixes it
  completely, which is what identifies this as the VM rather than the app. But
  the shape of the failure is worth keeping in mind: on a machine with a broken
  GL stack, the distance between GitWarren and an app that starts invisible with
  no explanation is one event that never arrives.

  Also, and consistent with the macOS finding: the packaged beta's updater
  404'd on `latest-linux.yml`, for the same reason it 404'd on `latest-mac.yml`
  - a draft's assets are not downloadable.

  **How the clicking was done, since it bears on how much to trust this.**
  `VBoxManage` injects keystrokes but has no mouse, and `ydotool`'s uinput device
  was created after the session started, so KWin never assigned it to seat0 and
  ignored every event it produced. So the clicks that mattered were not clicks:
  `Activate` is precisely what a left click on a StatusNotifierItem sends, and a
  `com.canonical.dbusmenu` `Event` is precisely what choosing a menu entry sends,
  so those two are exercised at the same interface a mouse would reach - arguably
  a better test than a click, since the assertion is about what the item exposes.
  The settings toggle was reached with keyboard focus and pressed with Space.
  Screenshots confirmed each result on screen.

  **Not covered here:** the no-tray fallback - the path where `new Tray()` throws
  on a desktop with no StatusNotifierItem host and the app is supposed to say so
  and carry on with a window. Plasma has a tray, so this run could only take the
  branch where one exists.

  **Still unverified:** the hidden relaunch after an update, which by
  construction cannot be tested until there are two published releases to move
  between; the SmartScreen prompt a browser download of the unsigned Windows
  installer would raise; and the no-tray Linux fallback - all detailed above.

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
  Homebrew *formula* (the cask stays for the app, so the formula's token is
  `gitwarren-cli` and the binary is `gitwarren`); `npx gitwarren`. Commands:
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

#### How it is being built, and where it has got to

M3 is the largest milestone in this file, so it is going in as five changes,
each mergeable on its own:

1. **The carrier, the serving and the token.** *(done — see below.)*
2. **What the browser shell lacks.** Attachments over HTTP, open-in-editor as a
   `vscode://` link, and a shell *capability flag* so a screen can hide a
   control instead of offering one that explains itself when pressed.
   *(done — see below.)*
3. **The `gitwarren` CLI and distribution.** `serve`, `open`,
   `service install`; the S3 tarball, a Homebrew formula, `npx gitwarren`.
   *(done — see below.)*
4. **The Agent Access page**, one-sentence prompt leading. *(done — see below.)*
5. **The responsive pass.** *(done — see below.)*

**M3.1, done on the Mac, 10 September.** One handler (`core/web/handler.ts`)
mounted by both shells: the app serves it at `/app/` because `/` is the link
page M2 is verified on, and `gitwarren serve --listen` serves it at `/`, where
an agent's `guiUrl` opens the review with no "Open in GitWarren" hop — which is
the thing this milestone exists for. The gate is Host, then Origin, then a
per-launch token swapped for a `SameSite=Strict` cookie; the token is written
to `web-token` at mode 0600 rather than into `daemon-runtime.json`, which is a
published fact and no place for a secret. `--listen` claims the runtime file and
refuses to start beside a running app, which is the ownership check `daemon.ts`
said belonged here.

Verified in Chrome against both shells with a scratch data directory: the
renderer paints, the socket connects, a repository added *in the browser* lands
in SQLite, `app-info` answers over HTTP, and a refusal a tab must give — reveal
a folder — arrives as a sentence rather than a silence. No console errors and no
failed requests in either run. The renderer needed no change at all, which is
what M1 was for.

Two things bit, and both are worth keeping:

**A doubled `#`.** `hrefFor` already returns a string beginning with `#`, and
the translated route was being written back as `` `#${hrefFor(route)}` ``. The
hash became `##/reviews/2/files`, `parseRoute` read a first segment of `#`, and
every agent link quietly opened the repository list. Nothing threw and nothing
was logged — the screen it lands on is a completely plausible one. The
translation now lives in `web/loopback-fragment.ts`, apart from the DOM so it
can be tested, and the test asserts on `parseRoute(hrefFor(...))` rather than on
the route alone.

**`ws` and its optional native accelerators.** `bufferutil` and `utf-8-validate`
are reached for by reassigning `module.exports` at the bottom of two `ws`
modules. Rollup's *ESM* output turns the module's own later reference into
`bufferUtil$1.unmask`, which is `undefined`, so the first masked frame — and
every frame a browser sends is masked — dies inside `Receiver._write` before
anything of ours runs. The socket connects perfectly, accepts everything and
answers nothing. It hit the Electron main bundle and not the daemon purely
because main is built as ESM and `serve.cjs` is CommonJS. Both builds now define
`WS_NO_BUFFER_UTIL` and `WS_NO_UTF_8_VALIDATE` so the optional block is compiled
away (`vite.ws-define.ts`). A distinction between two bundlers' output formats
is not something anyone should have to remember.

**Not done in M3.1, and why.** `GitWarren --serve --listen` from inside the
packaged app is not a supported combination: `out/web` lives in the asar and
only `out/daemon` is unpacked, and the app serves the web view itself anyway.
The browser shell's missing capabilities are honest refusals rather than hidden
controls until M3.2 gives it the capability flag. Attachments in markdown do not
render in a tab yet — that is the HTTP blob endpoint, also M3.2.

**M3.2, done on the Mac, 10 September.** The three things a tab could not do,
each done the way a tab can rather than by asking the server to do it for the
person — which is the line M6 will need and is easiest to draw now, while the
browser and the daemon are on the same machine and nobody would notice it being
crossed.

**Attachments over HTTP.** `/gitwarren/attachments/<sha>.<ext>`, behind the same
cookie as everything else, reading the same content-addressed store the custom
scheme reads. A comment body still holds `gitwarren://attachment/…` whoever
reads it — it is stored text and must not depend on which shell renders it — so
the rewrite happens at the `<img src>` and nowhere else, through a new
`shell.attachmentSrc`. The window passes the token through; a tab turns it into
a path on its own origin, which `img-src 'self'` already covered, so the CSP did
not have to be loosened to make pictures appear. The token grammar moved to
`shared/attachments.ts` on the way, because the store's first line asks for
`node:crypto` and a browser bundle cannot import it to learn what a name looks
like.

**A capability flag.** `shell.capabilities` — `pickDirectory`, `revealPath`,
`openAtLogin` — read synchronously at module scope, so a screen leaves a control
out rather than offering one that explains itself when pressed. Deliberately
flags and not a shell *name*: `if (shell === 'web')` spreads a list of what each
shell happens to lack across every screen that asks, and M4's remote hosts will
answer some of these differently again. The refusals from M3.1 stay underneath
as the backstop for a caller that did not look.

**Open in an editor.** Two halves, joined in the opposite order from
`main/ipc.ts`: `reviews.filePath` is a read on the dispatcher — *which* file is
review knowledge — and the `vscode://file/…:line` navigation happens in the tab.
Nothing asks the daemon to start a process, which is the rule that makes this
software rather than a remote shell. The URL forms moved to `shared/editors.ts`
so both shells open the same string; detection stayed in `main/editors.ts`,
keyed by an id union so an editor added without detection is a type error. A tab
offers every editor with a scheme as a *choice* rather than a finding, since it
cannot look at the filesystem — and the picker in the files tab already existed
because the detected default was never more than a guess either.

**A pasted screenshot never arrived.** The one that would have cost an
afternoon. `attachments.ingest` is handed an `ArrayBuffer`, which structured
clone carries perfectly and which `JSON.stringify` turns into `{}` without a
word. Over the socket the image reached the dispatcher as an empty object,
failed the format sniff, and the user was told their PNG is not a PNG — a
failure that reads as being about the file rather than about the wire. The
carrier now base64s bytes before framing (`web/wire.ts`, apart from the socket
so it can be tested, as `loopback-fragment.ts` is), which is the encoding
`toIngestSource` has taken since M2 for the stdio carrier. `btoa` needs the
bytes in slices, or a four-megabyte screenshot overflows the call stack in
`String.fromCharCode`. `AttachmentIngestParams` was also narrower than what the
dispatcher accepted — it omitted the typed-array form the dispatcher has a
branch for — and now says all four.

Verified in Chrome and in the Electron window against one scratch data
directory, on a review whose description and first comment both hold an
attachment: both images paint in both shells; `reviews.filePath` answers with
the right absolute path and the editor URL leaves the page where it is; an
`ArrayBuffer` ingest over the socket comes back with a real sha. Side by side on
the repository screens, the browser shows zero reveal buttons, no Browse and no
start-at-login switch where the window shows one of each, and the path field,
the edit buttons and the cards are all still there — controls removed, not
screens. No console errors and no failed requests beyond Chrome's own
`favicon.ico` probe, which the web build has nothing to answer with; an icon is
polish for M3.5 rather than a gap in this change.

**Not done in M3.2, and why.** The other half of the "Blobs over HTTP" bullet —
*very large file reads use GET past a size threshold* — is untouched.
`reviews.file` and `reviews.image` still answer over the socket in both shells,
which is fine on loopback where the socket is a memcpy, and the threshold is a
number that should be chosen against a real network rather than guessed here.
It belongs with M6, where a file crosses the tailnet and the cost is visible.
Drag-and-drop and paste already worked in a tab and needed only the carrier fix;
what M3.2 added is the file *input*, so the composer's attach button means the
same thing in both shells.

**M3.3, done on the Mac, 10 September.** The thing there was no *program* for
until now. The daemon has been runnable since M2 and the web view since M3.1,
but a person had no name to type, and every sentence written in M3.1 and M3.2
that names `gitwarren service install` was, until this change, a sentence about
something that did not exist. This is the change that makes them true.

**One bundle, not two.** `src/daemon/serve.ts` became `src/cli/gitwarren.ts`,
and `out/daemon/serve.cjs` became `out/daemon/gitwarren.cjs`. The process entry
moved up a layer rather than being duplicated: `serve`, `open` and
`service install` share the core, the database and `core/paths.ts`, and a second
entry point would have put a second copy of all of it in a 40 MB tarball to save
nothing. `daemon/daemon.ts` went back to being only the daemon, which is what
its own header asks for, and `main/index.ts` still imports `runDaemon` from
source — so `GitWarren --serve` is the same daemon it always was.

`gitwarren serve` with no flag means `--listen`. `runDaemon` still requires one
of the two, which is right for a function whose callers are all programs; the
default is filled in by the router, at the layer that knows a human typed this.
Nobody types a command to get a pipe they are not holding, and M3's verify
sentence says `gitwarren serve` rather than `gitwarren serve --listen`.

**`open` carries the token, and nothing is pasted through.** It reads the
0600 `web-token` the serving process published, works out the mount from the
runtime file — `/` for a daemon, `/app/` for the app — and hands the whole URL
to the desktop. A link argument is *parsed to a `Route` and written back out*
rather than concatenated, which is the rule M3.1 arrived at the hard way; here
it also means a command an agent may well be the one running cannot be talked
into asking the operating system to open an arbitrary string. It starts nothing:
a server that is not up is reported, and the refusal names both `gitwarren serve`
and `gitwarren service install`.

**`service install` writes two files and registers one item.** The launchers
first — `~/.gitwarren/bin/gitwarren` and `gitwarren-mcp`, at the paths the Agent
Access panel already prints and M4 already plans to spawn — then a LaunchAgent,
a `systemd --user` unit or an at-logon Scheduled Task, each naming the *launcher*
rather than a node binary and a bundle. `--no-login-item` stops after the
launchers, which is what a VPS wants.

Nothing restarts a dead daemon, and that is a decision rather than an omission.
`serve --listen` has a refusal it is *meant* to exit on, and under `KeepAlive`
or `Restart=` that refusal becomes a process respawning every ten seconds for as
long as the user has GitWarren open. This was watched happening the right way
instead: with the app's own `serve` holding the directory, the LaunchAgent
started, wrote *"this machine's GitWarren is already being served… A data
directory has one owner"* to its log, exited 1 and stayed stopped.

**Four tarballs now, not two, and they carry the renderer.** macOS was added
because M3's verify sentence begins "on a Mac with no GitWarren.app, `brew
install` the formula", and a formula cannot pour a tarball that does not exist.
`out/web` was added because `serve --listen` has nothing to serve without it —
S3's tarball predated the web view entirely. Windows is deliberately absent: a
`.tar.gz` is not how anything is installed there, and both audiences are served
by the app and by `npx`.

**A Homebrew formula, hashed in the run that uploads what it names.**
`packaging/homebrew/gitwarren-cli.rb` is a template;
`scripts/build-homebrew-formula.mjs` fills in the version and four checksums
from tarballs that exist and fails on any that do not, and the release attaches
the result as `gitwarren-cli.rb` for the tap to copy. A tap that hashes the
release itself hashes it at a second time, against assets it has to hope are
final, and gets that wrong as `SHA256 mismatch` on a stranger's machine. The
token is `gitwarren-cli` and not `gitwarren`: the cask already owns that token,
and a formula sharing it would quietly turn the documented way to install the
app into a way to install the command line. The *binary* is `gitwarren` in all
three distributions.

**`npx gitwarren` ships no interpreter.** Someone typing `npx` has proved they
have Node, so the npm package declares `better-sqlite3` as an ordinary
dependency and lets npm deliver the prebuild — 724 KB against the tarball's 40
MB, and the Windows answer without a fourth build target. The root
`package.json` is not published and could not be: it is `private`, it describes
an Electron app, and its `postinstall` rebuilds native modules against Electron's
headers.

Verified on this Mac and in a bare `ubuntu:24.04` arm64 container, against
scratch data directories, with a repository and a review seeded over the CLI's
own stdio carrier. `gitwarren serve` printed its URL; `gitwarren open --print`
produced the byte-identical URL from the token file; Chrome opened it and the
token was gone from the address bar by the time the page painted, the review's
description and composer rendered over the socket, and `shell.capabilities` read
`{pickDirectory: false, revealPath: false, openAtLogin: false}` — M3.2's flags,
in the shell that has none of them. A `guiUrl` fragment landed straight on
`#/reviews/1/files` with the diff already there. The LaunchAgent, once nothing
else held the directory, served on its own and `gitwarren open` found *its*
token. The macOS tarball was unpacked into a Homebrew-shaped prefix with a
symlink in `bin` and used with nothing of the checkout in reach; the Linux one
answered the protocol and MCP `initialize` in a container with no Node at all.
No console errors and no failed requests in any browser run beyond Chrome's own
`favicon.ico` probe, which is still M3.5's.

Then the same scratch directory with the real app in front of it, because the
`gui` half of `open` is the half no headless test can reach. `gitwarren open`
switched to `/app/` on its own, carrying the token `web-view.ts` had just minted
- and that URL painted review 1 in Chrome with *zero* failed requests, since the
app's mount has a favicon to answer with where the daemon's root does not. The
Electron window itself reported `{pickDirectory: true, revealPath: true,
openAtLogin: true}`, the exact mirror of the browser's three, which is M3.2's
flag surviving the entry point being renamed underneath it. `service status`
named the owner as `GitWarren.app`, and `gitwarren serve` beside it refused with
M3.1's sentence rather than fighting for the port.

**A login item is a process with no working directory.** The bug worth keeping.
The first version of the launcher carried whatever `GITWARREN_*` variables the
installing process had been given, on the reasoning that only a packaging
decision would set one. True, and beside the point: `resolveMigrationsFolder`
and `resolveWebRoot` both fall back to walking up from `process.cwd()`, and
launchd starts a job in `/`. A launcher written from a checkout — where nothing
sets either variable, because walking up from the repository root finds both —
produced, at the next login, in a log file:

```
Error: Could not find the drizzle migrations folder. Looked in:
  /drizzle
```

Nothing was wrong with the launcher, the plist or the daemon. What was wrong is
that the question *where are the migrations* was left to be asked again later,
by a process that had lost the only context able to answer it. Both are now
resolved at install time and written in as absolute paths — which is exactly
what the tarball's `sh` preamble had always done for its own layout, and the
same decision generalised. The plist's `StandardErrorPath` is why this was a
sentence in a file rather than a silence.

**Two smaller traps, both cheap to keep.** `dirname "$0"` is the directory of
the *name a script was invoked by*, and `sh` does not resolve a symlink to get
it — so a Homebrew install, which is a symlink in `bin` pointing into a Cellar,
would have computed its root as `/opt/homebrew` and found no `lib`, no `drizzle`
and no `web`. The tarball's launchers follow the link one hop at a time before
computing anything (`readlink` without `-f`, which BSD only grew recently). And
`npm publish out/npm` does not publish a directory: npm reads a bare `<a>/<b>`
as a GitHub shorthand and goes looking for a repository, reporting it as *"An
unknown git error occurred"* with no mention of the directory it walked past.
It needs `./out/npm`, in the workflow and in the README both.

**Not done in M3.3, and why.** The daemon tarballs are not signed or notarised.
On macOS a `brew install` from a formula does not quarantine what it pours, so
Gatekeeper is not in the path today — but a user who downloads the same tarball
from a browser would meet it, and the honest fix is to notarise the bundled Node
and the two launchers, which is a signing-identity question rather than a
packaging one and belongs with the release work. `npm publish` is wired but
inert: it skips without an `NPM_TOKEN`, the name `gitwarren` is unregistered as
of today, and publishing under it is a decision to take deliberately rather than
as a side effect of the first tag after this merges. Nothing here is signed with
provenance either — `--provenance` needs `id-token: write` on the release job,
and widening that workflow's token is its own change. Windows' Scheduled Task
path is written and typed but has only been exercised on macOS and Linux;
`schtasks` is the one branch here no test on this machine can reach, the same
shape as the Windows launcher-banner bug M2 shipped, so it should be run on the
PC before the milestone is called done.

**M3.4, done on the Mac, 10 September.** The screen that hands GitWarren to an
agent. Most of the words were already right — M2 wrote the sentence and put it
above the snippet — so this change is mostly about where they live and who they
are true for.

**A location, not a disclosure.** `#/agent`, in the route grammar
(`shared/routes.ts`) with the host segment every other route takes, rendered by
`renderer/features/agent/agent-access-page.tsx`; what is left on the home screen
is a card that opens it. Two things asked for this and neither is cosmetic. In a
browser a URL is how you put a page in front of somebody — including the person
sitting at the machine being configured, who now gets sent a link rather than
told to scroll and click a chevron. And M4 has one of these per host: `#/h/<id>/
agent` is how you say "the setup for *that* machine", and the segment had to
exist before there was a second machine to point it at. `g a` opens it from the
palette.

**Three formats, one launcher path.** `shared/agent-setup.ts` holds the prompt
and the by-hand snippets, and `gitwarren agent-setup` reads the same module — so
the sentence a user copies out of a window and the sentence printed on a VPS
with no window cannot drift. The snippets are generated rather than written out:
`mcpServers` for Claude Code, Cursor, Windsurf and Gemini CLI; `servers` for VS
Code; `[mcp_servers.gitwarren]` for Codex. There is exactly one place a command
can now be wrong.

The TOML one has a test of its own, because it is the format that can be wrong
*quietly*. A Windows launcher path is `C:\Users\...\gitwarren-mcp.cmd`, and a
backslash inside a TOML basic string begins an escape — pasted raw, `\U` is a
real escape and the file parses into a **different path** rather than into an
error. Every backslash is doubled, and the test asserts no lone one survives.

**`gitwarren agent-setup`.** The prompt on stdout, the state of the machine on
stderr — so `gitwarren agent-setup | pbcopy` copies the sentence and not a
warning about the launcher. `--manual` adds the three formats. It installs
nothing: `service install` writes the launcher and this prints where it is,
which is the same line `open` draws.

**The page stopped inventing remedies.** This is the bug M3.3 pointed at. The
panel carried its own sentence for `available: false` — *"Run `npm run build`
first"* — written when the app was the only shell there was. Since M3.3 a
browser tab on a machine with no checkout can reach this page, and it was being
told to run a build script for a repository it does not have, *underneath*
`listen.ts`'s own perfectly good note naming `gitwarren service install`: two
warnings, one of them nonsense. The remedy now comes from the install and the
page prints it and nothing of its own — `main/mcp-launch.ts` grew the note it
was missing, so both shells answer the same question in their own words. Notes
name commands in backticks, which a terminal renders and a window did not, so
the page turns them into code spans on the way in.

**A refused clipboard is not a dead button.** `navigator.clipboard.writeText`
rejects when the document is not focused or the permission is not given, and a
button that only sets `copied` on success leaves the user pressing it at a page
that does nothing — on the one screen whose entire purpose is a copy. A failure
now selects the text instead and says so, which is what the person was about to
do by hand.

**The renderer has not been styled in a browser since M3.1.** The find that
matters, and it was found by looking at a screenshot rather than at the DOM.
Tailwind v4 detects its own sources by walking from the repository root and
skipping whatever `.gitignore` skips — correct in a checkout, silently wrong in
a worktree under `.claude/worktrees/`, which this repository ignores. The scan
found no `.tsx` at all, emitted the theme layer and stopped: a 6 KB stylesheet,
a successful build, no warning anywhere, and a web view with no borders, no
spacing and no type scale. `out/web/assets/main-DBjGUzRM.css` is byte-identical
in the M3.2 and M3.3 worktrees, so all three M3 verifications in Chrome were
done against an unstyled page — every assertion in them was about content, which
is why nothing looked wrong. An explicit `@source` in `renderer/src/index.css` is
scanned whether or not it is ignored; the web bundle goes from 6 KB to 45 KB and
the Electron renderer's CSS comes out byte-identical to before, because
electron-vite's own root never had the problem.

Verified in Chrome against a `gitwarren serve` and then, on the same scratch
directory with the daemon stopped, in the real Electron window. In the tab, with
a home directory holding no launcher: one warning, the daemon's own, naming
`gitwarren service install`; the prompt leading, styled, and copying to the
clipboard; the three tabs each holding the same path in their own syntax; a
forced `writeText` rejection selecting the prompt and saying "Selected — press
copy" instead of failing silently. In the window, with the real launcher
present: no warning at all, the same `~/.gitwarren/bin/gitwarren-mcp` the daemon
named, and the direct Electron-run-as-node fallback shown only there, since in a
daemon it is the launcher again. `g a` reached the page in both. No console
errors and no failed requests in either run.

**Not done in M3.4, and why.** The responsive pass and the favicon are M3.5,
which is the last slice. Two things are still open from M3.3 and are worth
repeating here rather than leaving behind: Windows' `schtasks` branch of
`service install` is written and typed and has been run on neither platform —
the one branch no test on this Mac can reach, the same shape as the Windows
launcher-banner bug M2 shipped, so it wants a run on the PC before M3 is called
done; and the daemon tarballs are unsigned and unnotarised, with `npm publish`
wired but inert without an `NPM_TOKEN` and the npm name `gitwarren` still
unregistered. Both of those are deliberate decisions to take on their own.

**M3.5, done on the Mac, 10 September.** The responsive pass, and the first
slice whose claims are about what a screen *looks* like rather than about what
it says. That distinction is M3.4's doing: until the `@source` fix, every M3
verification in Chrome was made against a 6 KB theme-only stylesheet, so
"verified in the browser" meant the content was right and could not have meant
anything about the layout. This one was done by taking screenshots at a real
390px and reading them.

**Measured first, then changed.** Chrome's device metrics rather than a resized
window — a window has a minimum width and its own chrome inside that, so it
never reaches the width a phone reports — plus a sweep that lists every element
whose right edge is past the viewport. The four screens went in with that list
in hand rather than with a guess about which ones would break, and it was worth
it: the home screen and the Agent Access page were already fine at 390px, and
two of the things that were badly broken were not on the bullet's list.

**Two layouts behind one button.** On a wide window the file list is a sidebar
*beside* the diff, remembered between visits, and clicking a file scrolls the
diff along behind it. Below `lg` there is no room for both — the tree took 224
of 390 pixels and left the diff a column rendering one character per line — so
it becomes the screen *instead of* the diff, and clicking a file is a
navigation: the list goes away and the diff arrives at that file.

The two keep separate state, which is the decision in this change most likely
to be undone by someone tidying up. They answer different questions — "do I want
a sidebar" against "am I looking at the index right now" — and one flag for both
would carry a remembered `true` off the desktop and open every review on a phone
at its table of contents rather than at the diff. The diff is hidden rather than
unmounted while the list is up, because going to the list and back is a step a
reader takes often and unmounting would throw away every hunk they had unfolded
to get there; that in turn is why the scroll to the picked file waits for an
effect, since `scrollIntoView` on a `display: none` element silently does
nothing.

**A row of controls that wrapped as a block, and hid half of itself.** The bug
worth keeping, and it had been shipping since long before M3. The files toolbar
is two groups inside `flex-wrap`, and the wrapping was on the outer row only:
the groups could move relative to one another but nothing inside a group could,
so below about 700px the second group ran off the end of the window. It did not
overflow — the page's `scrollWidth` stayed exactly the viewport width, because
the row is clipped rather than scrollable — so `Refresh` and the three-way view
toggle were not merely awkward to reach, they were *gone*, with no scrollbar, no
console message and nothing on screen suggesting anything was missing. Something
being off the edge of a page you can scroll is a nuisance; the same thing on a
page you cannot is a control that does not exist. Both groups wrap now. The same
shape, and the same fix, on the badges in each diff card's header.

**Paths and refs wrap at their separators.** M2 built `Breakable` and `FilePath`
for exactly this and several places had never been routed through them: the
repository card and the repository detail clipped a path to
`/Users/somebody/.cl…`, the removal dialog — the one screen whose whole question
is *is this the one you meant* — clipped the path it was asking about, and the
Agent Access page broke launcher paths mid-segment, turning one into
`/Users/somebody/.gitwar` + `ren/bin/gitwarren-mcp`. The worst of them was in
the review rows, where two truncating spans shared one flex line and got half
the row each: `main` rendered as `ma…`, an ellipsis longer than the text it
kept. All of them wrap at `/` now and all of them stay selectable.

Titles were left alone where they are prose and fixed where they are the
identity of a screen: the review heading wraps, the same title in a list row
still clips. A list of twenty reviews each three lines tall is harder to scan
than one that clips, and the full title is one tap away.

**The keyboard, which is two fixes in different languages.** The app scrolls
inside `<main>`, not inside the window — right for a desktop window, and exactly
what makes a phone keyboard awkward. By default a keyboard shrinks only the
*visual* viewport, so the browser's own "scroll the focused element into view"
has nothing but a pan to offer, and a pan cannot move content inside a scroller
it does not know about. `interactive-widget=resizes-content` in the web shell's
viewport meta makes the keyboard shrink the *layout* viewport instead, and the
`height` chain comes down with it — which is also why `html` is now `100dvh`
rather than `100%`: on a phone `100%` resolves against a viewport measured with
the URL bar hidden, so every screen sat a bar's worth off the bottom. The usual
objection to `dvh`, that it relayouts as the bar hides and shows, does not apply
where nothing scrolls the window.

That gives the scroll somewhere to go; `lib/keyboard-inset.ts` performs it, on
the composer rather than on the textarea. The browser will bring the focused
element into view on its own, and the focused element is the box you type in,
not the `Comment` button under it — landing with the caret visible and the
submit button still behind the keyboard reads as a composer that cannot be
submitted.

**A favicon, and where it had to live.** Chrome asks for `/favicon.ico` when a
document does not say what its icon is, and that 404 has been the one failed
request in every otherwise-clean verification since M3.2 — in a milestone where
"no failed requests" is the thing being checked. Answering the probe was the
wrong fix: the app mounts this build at `/app/`, so `/favicon.ico` there is the
link server's path and not this build's, and a page that depends on a sibling
route answering for it is wrong in one of its two mounts. Naming the icon in the
document means the probe never happens. The href is relative like every other
asset here, so it resolves under `/` and under `/app/` alike.

Verified in Chrome against a `gitwarren serve` and then, on the same scratch
directory with the daemon stopped, in the real Electron window — and then the
app's own `/app/` mount back in Chrome, which is the second mount the favicon
had to survive. At 390px and at 320px: no page scrolls sideways on any of the
four screens, and the only elements past the viewport edge are code inside a
diff's own horizontal scroller and the tab strip, which now scrolls rather than
wrapping "Files changed" onto two lines under a half-width underline. The file
list and the diff are separate screens and picking `shortcuts.ts` from the list
lands on that file's diff, in the browser and in the window both. With the
viewport dropped by an iPhone keyboard's 336px while the composer had focus, the
`Comment` button moved from y=844 to y=508 — the bottom of the shrunk viewport —
instead of being stranded off the end of it. At 1400px the sidebar, the
single-row toolbar, the single-line tabs and the single-line title are all
exactly as they were, and the `Files` button still hides the sidebar rather than
switching screens. **No console errors and no failed requests in any run,
including the favicon probe, which is the first time that sentence has been
true without an exception attached to it.**

**Not done in M3.5, and why.** Nothing of the responsive bullet is outstanding.
Two things carried through the whole of M3 are still open and are neither
M3.5's to close nor safe to lose:

- Windows' `schtasks` branch of `service install` is written and typed and has
  been run on neither platform — the one branch no test on this Mac can reach,
  the same shape as the Windows launcher-banner bug M2 shipped. It wants a run
  on the PC before M3 is called done.
- The daemon tarballs are unsigned and unnotarised, `npm publish` is wired but
  inert without an `NPM_TOKEN`, and the npm name `gitwarren` is still
  unregistered. Deliberate decisions to take on their own, not side effects of
  the first tag after this merges.

A phone has not touched this yet, and could not have: the daemon binds
`127.0.0.1` and there is no route to it from another device until M6 brings the
tailnet. What M3.5 claims is that when there is one, the screens are ready —
which is what "only a network away" was asked to mean.

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

#### How it is being built, and where it has got to

Five changes, each mergeable on its own, in the order that keeps every one of
them verifiable against the real `pc-wsl` node rather than against a mock:

1. **The hosts table, the carrier and the pool.** What it takes to reach
   another machine at all. *(done — see below.)*
2. **The Hosts screen and the installer over SSH.** `uname -sm`, the tarball
   fetched once and streamed in, the launchers maintained, and the screen that
   drives it. *(done — see below.)*
3. **Repositories on hosts.** `fs.list`, the host segment in routes, reviews
   listed under their host, clones grouped by root commit across hosts.
   *(done — see below.)*
4. **Attachments, editors and agent access per host.** *(done — see below.)*
5. **Disconnection.** The stale banner and the silent refetch. *(done — see
   below. M4 is complete.)*

**M4.1, done on the Mac against the WSL node, 10 September.** The novelty is
one file and an argument vector. Everything else M4 needs had already been
built to accept it: `shared/rpc.ts` is the protocol, `core/rpc/ndjson.ts` is
the framing, `core/rpc/stdio-client.ts` is the asking side, and what answers on
the far end is the same `gitwarren serve --stdio` M2 shipped. `core/hosts/ssh.ts`
contributes a child process, and that is genuinely all.

Everything below was proved by hand against `pc-wsl` *before* any of it was
written, which is the order this milestone rewards: the 44 MB tarball streamed
into `~/.gitwarren/daemon/<version>/` over the pipe in 2.5 seconds on a box
with nothing but git, and `{"id":1,"method":"repositories.list"}` came back
`{"id":1,"result":[]}` — with the two responses arriving *out of order*, which
is the property the `id` field exists for and the first thing a hand-rolled
client would have got wrong. `stdout` is pure protocol; the `ready` banner is
on stderr, where framing cannot be hurt by it.

**The framing moved before it was copied.** M2 read frames in `stdio.ts`
because only the daemon read them. M4 has a client too, and two implementations
of "where does a frame end" produce a *hang* rather than an error — both ends
healthy, both waiting, nothing logged. So `ndjson.ts` came out first and both
sides are users of it.

**The client's most important decision is not to be clever.** When a connection
dies mid-flight there is no way to tell "the daemon never saw it" from "it did
the work and the reply died on the way back". Retrying is safe in the first
case and posts a second comment in the second, so every in-flight request fails
with `HOST_OFFLINE` and none is resent; reconnection is about the *next*
request. The web carrier settled this identically at M3.

**Backoff belongs to the host, not the request.** A screen polling every
fifteen seconds against a machine that is switched off must not spawn four
`ssh` processes a minute for an hour, so a failed host refuses immediately for
a while rather than hopefully — fast is kinder than hopeful, and M4.5's banner
needs something to render. The one deliberate exception is an explicit probe: a
person pressing "try now" knows something the timer does not, usually that they
have just switched the machine on. Ten idle minutes closes the pipe, matching
`ControlPersist` so the multiplexing master and the daemon expire together, and
"idle" is measured from when a request *finished* — a naive timer hangs up on a
large `reviews.diff` halfway through its own answer.

**`hosts.*` is answered here and never forwarded.** A host's list of hosts is
its own business, and routing these onward would turn a hub and its spokes into
a mesh where removing a machine from one list could remove it from another.
`isLocalOnly` in `ssh.ts` refuses to send them, so the rule is structural
rather than a comment; M4.3's router is where the general local-versus-remote
decision will live.

**Two things bit, and both are worth keeping.**

*The useful half of a failure arrives after the failure.* The protocol notices
a dead connection when the far end's stdout ends — which for a failing `ssh` is
a moment *before* the `exit` that carries the status code and after which
stderr is complete. Reading the reason at the instant the request failed
therefore reported "The connection to the host closed." for a hostname that
does not resolve: true, useless, and exactly the message a person would have
been left with. `diagnostics()` is now a promise that waits briefly for the
exit already on its way, and the same host now says `ssh could not connect to
xfor@no-such-host-here. ssh: Could not resolve hostname no-such-host-here`.
This was found by running the thing against a real machine and reading the
output rather than by a test passing.

*`BatchMode=yes` is what turns a hang into an error.* Without it `ssh` waits at
a passphrase or host-key prompt on a stdin carrying JSON and no human, and the
GUI spins forever. Key management stays the person's own, in their SSH agent
and config; GitWarren never asks for a password and has nowhere to keep one.

`instance_id` on a host row is nullable on purpose. Someone types a target and
presses Add, and at that moment nobody knows which machine that is, or whether
it answers — so NULL is the honest record of a host *described* but not yet
*met*, and the identity is learned on the first successful connect and written
back. It is what catches one machine added twice under two names (`pc-wsl` and
`xfor@100.78.0.23`), which neither label nor target can see and which is
reported rather than merged.

Verified end to end against `pc-wsl` through the shipping code, not by hand:
the host reachable in 178 ms cold and 4 ms warm on the multiplexed channel, its
instance id learned and written back, a `NOT_FOUND` surviving the wire as
itself while leaving the host marked up, `hosts.list` refused by the carrier, a
deliberate hang-up starting no backoff and the host reachable again after it,
and an unreachable machine failing in 18 ms with what `ssh` actually said. A
host that answers `ssh` but has no GitWarren exits 127 and is told so by name,
which is the single most likely outcome of adding a host until M4.2 lands.

The whole protocol contract in `rpc/__tests__/dispatcher.test.ts` now runs a
third time, through `stdio-client.ts` against `stdio.ts` — so the thing under
test is the thing that ships, and the test's own hand-rolled client is gone.
Four assertions about the response *envelope* are skipped for it rather than
faked: a client that assigns its own ids and unwraps its own outcomes cannot
ask a question under a chosen id, and a `send` built on top of it would echo
back whatever the test passed in and assert nothing.

**Not done in M4.1, and why.** There is no Hosts screen yet, so a host is added
through the dispatcher and not by anyone using the app — that and the installer
are M4.2, which is why they are one slice: the screen's main job is to drive
the install. Nothing installs the daemon on a host, so it has to be put there
by hand for now. Repositories on hosts are M4.3, so `hosts.remove` deliberately
leaves any repository rows pointing at that host alone rather than cascading —
a cascade written now would have to be unpicked once there is a remote
repository to have an opinion about.

**M4.2, done on the Mac against the WSL node, 10–11 September.** A machine with
git on it and nothing else is now four commands away from being reviewable,
and all four go down a connection that was already open:

    uname -sm                                which tarball
    ~/.gitwarren/bin/gitwarren --version     whether there is anything to do
    tar xzf -            reading stdin       the bytes
    …/bin/gitwarren service install          the launchers

`core/hosts/release.ts` decides which file that is and gets it onto *this*
disk; `core/hosts/install.ts` is the sequence; `hosts.install` on the
dispatcher is how a screen asks. Nothing was added to `ssh.ts` but
`runOverSsh`, because "how this app invokes ssh" is one decision and
`SSH_OPTIONS` is where it was already written down — which is also why `uname`
on a host with a connection open costs a process spawn and no crypto.

**The host writes its own launchers, and that is the load-bearing choice.** It
would be a shorter file to `echo` two `sh` scripts into `~/.gitwarren/bin` from
here. `src/cli/launchers.ts` already knows what a launcher looks like, down to
the symlink loop and the two absolute paths a login shell cannot work out for
itself, and a second implementation across an ssh pipe is a copy that drifts.
The better reason is that running the binary we just unpacked is the only
*proof* that the architecture was picked correctly: a linux-arm64 tarball on an
x86-64 box gets as far as a perfectly successful `tar` and then dies at the
first `exec`, and that is much better discovered during an install someone is
watching than at the first review they try to open. `--no-login-item` is passed
because a remote host is not where a login item belongs — the carrier spawns
`serve --stdio` on demand and hangs up after ten idle minutes, and a daemon
that also started itself at boot would be a second process on one database
that nobody asked for. That flag was added in M3.3 for the VPS case, before
there was one.

Unpacking goes to a scratch directory beside the destination and is moved in
with one `mv`, because a `tar` interrupted halfway through the destination
itself leaves a directory that exists, looks installed and cannot run.

**Verification was the point, and it was destructive on purpose.**
`~/.gitwarren` on `pc-wsl` — which since M4.1 held a hand-built daemon that was
ahead of the published beta — was deleted, and everything below was done by the
shipping code onto a machine with nothing on it. From the app: 46.4 MB streamed
in 3.4 seconds, the launcher and `gitwarren-mcp` written by the host's own
`service install` with absolute paths into
`~/.gitwarren/daemon/0.1.7-beta.1/`, `service status` reporting no login item,
the instance id learned and the row reading *Reachable · GitWarren
0.1.7-beta.1*. Then the same screen in a Chrome tab against the same core:
"already up to date, nothing was sent", and Forget. No console errors in
either, and no horizontal scroll at 390 px.

**Three things bit.**

*One failed press climbed two rungs of the backoff ladder.* A probe of a host
with no GitWarren on it came back `failures: 2`. A dying connection is noticed
twice — the close handler sees stdout end, and every request waiting on it
rejects — and M4.1's pool counted both, so a machine that was switched off went
from a one-second wait to a fifteen-second one after two attempts instead of
four. The pool's own tests could not see it: their fake connection rejects a
request without ever closing, which is a shape a real `ssh` never has. Failures
are now counted once per connection, by generation. The *message* still takes
the later of the two, deliberately — the close handler arrives first with "the
connection closed" because that is all that is known when stdout ends, and the
request's own failure arrives a moment later having waited for the exit status
and says "GitWarren is not installed on xfor@pc-wsl". Keeping the first because
it was first would have undone the thing M4.1 went to some trouble to get
right. Two tests now assert both halves.

*The remote command is run by the login shell, and on that box it is zsh.* Not
`sh`, whatever `#!/bin/sh` might suggest — `ssh host '<script>'` hands the
string to whatever the account's shell is. The unpack script was already free
of bashisms and of `--strip-components` (busybox `tar` has never had it, so the
archive's own directory is moved rather than stripped), so it ran unchanged;
had it not been, this is the sort of thing that fails on someone else's server
and nowhere else.

*The published tarballs cannot be downloaded yet, and that is not a workflow
bug.* `release.yml` on `main` builds all four targets, but the tag
`v0.1.7-beta.1` predates that change — at that tag the daemon job built linux
only, which is why the draft carries two tarballs and no Homebrew formula. The
next tag gets macOS. Separately, a *draft* release's assets 404 for everyone,
so nothing can install from this one until it is published; the 404 says so by
name rather than reporting a bare status code. `GITWARREN_DAEMON_TARBALL_DIR`
is what makes a development build installable at all — its version is
`0.0.0-dev`, which no release has ever heard of — and it is the same answer an
air-gapped machine with the file on a stick needs, which is why it is a
directory rather than a flag on a form. Everything above was verified through
it, with a `linux-x64` tarball built by `scripts/build-daemon-tarball.mjs`.

**The Hosts screen needed no capability flag, and that is the M3.2 design
working.** Every control on it is one `carrier.request`; in a tab that reaches
the daemon's core rather than the app's, and what gets managed is *that*
install's list of hosts — which is correct, because `hosts.*` is answered by
whoever is asked and never forwarded. `shell.capabilities` exists for controls
a tab genuinely cannot offer, and installing over ssh is not one of them: the
install runs wherever the core runs, and that this may be a different machine
from the browser is the point of the milestone rather than a problem with it.
`#/hosts` is accordingly the one route in `shared/routes.ts` that is not host
scoped, and the type says so.

The install is one request with no progress and no timeout, and both are
deliberate. `shared/rpc.ts` reserves an event channel for M6 and nothing emits
on it; inventing half of one for a progress bar would put a push-shaped hole in
a request/response protocol for a wait that is three seconds on a LAN. There is
also no number of seconds after which abandoning a part-finished install would
be an improvement. The screen says how big the download is and shows the
outcome in a dialog rather than a toast, because a person who pressed a button
and went to make tea should not have to have been watching — least of all for
the failure, which is `ssh`'s own words and the only thing that says what to
fix.

**Not done in M4.2, and why.** There is no remote uninstall. `hosts.remove`
forgets a row on this machine, and the dialog says so in as many words; going
onto somebody's server to delete a directory is a different act, and
`rm -rf ~/.gitwarren` is one they can type and read before pressing return. Old
versions accumulate under `~/.gitwarren/daemon/` and are not pruned, because
two GitWarrens on two laptops can point one host's launcher at different
versions and deleting the other's install is not this one's decision to make.
Nothing on the screen reaches a *repository* on a host yet — that is M4.3, and
until it lands a host is a machine you can install onto and prove reachable,
which is exactly what M4.2 set out to be.

**M4.3, done on the Mac against the WSL node, 11 September.** A host stops
being a machine you can install onto and becomes a machine you can review. The
slice is one method, one router and a segment in the URL, and the reason it is
not more than that is that M4.1 and M4.2 had already built the hard half:

    fs.list                     browse a filesystem you cannot see
    core/hosts/router.ts        answered here, or answered over there
    #/h/<instance>/…            which machine a link is about

**A host is a place you go, not rows in this database.** The design question
this slice actually had to settle was where a remote repository *lives*, and
`repositories.host_id` — a column M0 added and nothing had ever written — made
one answer look obvious: keep a row here per repository over there, so a list
can be drawn without touching the network. It was the wrong answer, and rules 1
and 2 say so plainly. A host owns its repositories: the row for
`~/github.com/klarluft/gitwarren-app` on `pc-wsl` is in *that machine's* SQLite,
its reviews hang off it there, and the agent inside WSL reads them over its own
local MCP. Nothing syncs. A second row over here would be a copy of a name and a
path only that machine can keep true, and it would give one repository two ids —
while `#/h/<instance>/repositories/<id>` has always meant "that id, as that host
knows it".

So `#/h/<instance>/` is a host's repository list, fetched from the host, when
somebody asks for it. The Hosts screen is where you ask; M4.2's host card said
in a comment that it led nowhere "until M4.3", and now it has a button. The
button appears only once the machine has said who it is, because a route needs
an instance id and a host that has been described but never met has none — the
same honesty `instance_id` being nullable buys everywhere else, arriving at the
UI, and "Try now" is what makes the button appear.

That also settles the question M4.1 left open. **`hosts.remove` has nothing to
cascade to.** No row in this database names a host, so forgetting one forgets a
way of reaching a computer and leaves every repository, review and comment over
there exactly where it was; adding the host again reaches all of it again. The
column stays, because dropping it is a migration that buys nothing and "this row
is local" is still a claim worth making in SQL, and its comment now says what
would have to become true for anything to write it.

**Not fanning out is a feature, and it is the same argument as connect-on-use.**
A home screen listing every host's repositories would open an `ssh` connection
to every machine on the list in order to render — which is precisely what
`core/hosts/pool.ts` exists to avoid, and what M4.2 already refused to do for a
version number. One host, one visit, one connection.

**The host rides on the envelope.** `RpcRequest.host` is an instance id, and it
is deliberately not a `hostId` field on every input schema. *Where* a request
goes is not part of what a method means — `reviews.diff` has one meaning and it
is the same on every machine — so threading a host through the service, the MCP
tool and the zod schema would teach three layers about a thing none of them has
any business knowing. It also has to be *strippable*: the router removes it
before forwarding, which is what makes a chain of hosts impossible to build by
accident. What arrives at the far end has no host on it, so the far end answers
it. A hub cannot be talked into becoming a spoke.

Three ways a request stays here: no host at all, which is nearly every request
and is byte-for-byte the request it was in M0; *our own* instance id, which is
what another GitWarren writes when it links to this one and is rule 4 in a
single comparison; and `hosts.*`, checked before the host is even resolved,
because a host's list of hosts is its own business. `isLocalOnly` in `ssh.ts` is
still there as a backstop, and the belt-and-braces is on purpose — a routing bug
should not be able to put one on a wire.

Carriers now come through `handleRoutedRequest` rather than `handleRequest`, so
the decision is made once instead of in each of them. The Electron window, the
daemon over a pipe and a browser tab all get remote hosts from the same change,
and the tab case is the one that shows the shape is right: a tab reaches the
core, and the core is the hub whether or not it happens to have a window.

**`fs.list` exists because of a capability, not a domain.** It is the only
method here that is not about reviews, and the comment
`repository-form-dialog.tsx` has carried since M3 is why: a browser tab has no
folder picker, and on a remote host the picker the shell *does* have would
browse the wrong machine and produce a path `pc-wsl` has never heard of. So the
gesture splits — opening a window stays in the shell, "what is inside this
folder" becomes a method — and the native dialog is now used in exactly one
case, a local form in the Electron window.

A listing carries more than names, because the asking side has to draw a picker
for a filesystem it has never seen: the parent (null at the root, which is how
the screen knows to stop offering "Up"), where home is, the separator, and
whether each folder holds a `.git`. That last one is what makes it beat a text
field — it answers "is this the folder I want" without descending into it. One
column rather than a tree, because every expanded node in a tree is a round
trip over an `ssh` pipe and the thing being looked for is one folder, not a
structure worth understanding. The path stays editable throughout, since for
someone who knows where they are going, typing beats any number of clicks.

Hidden folders are listed and flagged rather than filtered, and the decision is
the screen's: dotfile repositories are a real thing people review, and a listing
that silently dropped rows would be one you could not trust when what you wanted
was not in it. A leading `~` is expanded by whoever answers, because that is the
only machine that knows what it stands for — someone adding a repository on
`pc-wsl` knows it is under `~/github.com` and has no reason to know that is
`/home/xfor` over there.

There is no sandbox, and that is a decision rather than an oversight.
`repositories.add` already takes any absolute path on the host and reads git
there, so a caller who can reach the dispatcher can already name any directory
on the machine; a traversal check on this one method would be theatre next to an
open door. The real boundary is who may reach the dispatcher — `core/web/token.ts`
for a tab, the person's own SSH keys for a host.

**Clones are grouped by the commit their history starts at.** Two checkouts of
one project on two machines share a root commit and nothing else — not their
path, and usually not their name — so `rootCommit` joins `RepositoryGitState`
and a row on a host's list that matches one here becomes a link to the local
clone. `--first-parent` is what makes it a single answer rather than a set: a
history that has ever absorbed another project by merge has two roots, and a set
is not a key, while the root of the first-parent chain is. It is cached per path
for the run, because it is the one thing in that module that cannot change while
the app is open and `rev-list` walks to the beginning of time to find it.

The comparison runs from the host towards this computer and not the other way,
and the reason is what each list costs. This machine's repositories are one
local SQLite read, free from anywhere; another machine's are a connection. The
grouping is made where it is free.

**What a remote screen deliberately does not offer.** Three controls disappear
rather than doing something plausible: revealing a path, which would open a
Finder window on this Mac at a path only WSL has; opening a file in an editor,
which would join the two halves M1 kept apart across a network and hand a Mac
editor a path from a different filesystem; and attaching an image, because an
attachment is a file in the owning host's store and the *displaying* half of
that is M4.4 — ingesting now would put a real image on `pc-wsl` and render it
here as a broken one, in a comment nobody could fix except by editing markdown
by hand. Absent rather than disabled, which is the rule M3 set for a browser
tab: a disabled control is a promise the shell cannot keep.

**Four things bit.**

*Emptying the editor list did not remove the button.* The open-in-editor control
in `diff-view.tsx` is drawn when it is given a *callback*, not when there is an
editor to name — so a remote review lost its editor picker and kept its buttons,
and pressing one asked *this* install for `reviews.filePath` of a review id that
means something else over there. On a machine with no review of that number it
is a `NOT_FOUND`; on one that has a review of that number it opens an unrelated
local file, which is the single failure shape this slice set out to prevent.
Found by pressing it against `pc-wsl` and reading what happened, not by a test.
The callback is now undefined on a host, so the button has nothing to be drawn
from.

*The banner accused a perfectly good host of not existing.* For the first frames
of a cold load the host list has not arrived, and `hosts?.find(...)` answers
undefined — which the banner rendered as "a host this GitWarren no longer
knows". It is the same mistake `host-status.tsx` already has a paragraph about
in the other direction: an unanswered question is not the alarming answer, and
"not loaded yet" is not "not known". Caught by watching a reload rather than by
reading the code, and the fix is to tell the two apart rather than to make the
sentence quieter.

*Two lists, one cache key.* A read-coalescing key and an SWR key that ignore the
host make "the repositories on `pc-wsl`" and "the repositories on this Mac" the
same question, and hand the second asker the first one's answer. Every id in
this app is a per-host autoincrement integer — the point `shared/routes.ts`
makes about links is just as true of a cache — so the host is part of the key in
both carriers and in `CACHE_KEYS`. It goes on the *end*, after the prefix, so
that the family-wide `startsWith` invalidation still works.

*The host was running a daemon older than the method.* The first run against
`pc-wsl` answered `fs.list` with `Unknown method "fs.list"` in twelve
milliseconds, and reported no `rootCommit` — because the daemon over there was
the published 0.1.7-beta.1 and both are new here. That is version skew behaving
exactly as `RPC_PROTOCOL_VERSION` was reserved for: an unknown method comes back
as an error a caller can read rather than as a hang, and an absent field is
absent rather than wrong. It is also the case a person will hit, so it is worth
saying plainly: **a host has to be reinstalled from the GUI before M4.3's
screens work against it**, which is one button on the Hosts screen and four
seconds.

**Verified end to end against `pc-wsl` through the shipping code.** The daemon
reinstalled from this build (46.4 MB in 4.5 s), then: `fs.list` on the host in
129 ms cold and 6 ms warm on the multiplexed channel, answering `/home/xfor`
with `/` as its separator and `/home` as its parent; `~/github.com/klarluft`
expanded over there into five folders, every one of them marked as a repository;
the same method with no host answering `/Users/michalwrzosek`, which is the
whole point of it being a method. A folder that is not there came back as
`PATH_NOT_FOUND` with its own sentence intact after the round trip. Two
repositories added on the host and listed from the Mac with their WSL paths; the
clone marker on exactly one of the two rows, naming this machine's checkout of
the same project, and clicking it landing on `#/repositories/1` — a local route,
no host segment. `hosts.list` with a host on the envelope answered here. A stale
link to a machine nobody knows failing as a lookup rather than a network wait,
with the id in the message. A review created on the host from the Mac, opened at
`#/h/<instance>/reviews/2/files`, commented into `pc-wsl`'s database and read
back — while review 2 *here* was a different review entirely, which is the
clearest possible demonstration of why the segment had to exist. No console
errors, and no horizontal scroll at 390 px.

**What M4.3 found next door.** Electron's `contextBridge` strips everything
but `message` off a rejected promise, so `AppError.code` and `fieldErrors` do
not survive the preload: in the packaged window `errorCode(error)` is always
null and `firstFieldError` always undefined. This predates the milestone —
adding an already-tracked repository has been showing its duplicate-path message
in the form's general slot rather than under the field since M1 — and it is not
specific to hosts; the shell channels lose their codes the same way. A browser
tab is unaffected, because its carrier throws in the same world it is caught in.
The fix is to stop throwing across the bridge, and it landed immediately
afterwards as a change of its own rather than being folded in here, because it
is about where M1's boundary sits and not about hosts. `window.gitwarren` now
exposes a `BridgeCarrier` that answers with an `RpcOutcome`; `outcomeOf` in
`shared/rpc.ts` is the counterpart to `resultOf` that builds one, and
`lib/api.ts` unwraps in the renderer's own world, where a thrown `AppError` is
still an `AppError`. It is the rule every other carrier already followed,
arriving at the one boundary nobody had thought of as a wire. The shell channels
still throw and still lose their codes, deliberately: nothing branches on a
shell error's code, so converting twenty signatures would be churn.

Two things that had been silently broken came back with it — a duplicate
repository path is reported under the path input again rather than in the
dialog's banner, and M4.3's "this host is not answering" state renders in the
window and not only in a tab. The second was proved by moving
`~/.gitwarren/bin/gitwarren` aside on `pc-wsl` mid-session and killing the
daemon that was already running: the screen showed *GitWarren is not installed
on xfor@pc-wsl: ~/.gitwarren/bin/gitwarren was not found*, with a Try again, and
came back on its own once the launcher was put back.

**Not done in M4.3, and why.** Attachments, editors and per-host agent access
are M4.4, and the three controls above are switched off rather than half-built
in the meantime. `attachments.ingest` would route to a host correctly today, but
the renderer sends an `ArrayBuffer` and `stdio-client.ts` still serialises with
plain `JSON.stringify` — the web carrier solved this in `web/wire.ts` and that
encoder wants to move somewhere both can use it, which is M4.4's first job.
Deep links still carry no host: an agent's `gitwarren://` link written on
`pc-wsl` is a local link, and opening it on the Mac shows the Mac's review of
that number. That is rule 4 needing the loopback fragment to grow a host
segment, and it belongs with M6's live links rather than here. There is no
disconnection banner and no silent refetch — a host that goes away mid-review
still empties the screen — which is M4.5, and the reason its error state already
has a shape to grow into.

**M4.4, done on the Mac against the WSL node, 11 September.** The three controls
M4.3 switched off rather than half-built are back on, and each of them turned out
to be the same shape: a thing that used to mean "this computer" implicitly, made
to say which computer it means.

    frame()                     a request becomes bytes, once
    attachments.read            the store is over there
    (host, path, line)          the editor is here, the file is not
    app.mcp                     that machine's launcher, as it resolves it

**One encoder, because two answers to "how does a request become bytes" is a
hang.** `attachments.ingest` routed to a host correctly in M4.3 and still could
not work, because `stdio-client.ts` wrote `JSON.stringify` and that is the one
function an `ArrayBuffer` does not survive: the image arrived as `{}` and was
refused for not being a PNG, which is a sentence about the *file* for a fault in
the *wire*. The web carrier had already solved this in `web/wire.ts`, so the fix
was to move it rather than to write it — `shared/rpc-wire.ts` now, read by the
WebSocket carrier and by the stdio client. It is the same argument `ndjson.ts`
records about framing, one layer up, and it is worth noticing that the two
failures differ only in how loud they are: two framings hang, two encodings lie.

**A body may not name a machine.** The obvious place for the host is the token —
`gitwarren://attachment/<host>/<sha>.<ext>` — and it is wrong for the reason
`repositories.host_id` was wrong in M4.3. A comment body is stored text on one
machine; it is read by that machine's own agent over its local MCP, quoted into
other comments, and edited by hand. An instance id inside it would be a claim
about somewhere else that nothing keeps true. So the token is untouched and the
host is attached at the `<img src>` — the one place that already differs between
the two shells and the one place that knows which screen is being drawn. The
local case is then the token byte for byte, which is what makes every comment
written before this milestone render exactly as it did.

A query rather than a path segment, so the pathname a server resolves is still
`<sha>.<ext>` and the whitelist in `shared/attachments.ts` is still the whole of
what reaches a filesystem. Both servers ask `isAnsweredLocally` rather than
their own question, so "no host", "our own instance id" and "somebody else's"
cannot come to mean something different in the custom scheme from what they mean
in the router.

**base64 on the way out, and one buffered read.** `attachments.read` answers
with the file encoded, because the response is `JSON.stringify`d onto an ndjson
frame and the carrier under it has no notion of a partial body. That costs a
third in size and gives up streaming for remote images; the ingest limit bounds
it at ten megabytes, and the name being the hash of the bytes means the
`immutable` cache header is honest, so a tab or a window pays once. Inventing
range requests over an `ssh` pipe for pictures that are already bounded would be
a second protocol for no one.

**Every fallback in an editor launch ends at this machine's filesystem, so each
one had to be asked whether it can say "over there".** `main/editors.ts` has a
URL form, a CLI form and the `GITWARREN_EDITOR` template, and the shape the host
argument forces is that the ones with no remote spelling must *fail* rather than
fall through: `shell.openPath('/home/xfor/…')` on a Mac opens a different file or
none, which is precisely the failure M4.3 hid the button to avoid. Three editors
have a remote form, so a Mac with only Zed on it gets an empty list and no
button — the honest answer, and the thing M4.3 got wrong in the other direction
by emptying the list while leaving the callback.

`remotelyOpenable` is in `shared/editors.ts` and not in either shell, because two
different questions are being asked and only one of them is about this machine.
What is installed is detection; whether an editor can be pointed at another
computer is a property of the editor.

**`{host}` in the custom template expands to the editor target, and an argument
that becomes empty is dropped.** That is what lets one template serve both cases:
`--remote={host}` disappears on a local file, where `--remote {host}` as two
arguments would leave the flag behind with nothing after it. `custom` counts as
remote-capable on purpose — whether somebody's `emacsclient` wrapper works is
theirs to find out, and refusing to offer it would remove the only way to try.

**The editor target is a second name for a machine, and it is kept apart from the
first.** `hosts.editor_target` has existed since M0 with nothing writing it; NULL
means derive `ssh-remote+<target>`, which is right until somebody's SSH config
aliases differ from their editor's, and stops coinciding by default at M5 where
the carrier is `wsl.exe -d Ubuntu` and the editor form is `wsl+Ubuntu`.
`editorTargetFor` sits next to `routeFor` in spirit — how the carrier names it,
how an editor names it — but lives in `shared/` because a browser tab builds the
same URL and cannot read a database.

**Agent access per host is a fact travelling, not a capability.** `app.mcp`
returns `~/.gitwarren/bin/gitwarren-mcp` *as the host resolves it*, which is the
whole point: a Mac has no way to know what `~` is on `pc-wsl`, and a page that
guessed would hand somebody a command that confidently does not exist. It says
where a launcher is and does not start one, which is the line `shared/web.ts`
draws and the reason it may be on the dispatcher at all. `describeMcpLaunch`
moved into `core/mcp-launcher.ts` so the daemon's `app-info` and this method are
one answer, and `gitwarren agent-setup` on the host prints the same sentence from
the same `shared/agent-setup.ts` — verified by running both.

What changes around the prompt matters as much as the prompt. This page is an
instruction, and the one way it can do harm is by being confidently about the
wrong computer — so a host's copy says "an agent running on that machine", and
everything this install knows only about *itself* is left out rather than
repeated under another machine's heading: the database path, the version, and
the link-port warning, which is about whether a `gitwarren://` link will open on
the computer you are sitting at.

**Verified end to end against `pc-wsl` through the shipping code**, with every
call made over `window.gitwarren.carrier` in the real window so that the preload,
the router, the pool and the `ssh` carrier were all in the path. The daemon was
reinstalled from this build first (46.4 MB in 5 s) and answered `Unknown method
"app.mcp"` and `Unknown method "attachments.read"` before it — version skew
behaving as designed, and the same reinstall M4.3 needed.

A 5,035-byte PNG made in the renderer went out as an `ArrayBuffer`, crossed the
pipe and landed in `/home/xfor/.config/GitWarren/attachments/…` with its
dimensions read correctly on the far side, which is the proof the bytes were
bytes rather than `{}`. `attachments.read` fetched it back in 11 ms warm;
the same name asked of *this* machine answered `NOT_FOUND`, which is the
clearest statement that nothing was copied here. The token in a comment body on
the host rendered in the window as a 320×200 image in 15 ms, with the host in
the `src` and the token unchanged in the body, and again after a cold reload. The
same bytes came back over the loopback HTTP endpoint as `image/png`, 5,035
bytes, behind the session cookie. The same token with no host, with an unknown
host, and a percent-encoded traversal in place of the name all failed.
`reviews.filePath` on the host answered a WSL path in 19 ms and
`shell.openInEditor` opened it — line 3 of `docs/across-hosts.md`, per VS Code's
own per-window memento, in a window whose authority is `ssh-remote+xfor@pc-wsl`.
`app.mcp` answered `/home/xfor/.gitwarren/bin/gitwarren-mcp` in 18 ms and
`/Users/michalwrzosek/…` with no host; `#/h/<instance>/agent` showed the first
and no trace of the second. The remote files tab draws *Open in VS Code* again
and no reveal button; the remote conversation tab draws *Attach an image*. A
local paste still produces a `src` identical to its token and still renders. No
console errors, and no horizontal scroll at 390 px.

**Three things bit, and one of them is mine rather than the code's.**

*The Agent Access page was reading the wrong machine by construction, and so was
every image.* `agent-access-page.tsx` and `components/markdown.tsx` both imported
the module-scope `api` — which is `apiFor()`, this install, always. M4.3's
`useApi()` exists precisely so that a screen does not have to think about hosts,
and the two files that predate it were quietly opting out. `markdown.tsx` needed
a component extracted to call a hook at all, which is the small cost of the
pattern and worth paying: there is now nowhere in a comment body's rendering
path that *can* name the wrong store.

*A picked file is a path on the machine with the picker, not on the machine with
the store.* `attachments.pick` used to end in `attachmentsService.ingest({ path })`,
and a path is the one form that cannot travel — `/Users/…/screenshot.png` means
nothing on `pc-wsl`. So the shell channel takes a host, and for a remote review
reads the bytes and sends those, stat-checking the size first exactly as the
store does so that a wrong file is refused without being pulled into memory on
its way to a wire. It is the same asymmetry M4.3 found with `fs.list`: the shell
can open a window, and only the owning machine can hold the result.

*`fetch` cannot test an `<img>`.* Probing the custom scheme with `fetch` from the
renderer failed with `connect-src 'self'`, which for some minutes looked like the
scheme being broken rather than the CSP doing its job — `img-src` is what an
attachment is allowed under, and an `Image()` load is the only check that
exercises the path the app actually uses. Worth writing down because the next
person to verify this will reach for `fetch` too.

**Not done in M4.4, and why.** The native picker's dialog cannot be driven from
a script, so the remote branch behind it was exercised by sending the same bytes
over the same carrier rather than by pressing the button; the stat guard and the
basename are covered by nothing but reading. The editor picker never appeared
during verification because this Mac has exactly one editor installed and it is
remote-capable, so `remotelyOpenable` reducing a list is covered by its unit
tests and not by the machine. A browser tab was checked at the HTTP endpoint and
not with a browser open in front of it. And deep links still carry no host, so a
`gitwarren://` link written on `pc-wsl` opens the Mac's review of that number —
unchanged from M4.3, and still M6's.

**M4.5, done on the Mac against the WSL node, 11 September.** A machine can now
go away in the middle of being reviewed. The banner is the visible half and was
the easy one; what the slice is actually about is the two halves either side of
it — knowing, and coming back:

    lib/host-reachability.ts    which machines have stopped answering
    onErrorRetry                something has to go on asking
    use-reconnect.ts            one read coming back brings the rest with it
    ShellConnection             the *other* disconnection

**The push nobody built, and why that is the same argument as M4.2's.**
`core/hosts/pool.ts` has carried an `onStateChange` hook since M4.1 with a
comment saying this slice would render it. Nothing passes it, and it is still
nothing. A push from the pool has nowhere to travel: `RpcEvent` in
`shared/rpc.ts` is reserved for M6 and nothing emits on it, so the state would
have had to reach a screen down an Electron IPC channel for the window *and*
down the WebSocket for a tab — two half-built event channels, in a
request/response protocol, for one banner. That is exactly what M4.2 refused to
invent for a progress bar, and the refusal is easier here, because in this case
the signal already exists.

The signal is the reads the screen is making anyway. An open review polls
`reviews.open` every fifteen seconds; when the machine goes away that read fails
with `HOST_OFFLINE`, and when it comes back the same read succeeds. Both halves
of "disconnection" are already arriving, on the one path that also knows whether
there is anything on screen to mark stale. `lib/api.ts`'s `ask` is where every
question this window asks of another computer passes with the host still in
scope, so it is the one place that can notice, and it is four lines.

What the pool knows and this does not is the state of hosts *nobody is looking
at* — which is precisely the set with no screen to put a banner on. That is
M6's `host.state` event, where a machine going away is news whether or not
anything is open on it, and the hook's comment now says so.

Polling `hosts.list` was the other candidate and is worse than either. It is
cheap — `hostsService.list` reads the pool rather than connecting — but the
pool's state only *changes* when something connects, so the poll would report
the past for ever unless some other read were doing the real work. Two
questions, one answer, and a standing chance of the two disagreeing on one
screen. Which they did, and see below.

**Two disconnections, two sentences, and neither can see the other's evidence.**
A host that is asleep and a browser tab whose socket has dropped both end in a
stale screen, and they are different in all three of the ways that matter, so
they are two components rather than one with a branch in it.

*Different evidence.* A machine that has gone away is learned from requests that
fail. A dropped socket fails nothing: `web/carrier.ts` queues whatever is asked
while it is down, so nothing settles, no error is thrown, and an outcome-based
signal is blind to it by construction. Only the socket knows —
`createWebCarrier` has exposed `connected()` and `onConnectionChange()` since
M3 with nothing subscribing, and `ShellConnection` is what finally does. In the
Electron window it is a constant `true`, because the other end of that carrier
is the main process of the same application and cannot go away without taking
the window with it.

*Different reach.* A sleeping host makes that machine's screens stale; a dropped
socket makes every screen stale, this computer's included, and while it is down
nothing can be claimed about any host. So `ConnectionBanner` sits above
`HostBanner` in `App.tsx` and its sentence wins.

*Different remedy.* A host gets "Try again", because somebody pressing it knows
something the backoff timer does not — it is `hosts.probe`, the one call that
ignores backoff, and the reason that method exists. The tab gets no button, and
that is honest rather than missing: the carrier is already reconnecting on its
own ladder, and a reload would need the very server that is not answering.

**Stale is content you keep, and that turned out to be six screens rather than
one.** The rule is one sentence — a disconnection is the only error that says
nothing *about* the data, because it means the question could not be asked,
while every other error is an answer that contradicts what is on screen — and
`isDisconnection` in `lib/errors.ts` is the whole of it. Applying it was the
work: the review header, the files tab, the commits tab, the repository list,
the review list and the repository detail each had their own replace-on-error,
and the conversation tab said it a second time in red under a banner that had
just said it. A card is now for having *nothing* to show; `repository-list.tsx`
keeps M4.3's "This host is not answering" for exactly that case, which is what
arriving cold at a machine that is already asleep looks like.

Nothing is dimmed, nothing is disabled and there is no per-row marker. A diff
that was readable a second ago is still readable, a reviewer mid-file keeps
their place, and one strip saying so out loud is the whole of the marking.
Writes are not blocked either: a comment typed against a machine that has gone
fails on submit with `ssh`'s own sentence, in the composer, with the text still
in the box — which is better than a disabled button that loses what somebody was
in the middle of writing.

**One read is the machine's heartbeat, and the rest come back with it.** A
review screen holds half a dozen keys, and most of them are `LIVE_READ_OPTIONS`
reads that deliberately never retry, because a diff is expensive and re-running
it behind somebody's back is not a favour. So recovery is not each key finding
its own way back: the one read that *is* retrying announces the machine, and
`use-reconnect.ts` revalidates everything scoped to it at once, so the screen
redraws whole rather than in pieces over the following minutes. Revalidating by
key suffix is what makes that a single line, and it is not a trick — `scoped()`
in `lib/api.ts` puts the instance id on the end of every key that names
something a host owns, for the sake of the family-wide `startsWith`
invalidation at the front; asking from the other end gives "everything about
that machine".

**Verified end to end against `pc-wsl` through the shipping code**, with the
cable pulled four different ways. No reinstall was needed and that is worth
noting: M4.5 adds no method and changes no frame, so the daemon M4.4 left on
that box answered it unchanged — the first slice of M4 for which version skew
had nothing to say.

The host added and reachable in 224 ms, its instance id learned, and review 2
opened at `#/h/<instance>/reviews/2/files` with its diff. Then, with the
launcher moved aside *and* the running daemon killed — moving it is not enough,
the pool is holding a pipe into a process that is already up — the strip became
*pc-wsl stopped answering*, with *GitWarren is not installed on xfor@pc-wsl:
~/.gitwarren/bin/gitwarren was not found*, *Showing what was loaded at 07:41*,
and a Try again; the 287 lines of review and diff underneath were the same 287
lines. Putting the launcher back, the screen came back **on its own after 32
seconds** — no click, no focus, no navigation.

Mid-request, which is what M4's verify line actually asks for: killing the
`ssh` the pool was holding while a request was travelling on it failed that
request in 13 ms with *The connection to xfor@pc-wsl was terminated (SIGKILL)*,
nothing retried, and the diff stayed. Driven through a real *Refresh* press so
the request in flight was one the app made, the banner rose and the files tab
kept its diff; the review poll noticed the machine again **5 seconds** later and
pulled the diff back with it. Try again, pressed while the machine was still
away, failed honestly and left the screen alone; pressed a moment after the
launcher was restored it had the review back in **0.5 seconds**, which is the
backoff being ignored on purpose.

Arriving cold at a sleeping host is the other shape: `#/h/<instance>/` after a
reload said *pc-wsl · Unreachable* in the strip and carried M4.3's card in the
content, once rather than twice. A comment typed while the machine was away kept
its draft and showed `ssh`'s sentence under the composer — and it was the failed
*write* that raised the banner, which is the whole design in one gesture.

In a Chrome tab on the loopback view: stopping the app under it produced
*GitWarren is not answering*, the home screen still on screen behind it, and
`shell.connection.connected()` false; fifteen seconds later the second sentence
about a restarted GitWarren appeared. No console errors or warnings in any of
it, and no horizontal scroll at 390 px.

**Five things bit.**

*The poll stops at the exact moment there is something to notice.* SWR's
`refreshInterval` looks like it is already the heartbeat and it is not: the poll
is skipped for as long as the cached error is set — `if (!getCache().error && …)`
in `use-swr` — and this app has set `shouldRetryOnError: false` globally since
M1. So the fifteen-second revalidation that would have seen the machine come
back stopped the first time it failed, and an open review stayed offline until
somebody focused the window. The banner was perfect and permanent. The fix is an
`onErrorRetry` that says no to everything except a disconnection and retries
that at a steady fifteen seconds, only while the document is visible; what it
costs is bounded a layer down, because a host in backoff refuses in
microseconds and at most one `ssh` a minute per machine actually happens. Worth
noticing that the flag's original reasoning was right and is now written out in
prose rather than expressed by being off: an error is normally an *answer*, and
a `NOT_FOUND` will not become found by being asked again.

*A healthy start was being offered as a cause of death.* The first failure
message to reach a screen read *The connection to xfor@pc-wsl was terminated
(SIGKILL). [gitwarren-serve] ready (instance …, protocol v1, database: …)* —
because `describeExit` appends the tail of stderr, and stderr is where M4.1 put
the daemon's start-up banner precisely so it could not hurt the framing on
stdout. Two kinds of line on one stream, and only one of them is ever an
explanation: proof that the daemon started is the one thing that cannot be why
it stopped. The banner's prefix now lives in `shared/rpc.ts` because the two
ends of the pipe both need it — one to write it, one to leave it out — and every
other line is still kept, because any of them might be the reason. M4.1 and M4.2
never saw this: their failures were all *before* a start, where stderr holds
only what `ssh` said.

*Keeping the content meant finding every screen that throws it away.* The review
header was the obvious one. The files tab was not, and it is the one that
mattered — killing the `ssh` under a *Refresh* left the banner correct and the
diff gone, which is the exact failure the slice exists to prevent, found by
pressing the button rather than by reading the code. Six screens in the end, and
the reason it was six is that "could not load" and "is momentarily out of touch"
had never needed telling apart before there was a network in the middle.

*The badge over the diff disagreed with the diff, in both directions.* Opening a
review on a host in a freshly started window showed *Not tried yet* over a diff
that machine had just served, because `hosts.list` was answered before anything
had connected and nothing re-asked. So `reachabilityOf` now takes what the
asking side has observed, and that wins over the row. The first attempt at it
still said *Not tried yet*, which is the more interesting half: the store
announced a change of state and treated "answered" as no change, so the badge
was never told. Never heard from is a state, and leaving it is news — one extra
announcement per machine per window, and the sentence is right.

*It passed the no-horizontal-scroll check and was unreadable anyway.* At 390 px
the buttons beside the message are `shrink-0` and the text column had `min-w-0`,
so `ssh`'s sentence came out one word per line down the left of the screen
inside a box that measured exactly 390 px wide. A floor on the text column makes
the row wrap and gives the buttons a line of their own. Worth writing down
because the check that M3.5 established — `scrollWidth === clientWidth` — is
necessary and says nothing at all about whether anybody can read the result.

**What M4.5 found next door.** A browser tab cannot get itself back after the
app it was served by is restarted, and this is by design rather than a bug:
`core/web/token.ts` mints its token per *launch* and gives three reasons for it,
the first of which is that revoking it should be `quit`. The consequence had
simply never been looked at from the tab's side — the socket retries for ever
against a server that answers 401, which is a spinner pretending to be progress.
Nothing here changes the token, because persisting it would trade away the
property that module was built for. What changed is that the banner stops
pretending: after fifteen seconds it says that a restarted GitWarren means an
expired link and a new one has to be opened from the app. Conditional on
purpose — a page cannot tell a restart from a blip, both being a socket that
will not open, and the confident version of that sentence would send somebody to
re-open an app that is fine.

**Not done in M4.5, and why.** There are still no events: the fifteen-second
poll is the whole of how this app learns anything, and a machine that goes away
while nothing is open on it is noticed the next time somebody looks. That is
M6, and `onStateChange` is the hook it will use. Nothing marks individual rows
as stale, deliberately — one strip is the whole of the marking, and a screen
covered in little clocks would be worse at saying the one thing that is true.
`ConnectionBanner` is only ever seen in a tab, since the window's carrier cannot
lose its other end; the Electron half is a constant and two lines. And a review
open on a machine that comes back does not learn what *changed* while it was
away beyond what a refetch shows — comments an agent wrote in the meantime
appear, because the whole review is one read, but nothing points at them.

**M4 is complete.** From the Mac, a WSL node is added by SSH target, has
GitWarren installed onto it over the pipe, and is then a machine whose
repositories, reviews, diffs, comments, attachments and editor links all work
from here; the agent inside WSL reads the same reviews over its own local MCP;
and when the machine goes away the screen says so, keeps what it had, and comes
back by itself. The gap table below still reads true as written — disconnection
was always split between M4 and M6, and what M6 owns is the heartbeat, not the
banner.

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

#### How it is being built, and where it has got to

Four changes, each mergeable on its own, in the order that keeps every one of
them verifiable against the real Ubuntu distro on this PC rather than against a
mock. Before them, one repair that is not M5 and is listed because it had to
happen first:

0. **The test suite on Windows.** `npm test` cannot run here at all, for a
   reason that has nothing to do with hosts. *(done — see below.)*
1. **The WSL carrier.** `wsl.exe` as a way of starting a daemon and talking to
   it, the `kind` column widened, and the pool taught which carrier to open.
   *(done — see below.)*
2. **The distro list and the installer.** `hosts.distros`, the add form
   becoming a picker rather than a text field, and the same linux tarball
   streamed down the same pipe. *(done — see below.)*
3. **Editors, reveal and agent access.** `wsl+<distro>`, Explorer reveal
   through `\\wsl.localhost`, and the Agent Access page for a distro.
   *(done — see below.)*
4. **The guard.** A `\\wsl.localhost` path refused as a *local* repository,
   with a pointer to the thing the person meant. *(done — see below.)*

**What was settled before any of it was written.**

*A WSL host's target is the distro name, and nothing else.* An `ssh` target
carries the Unix user because spike S1 found that a bare MagicDNS name asks for
the *client's* username; that negotiation does not exist here. `wsl.exe -d
Ubuntu` runs as the distro's own default user — `whoami` answers `xfor`,
decided by `/etc/wsl.conf` over there and not by anything this app could say.
`wsl.exe` does have a `-u`, and it is deliberately not offered: the daemon
installs into `$HOME/.gitwarren` and keeps its database there, so a second user
is a second home, a second database and a second set of reviews. That is not
another way of reaching one host, it is another host, and a form field most
people would get wrong is exactly what the schema comment warns against.

*One machine is one row, even when two carriers reach it.* This distro is
already reachable both ways: it is `xfor@pc-wsl` over ssh from the Mac and will
be `Ubuntu` over `wsl.exe` from here. Those are two installs and do not interact.
Within *this* install, adding the same distro over both carriers is refused, and
M4.1's collision report is what refuses it — but the reason is stronger than
tidiness. `#/h/<instance>/…` routes by instance id, and `requireInstance` reads
one row for it; two rows bearing one instance id would make every remote route
ambiguous, with a repository list that depended on which row won. So the answer
is not "allow one machine two carriers", it is "pick the carrier you want" — and
the report already says which other row it collided with.

*The bytes go over the pipe, and the `\\wsl.localhost` route is rejected.*
Spike S2 measured 56 MB/s through this exact pipe on this exact machine, so the
46 MB tarball is under a second of it; M4.2's `ssh` pipe did the same file in
3.4 seconds and nobody minded. The file-path route loses on moving parts rather
than on speed: it would still need a shell inside the distro to unpack the
archive and to run `service install`, so it replaces `tar xzf -` reading stdin
with a file copy *plus* that same shell invocation. It also puts the bytes
through SMB, and this milestone found out what SMB does to a Linux working tree
(see the guard). `core/hosts/install.ts` is expressed entirely in terms of "run
this command on that host, with this on its stdin", so the installer's whole
delta is which function that is.

*The distro list is a method, not a shell capability.* The tempting comparison
is `system.editors`, which is a shell channel because launching an editor is
something only a shell can do. Listing distros is not an act, it is a fact about
the machine that will spawn `wsl.exe` — which is the machine the *core* runs on,
not the one the window is drawn on. M4.2's Hosts screen works in a browser tab,
where it manages the list belonging to the install that served the tab, so the
tab has to be able to ask this question too; a shell capability would have left
it unable to. It is `hosts.distros`, which also makes it unforwardable for free:
`isLocalOnly` refuses the whole `hosts.` prefix, and what distros exist on a
machine is that machine's own business in exactly the way its host list is. The
screen offers a WSL host when the answer is non-empty, so a Mac never offers one
without any code asking what platform it is on.

The list is unfiltered, including the two `docker-desktop` distros this PC has.
A blocklist of names is a list that goes stale — `rancher-desktop` and
`podman-machine` are the same shape — and it is M4.3's argument about hidden
folders one screen along: a listing that silently dropped rows is one you cannot
trust when what you wanted is not in it. Picking one that cannot host a daemon
fails during an install someone is watching, in the distro's own words, which is
the failure M4.2 built for.

*Ten idle minutes stays, and the comment that explains it stops being a lie.*
`IDLE_TIMEOUT_MS` matches `ControlPersist=10m` "kept in step deliberately", and
`wsl.exe` has no ControlPersist to keep step with. Measured here: a connection
to a running distro costs 80 ms, and one that has to start it 1.7 seconds — so
being wrong about the timeout is a tenth of a second, not a key exchange. The
number is kept for both carriers because the interesting reason turns out to run
the other way. A held-open pipe keeps a `serve --stdio` process alive inside the
distro, and a distro with a process in it is a distro WSL will not idle down. On
ssh, hanging up lets a multiplexing master expire; on WSL, hanging up is what
lets the whole virtual machine go to sleep. It matters more here, not less.

**M5.0, done on the PC, 11 September.** `npm test` on Windows ended with
thirteen failures in one file, every one of them reporting `EPERM: operation
not permitted, symlink` as the reason a *folder listing* was wrong. Windows does
not let an unprivileged process create a symlink without Developer Mode, and
`fs.test.ts` made two of them in `before`, so the hook took all thirteen tests
down and none of the other twelve had anything to do with symlinks. The one test
that is about them now skips itself and says why; the rest run. 520 pass, 5
skipped, 0 fail — the fifth skip is the new one, the other four being M4.1's
envelope assertions.

This is the third of its kind after `scripts/run-tests.mjs` and the Windows
drive-letter fix, and they all have one cause: `ci.yml` runs ubuntu only, so
every Windows-shaped failure in this repository has been found by a person
sitting at a Windows machine rather than by the suite. A Windows job is the
honest fix and is deliberately not in this milestone.

Two more of the same family, found getting the checkout to build at all and
recorded because the next person will hit them in the same order. `better-sqlite3`
ships a `win32-x64` prebuild *and* a `binding.gyp`, and npm runs `node-gyp
rebuild` for any package with a `binding.gyp` and no `install` script — so a
plain `npm install` on Windows tries to compile SQLite, needs Python, and fails
the whole install even though the binary it was about to build is already in the
package. `npm install --ignore-scripts` is the way past it. And the `python` on
this machine's PATH is the Microsoft Store stub, which exits without printing a
version, so node-gyp reports "THIS VERSION OF PYTHON IS NOT SUPPORTED" for a
Python that is not installed at all.

**M5.1, done on the PC against the Ubuntu distro, 11 September.** M4.1 said a
carrier is "one file and an argument vector", and it very nearly is again -
`wsl.ts` contributes a child process, the pool grew a two-line switch, and
`kind` widened without a migration because `drizzle/0008_hosts.sql` never had a
CHECK on it. What is *not* shared with `ssh` is four things, and every one of
them was found by running the command and reading the bytes rather than by
reading Microsoft's documentation.

**`--` is not `ssh host '<script>'`, and the difference is silent.** The obvious
spelling is `wsl.exe -d Ubuntu -- ~/.gitwarren/bin/gitwarren serve --stdio`, and
it works, which is the problem: what `--` actually does is hand the words to the
distribution's *login shell*, which expands parameters and tildes in each of them
and then execs the result with no parsing at all - no word splitting, no quoting,
no operators. So `-- 'echo $HOME'` as one argument tries to exec a file named
`echo /home/xfor`, and `-- sh -c '<script>'` has the script's `$root` and `$`
expanded by the *outer* shell before the inner `sh` sees them. That second one
is the dangerous shape, because it still produces a number: `$` answered 1269
where the inner shell answered 1274, so a scratch directory named after the pid
quietly stops being unique per install. `-e` skips the login shell entirely, and
naming `sh -c` ourselves buys back tilde expansion and a script-as-one-argument
under our own control. It is more predictable than `ssh`'s arrangement rather
than less: over `ssh` the *login* shell runs the command and M4.2 found out the
hard way that on this box it is `zsh`, whereas here it is always `sh`.

**`wsl.exe` writes its own errors to stdout, which is the protocol.** This is
the one with no `ssh` analogue whatever. `ssh` puts its complaints on stderr and
leaves stdout to the remote command - M4.1 depended on that, and it is why the
daemon's ready banner is on stderr. `wsl.exe` puts "There is no distribution with
the supplied name." on **stdout**, in front of a stream that is supposed to carry
nothing but ndjson frames. Nothing can stop it. The frame reader does exactly
what it should and shuts the connection down saying the host "sent something that
is not part of the protocol … usually a login script printing to stdout on the
host" - right about the shape and wrong about the cause, and it would have sent
somebody to look at their `.zshrc` for a distribution they never installed.

What saves it is the mechanism M4.1 built for a different reason.
`diagnostics()` already waits for the exit before explaining itself, so it gets
the last word: a bounded prefix of stdout is kept, `wslSaid` drops the lines that
are frames, and `describeWslExit` puts what is left in the sentence. A
distribution that does not exist now fails in **42 ms** with *wsl.exe could not
start no-such-distro-here. There is no distribution with the supplied name. Error
code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND*. A frame is a JSON object, so "does
this line start with `{`" is the whole of the test - cheaper than parsing, and
the question being asked is not "is this valid JSON" but "did something other
than the protocol write here".

**Two encodings on one pipe.** `wsl.exe` speaks UTF-16LE and the guest speaks
UTF-8, so `setEncoding('utf8')` turns half the stream into mojibake - `wsl.exe -l
-q` reads `U\0b\0u\0n\0t\0u\0`, and an error message is worse because it is the
thing somebody has to read. `WSL_UTF8=1` fixes it, and is set on the child rather
than on this process because it changes the output of a program we parse and
nothing else should have to know. Worth noticing that this is `rpc-wire.ts`'s
lesson in a third place: two framings hang, two encodings lie, and two encodings
*on the same stream* lie in only half the sentences.

**There is no `BatchMode`, because there is nothing to prompt for.**
`BatchMode=yes` is what turns an `ssh` hang into an error, and the hang it
prevents does not exist here - `wsl.exe` never authenticates, the distribution
belonging to the Windows user already. What exists instead is a set of failures
that each arrive as a status with some words attached, so the work was
enumerating them rather than defending against a wait. A distribution that is not
installed and WSL that is not enabled are both `wsl.exe`'s own `-1` (which
Windows reports as 4294967295, and both spellings are accepted because which one
arrives is a platform detail rather than a promise), told apart by the sentence
rather than by the code. A distribution without GitWarren is exit 127 from `sh`,
the same status `ssh` produces, which is why it is the same sentence. The wrong
architecture is not visible here at all - it gets as far as a perfectly
successful `tar` and dies at the first `exec`, during an install someone is
watching, exactly as M4.2 arranged.

**The one message this app has to invent.** `wsl --terminate Ubuntu` under a live
connection ends the pipe and exits **1 with not one word on either stream** -
which is M5's equivalent of M4.5 killing the `ssh`, except that `ssh` at least
said something. Exit 1 is also what a daemon failing on its own account would
give, so the two are told apart by the evidence: a daemon that failed said so on
stderr, and silence is what a shutdown looks like. The sentence is therefore
worded as a possibility, because that is all the evidence supports - *The
connection to Ubuntu ended without saying why. The distribution may have been
shut down, by `wsl --terminate` or by WSL idling it out.*

**What moved, and why it moved before it was copied.** `ssh.ts` held the
connection interface, the launcher path, the two bounds and M4.5's
"a healthy start is not a cause of death" stderr filter, and all five are things
a *carrier* has rather than things `ssh` has. They are in `carrier.ts` now, and
both files are users of it - the same move `ndjson.ts` made at M4 and for the
same reason, one layer up. The failure it prevents is quieter than a hang this
time but not by much: the pool holds carriers through that interface and would go
on compiling while one of them stopped waiting for an exit before explaining
itself, which is precisely the bug M4.1 spent its time on. `isLocalOnly` moved
with them, which is what makes M5.2's `hosts.distros` unforwardable by being
named rather than by anybody remembering to check.

**Verified end to end against the real distribution through the shipping code,**
which already had the daemon M4 left on it. A cold connection answered
`repositories.list` in 2.5 seconds and the next request in **1 ms**; the
distribution named itself `4e0b0adb…` running 0.1.7-beta.1, with the two
repositories M4 added still there. Two requests in flight at once both came back,
which is the property `id` exists for. A `NOT_FOUND` crossed the pipe as itself.
`hosts.list` was refused by the carrier. Through the pool with a `wsl` route: 141
ms warm, and an unreachable distribution arriving as a *state* carrying
`wsl.exe`'s words rather than as a throw. Then `wsl --terminate` under an open
connection: the next request failed in **3 ms** with the invented sentence, and
the connection after that started the distribution again in 1.8 seconds and got
the same instance id back.

Two numbers worth keeping for the idle-timeout argument: reconnecting to a
running distribution costs **80 ms**, and starting a stopped one **1.7 seconds**
- against `ssh`'s 178 ms cold and 4 ms warm on a multiplexed channel. So
`IDLE_TIMEOUT_MS` keeps its ten minutes and its comment stops claiming
`ControlPersist` is the only reason: an open pipe keeps a `serve --stdio` process
alive *inside* the distribution, and a distribution with a process in it is one
WSL will not idle down. Letting go retires a multiplexing master on `ssh`; on WSL
it is what lets the whole virtual machine sleep.

**Not done in M5.1, and why.** Nothing installs into a distribution yet and no
screen can add one - both are M5.2, and they are one slice for M4.2's reason:
the picker's main job is to drive the install. `hosts.add` accepts
`kind: 'wsl'` and the carrier works, so a host is added through the dispatcher
and not by anybody using the app. A WSL host's target cannot be *edited* to a
different distribution, and that is a rule rather than a gap: an ssh target is an
address and addresses change, while a distribution name is which machine this is,
so repointing it would be naming a different home directory and a different
database. The service refuses it and says to add the other distribution as its
own host.

**M5.2, done on the PC against the Ubuntu distro, 11 September.** A distribution
stops being something the dispatcher can reach and becomes something a person
can add and install onto. The installer's delta is a switch:

    hosts.distros               what could become a host here
    runOnHost(route, …)         the same four commands, either carrier
    a picker, not a text field  because this machine knows the answer

**Nothing was added to the installer, and that is the claim worth checking.**
`core/hosts/install.ts` was written against "a machine with a shell and a `tar`"
rather than against `ssh`, and a distribution is one - so `uname -sm`, the
scratch directory, the one `mv`, the host writing its own launchers and the
version read back afterwards are all M4.2's, unchanged. What changed is that
`run` takes a route instead of an ssh target. A test asserts the same four
commands in the same order against a `wsl` route, including that the tarball is
still chosen from `uname` and not from the carrier - which is `hosts.kind`'s rule
in an assertion: what a host runs is discovered by asking it.

**The bytes went over the pipe in 1.1 seconds.** 44.2 MB, against M4.2's 3.4
seconds for the same archive over `ssh`, which settles the delivery question
empirically rather than by argument. The `\\wsl.localhost` route was rejected on
moving parts rather than on speed: it still needs a shell inside the
distribution to unpack and to run `service install`, so it is a file copy *plus*
the same shell invocation, and it is only available while the distribution is
already running - a precondition the pipe does not have, because starting it is
what the pipe does.

**`hosts.distros` is a method, and the browser tab is why.** The tempting
comparison is `system.editors`, which is a shell channel because launching an
editor is something only a shell can do and a tab must never ask a server to
spawn one. Listing distributions is not an act; it is a fact, and a fact about
the machine that will spawn `wsl.exe` - which is the machine the *core* runs on,
not the one the window is drawn on. M4.2's Hosts screen works in a tab, where
what it manages is the host list of the install that served it, so the tab has
to be able to ask this too. Under the `hosts.` prefix it is unforwardable
without anybody remembering to make it so, which is the property `isLocalOnly`
moving into `carrier.ts` in M5.1 bought. And because an empty answer is what a
Mac gives, the screen offers a WSL host exactly when the list is non-empty and
**no code anywhere asks what platform it is on**.

The list is unfiltered, `docker-desktop` and `docker-desktop-data` included. A
blocklist of names goes stale - `rancher-desktop` and `podman-machine` are the
same shape - and it is M4.3's argument about hidden folders one screen along: a
listing that silently drops rows is one you cannot trust when what you wanted is
not in it. Picking one that cannot host a daemon fails during an install someone
is watching, in that distribution's own words.

**Three things bit, and two of them are Windows properties rather than
GitWarren ones.**

*A daemon tarball built on Windows is not installable, and the install said the
wrong thing about it.* `tar tzvf` on the archive this machine produced shows
every entry as `-rw-rw-rw-`: NTFS has no POSIX mode, `chmodSync` is a no-op
there, and bsdtar faithfully records what it was given - so `bin/gitwarren`,
`bin/gitwarren-mcp` and the 126 MB embedded `bin/node` all arrive without an
executable bit. M4.2's guard caught it, which is the system working, but it
reported *the tarball did not contain bin/gitwarren* about a file that is
plainly there. The fix is in the unpack script rather than in the builder:
`chmod +x` on `bin/*` before the check. Nothing ever read those bits except that
one check, and the step after it runs the binary, so setting the bit we require
is strictly more reliable than asserting somebody else set it - and it makes an
archive rebuilt on any machine work. The guard now distinguishes "not there"
from "not executable", because those send a person to different places.

*`scripts/build-daemon-tarball.mjs` built the tarball and then died reporting its
size.* The last line ran `du -h`, which does not exist on Windows, so a 44 MB
archive was produced successfully and the script exited non-zero on
`spawnSync du ENOENT` - the most annoying available place to fail. `statSync`
instead. Third of its family after `run-tests.mjs` and the drive-letter fix, and
the same cause every time: `ci.yml` runs ubuntu only.

*The `wsl.exe -l -v` table needs reading rather than splitting.* Three things
about it: without `WSL_UTF8=1` it is UTF-16LE and a name reads
`U\0b\0u\0n\0t\0u\0` - which would be *stored* as a host target by anything that
did not notice; lines end `\r\n`; and the default distribution is marked with a
leading `*` in the column every other row leaves blank. The header row is dropped
by position rather than by matching "NAME", because that word is localised and a
filter reading English would silently drop a distribution actually called `NAME`
while keeping a header nobody could parse.

**One machine is one row, and the collision fired for real.** Adding `ubuntu`
alongside `Ubuntu` is two perfectly distinct *descriptions* - `wsl.exe` matches a
name case-insensitively, the unique index does not - and the second one probed
gave *ubuntu is the same machine as "Ubuntu" (Ubuntu), which is already in the
list. Remove one of them.* M4.1 built that report for the hypothetical case of
one box under two ssh names; this is it happening. The answer is deliberately not
"allow one machine two carriers": `#/h/<instance>/…` routes by instance id and
`requireInstance` reads one row for it, so two rows bearing one id would make
every remote route ambiguous, with a repository list depending on which row won.
The picker greys out a distribution already added, so the ordinary way to reach
this is closed before the instance id has to.

**The form has two halves and they are deliberately not symmetrical.** An `ssh`
target stays free text, because every `~/.ssh/config` alias somebody already has
must work and no validator can know what those are. A distribution is a *list*,
because this machine knows exactly which ones exist and offering its own spelling
removes the case question entirely. Both keep their own error messages - "a user
name, an @ and a machine name" and "that is not a WSL distribution name" are not
interchangeable advice - which is why `addHostInputSchema` grew a `superRefine`
rather than one permissive rule: `kind` is optional, every host added before M5
saying `ssh` by saying nothing, and a discriminated union cannot discriminate on
a key that may be absent. The carrier choice appears only when there is something
to choose, so on a Mac the dialog is what it was before M5.

**Verified end to end through the real window over CDP**, every call made with
`window.gitwarren.carrier.request` so the preload, the router, the pool and the
carrier were all in the path. The window listed three distributions; `Ubuntu` was
added with its label defaulting to the distribution name and `instanceId` null
until it had been met; the picker then showed it as already added. `hosts.install`
from the window: **44.2 MB in 3.6 seconds**, the instance id learned
(`4e0b0adb…`), the row reachable. Then it was a machine to review: its two
repositories listed with their WSL paths, `fs.list` answering `/home/xfor` with
45 entries and `/` as its separator, `app.mcp` answering
`/home/xfor/.gitwarren/bin/gitwarren-mcp`. The duplicate-spelling collision as
above. An ssh target of "not a host" and a distro name of "no/slashes" each
refused with their own sentence under the `target` field. No console errors.

**Not done in M5.2, and why.** Editors, the Explorer reveal and the per-host
Agent Access page are M5.3. A WSL host's target still cannot be edited, and the
dialog now simply does not draw the field for one rather than drawing a field
that could only produce the service's refusal. There is no uninstall, for M4.2's
reason exactly: `hosts.remove` forgets a row here, and `rm -rf ~/.gitwarren` is
something a person can type into their own distribution and read before pressing
return.

**M5.3, done on the PC against the Ubuntu distro, 11 September.** The three
controls that point at a file over there. Two of them were already right and had
to be told about one more arrangement; the third is the one M4.3 switched off and
this milestone is allowed to switch back on.

    editorTargetFor             wsl+Ubuntu, not ssh-remote+Ubuntu
    useRevealPath               can this machine name that file at all
    app.mcp                     unchanged, and that is the result

**The editor form is the thing M4.4 wrote down a milestone early.** Its note
said `editor_target` was kept apart from `target` because "the two coincide today
and stop coinciding at M5, where the carrier is `wsl.exe -d Ubuntu` and the
editor form is `wsl+Ubuntu`", and this is that sentence becoming a branch. The
authorities come from different VS Code extensions - `ssh-remote+` from
ms-vscode-remote.remote-ssh and `wsl+` from ms-vscode-remote.remote-wsl - which
is the real reason they cannot be one derivation, and also the reason a link's
failure is silent: the wrong extension is not installed and nothing says so.
That caught M4.4 out on the Mac, so it was checked first here rather than
concluded from a URL that looked right.

**Reveal stopped being a rule about remoteness and became a question.** M4.3 hid
"Show in file manager" for every remote host, and the reasoning was exact:
`/home/xfor/app` handed to a Mac's Finder opens a window on nothing or on an
unrelated local folder. M5 does not re-open that hole, it observes that
`host === undefined` was only ever a *proxy* for the condition actually being
tested - *can this machine name that file in its own filesystem* - and that the
proxy was correct only while every remote host was across a network. Windows
serving a distribution at `\\wsl.localhost\<distro>\…` is the one arrangement
where the answer is yes for a machine that is not this one.

So `useRevealPath` returns a path or null, and null is still absence rather than
a disabled button. It returns the *path* rather than a boolean on purpose: the
caller needs a name to hand the shell, and a second place where the translation
could be made differently is a second place to get it wrong. Both its conditions
have to hold and neither implies the other - the host must be reached by
`wsl.exe`, and the **core** must be on Windows, which is `appInfo.platform` and
not anything about the browser. In a tab it never gets asked, because
`capabilities.revealPath` is false and the button is gone first.

It returns null while the host list is still loading, deliberately: an unanswered
question is not the alarming answer - the same distinction M4.3's banner got
wrong in the other direction - and the cost of waiting a frame is a button
appearing late, against a file manager opened on a path that means something
else.

**`shared/wsl.ts` translates both ways, and the second direction is M5.4's.**
Towards Windows for the reveal; towards the distribution so that a
`\\wsl.localhost\…` path typed into the *local* add-repository form can be
refused with a pointer at what the person meant. Two prefixes are recognised
because `\\wsl$\` is the older spelling and still resolves, and both separators
because `git rev-parse --show-toplevel` answers `//wsl.localhost/Ubuntu/…` with
forward slashes - which is the form the guard is most likely to be shown and the
one a backslash-only test would miss.

**Agent access needed nothing, and that is the interesting part.** `app.mcp`
answers "the launcher, as the host resolves it", which was M4.4's whole point,
and a distribution resolves it to `/home/xfor/.gitwarren/bin/gitwarren-mcp` for
the same reason `pc-wsl` did over `ssh`. The Agent Access page was already
fetching through `useApi()` after M4.4's fix, so the per-host page works on a WSL
host without a line. The local answer on this machine is
`C:\Users\micha\.gitwarren\bin\gitwarren-mcp.cmd`, which is a pleasing check that
the two really are different machines rather than one path being shown twice.

**Verified end to end through the real window over CDP.** The host derives
`wsl+Ubuntu` with `editor_target` still NULL, so it is derived and not stored.
`reviews.filePath` on the host answered
`/home/xfor/github.com/klarluft/gitwarren-app/docs/across-hosts.md`, which became
`vscode://vscode-remote/wsl+Ubuntu/home/xfor/…/docs/across-hosts.md:1` - and
pressing it through `shell.openInEditor` started
`ms-vscode-remote.remote-wsl-0.104.3\dist\node\wslDaemon.js`, which is the
extension resolving the authority rather than a URL that merely looks right. The
editor picker offered VS Code, Cursor and the JetBrains IDEs, which is
`remotelyOpenable` reducing a real list for the first time - the Mac in M4.4 had
one editor and could not exercise it.

Pressing "Show in file manager" on a repository of the WSL host opened an
Explorer window on
`file://wsl.localhost/Ubuntu/home/xfor/github.com/klarluft/gitwarren-app`, read
back out of the shell rather than assumed. `app.mcp` answered the distribution's
launcher for the host and this machine's `.cmd` for no host.

And the other half of M5's verify line, because the PC is the one machine that
can check it: `C:\Users\micha\gitwarren-app` added as an ordinary local
repository reads its git state on NTFS (branch `main`, root commit
`59843fd3f8ab`), and the distribution's checkout of the same project reports the
*same root commit* at `/home/xfor/github.com/klarluft/gitwarren-app`. M4.3 built
that grouping across a network; here it groups two filesystems on one desk.

On the screens: the Hosts screen lists the distribution; Add offers "Connect by
SSH / WSL" with SSH the default, and choosing WSL replaces the text field with
the picker, which shows `Ubuntu — already added` beside the two `docker-desktop`
rows. No horizontal scroll at 390 px on the home screen, the Hosts screen, the
host's repository list, or with the Add dialog open. No console errors or
warnings anywhere in the run.

**Not done in M5.3, and why.** Deep links still carry no host, unchanged from
M4.3 and M4.4: a `gitwarren://` link written inside the distribution opens this
machine's review of that number, and that is rule 4 needing the loopback
fragment to grow a host segment, which belongs with M6's live links. The
attachment path was not re-verified on this carrier - it is
`shared/rpc-wire.ts` and the router, neither of which can tell `wsl.exe` from
`ssh`, and M4.4 proved the bytes - so what M5 checked is that nothing about it
is carrier-specific rather than that an image round-trips again.

**M5.4, done on the PC, 11 September.** The guard, and it is the part of this
milestone only this machine could have found - because the way to discover what
the app did with a `\\wsl.localhost` path was to type one in.

**What it did was lie, and then work badly.** Typing
`\\wsl.localhost\Ubuntu\home\xfor\github.com\klarluft\gitwarren-app` into the
add-repository form answered *"This folder is not inside a git repository"*. It
is one. What happens is that Windows git refuses a working tree owned by another
user - `fatal: detected dubious ownership in repository at
'//wsl.localhost/Ubuntu/home/xfor/…'` - and `resolveRepositoryRoot` reads any
non-zero `rev-parse` as "not a repository". True of the exit code, false about
the folder, and it sends a person to check whether they picked the right one.

The worse half is what happens to somebody who reads git's message and follows
its advice, which is right there in the error and entirely reasonable: add a
`safe.directory` exception. Then it *succeeds*, and the repository they get is
wrong in three ways at once, each measured here rather than assumed.

- **Its git runs over SMB.** `git status` on this project: 479 ms through
  `\\wsl.localhost`, 74 ms inside the distribution.
- **It reports a different diff.** Windows git saw two `.sh` scripts as modified
  with zero content change, where the distribution saw a clean tree. The cause
  is the executable bit, which is not visible across that share - so the *same
  repository* has two answers to "what has changed" depending on which side is
  asked, and the one GitWarren would show is the wrong one.
- **Its reviews land in the wrong database.** They would be in the Windows
  install's SQLite, where the agent running inside WSL cannot see them over its
  own local MCP. That is rule 1 - a host owns its repositories - and it is the
  entire reason the distribution is a *host* rather than a folder.

So the guard is not tidiness about a path format. It is the difference between
this milestone working and appearing to.

**It fires before the filesystem is touched, and that ordering is the point.**
The path is real, the directory exists, and git will answer *something* about
it - so every check downstream produces a plausible response to the wrong
question. `refuseWslPath` is the first line of `resolveRepositoryRoot`, ahead of
even `isDirectory`.

The message carries both halves of the remedy, because "no" is not advice: which
host to add, and which path to add on it once they have - *That folder is inside
the WSL distribution "Ubuntu", not on this machine. Add Ubuntu as a WSL host,
then add /home/xfor/github.com/klarluft/gitwarren-app as a repository on it — so
its reviews live where the code does and the agent in WSL can read them.* The
second sentence is the translation `shared/wsl.ts` already does for the Explorer
reveal, running the other way, which is why that module has two functions.

**It fires on every platform, not only on Windows.** The string means the same
thing wherever it is read, the advice is the same, and a guard that exists on
one operating system is one that no test on another can check - which for this
repository means one that CI would never run. Both UNC spellings are recognised
and both separators, because `\\wsl$\` still resolves and because
`git rev-parse --show-toplevel` answers `//wsl.localhost/Ubuntu/…` with forward
slashes, which is the form somebody is most likely to have copied from an error
message. An ordinary `\\fileserver\share` is *not* caught, and has a test saying
so: a file server is a perfectly reasonable place to keep a repository and has
none of the three problems above.

**Verified by typing one in, through the real dialog.** `repositories.add` with
that path refused with `INVALID_INPUT` and the sentence above, the advice under
the `path` input rather than in the dialog's banner - which is M4.4's bridge fix
still holding. Pressing Add in the form left the dialog open with *Add "Ubuntu"
as a WSL host and add this repository there.* under the field, and the local
repository list afterwards held only `C:\Users\micha\gitwarren-app`.

**M5 is complete.** From the Windows app, a distribution is added by picking it
from a list, has GitWarren installed into it over the pipe, and is then a machine
whose repositories, reviews, diffs, comments and editor links all work from here;
the agent inside WSL reads the same reviews over its own local MCP and writes
back into the same database; a `\\wsl.localhost` path typed into the local form
is refused with a pointer at the thing the person meant; and native Windows
repositories are unaffected, including one that turns out to be a clone of the
distribution's.

The verify line, end to end on this PC: the Windows app with `Ubuntu` as a WSL
host, its two repositories listed with their WSL paths, review 2 open at
`#/h/4e0b0adb…/reviews/2/files`, and an MCP session inside the distribution -
started with the exact command `app.mcp` prints - reading that review from
`/home/xfor/.gitwarren` and adding a comment that the Windows window then read
back over the carrier. `C:\Users\micha\gitwarren-app` added as an ordinary local
repository throughout, reading its git state on NTFS and sharing root commit
`59843fd3f8ab` with the distribution's checkout of the same project.

**Two things about this milestone are worth keeping separately from the slices.**

*Version skew had nothing to say, for only the second time.* M4.1 through M4.4
each needed the host reinstalled before their screens worked, because each added
a method that had to travel. M5 adds exactly one method, `hosts.distros`, and it
is one that never leaves the machine - so the daemon M4 left in the distribution
answered M5 unchanged. M4.5 was the first slice with this property and said so;
it is worth noticing that the reason is the same both times, which is that the
new thing was about the asking side rather than the answering one.

*`wsl --terminate` is not the equivalent of pulling a cable, and that took
finding out.* Killing the `ssh` under an open review is a durable outage: the
machine stays unreachable until something changes. Terminating a distribution
kills the pipe the pool is holding, and then the pool's next attempt spawns a
fresh `wsl.exe` - **which starts the distribution again**. So the in-flight
request fails (3 ms, with the invented sentence M5.1 had to write because
`wsl.exe` says nothing) and the one after it succeeds, transparently, in about
1.8 seconds. There is no banner, and there should not be: nothing is wrong any
more. A distribution being stopped is not a machine being off, and the carrier
that can start one is the reason.

So M4.5's banner was proved against the durable failure instead - the launcher
moved aside inside the distribution and the running daemon killed, which is
exactly what M4.5 did on `pc-wsl`. It rose with **no code written for this
carrier at all**: *Ubuntu stopped answering*, *GitWarren is not installed on
Ubuntu: ~/.gitwarren/bin/gitwarren was not found*, *Showing what was loaded at
9:09 AM. GitWarren keeps trying.*, and a Try again - with the review underneath
intact, and the banner clearing by itself once the launcher was put back. That is
the whole of what "learned from request outcomes, never from the pool" was for.

**What Windows turned out to own rather than GitWarren.** Four of these, and
none is a bug in this application:

- `wsl.exe` speaks UTF-16LE while the guest speaks UTF-8, and writes its own
  errors to **stdout**, which is the protocol's stream. `WSL_UTF8=1` fixes the
  first; nothing fixes the second, so `diagnostics()` reads around it.
- `wsl.exe -d X -- …` hands the words to the login shell for *expansion without
  parsing*, which makes `$` in a script the outer shell's pid. `-e sh -c` is
  the spelling that means what it looks like.
- NTFS has no POSIX mode, so a daemon tarball built on Windows has no executable
  bit on anything in it, and `chmodSync` is a no-op rather than an error.
- `python` on this machine's PATH is the Microsoft Store stub, which exits
  without printing a version - so node-gyp reports "THIS VERSION OF PYTHON IS
  NOT SUPPORTED" for a Python that is not installed, while trying to compile a
  `better-sqlite3` whose `win32-x64` prebuild is already in the package.

**And one thing this repository owns.** Three Windows-only breakages were found
in a day - the symlink in `fs.test.ts`, `du -h` in
`scripts/build-daemon-tarball.mjs`, and before this milestone the `npx.cmd`
spawn and the drive-letter path - and every one of them was found by a person at
a Windows machine rather than by the suite, because `ci.yml` runs ubuntu only.
A Windows job is the honest fix and is deliberately not part of M5: it is a
change to how this project is tested rather than to what it does, and folding it
in here would have made the milestone's diff about something else.

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

#### How it is being built, and where it has got to

Seven changes. M6 is the only milestone with five bullets in its own
description, and the reason it needs more slices than M4's five or M5's four is
that three of the five are only testable with a second machine awake and one of
them only with a phone — so the cut has to put each of those where the thing it
needs is already true.

Before them, one spike that had to happen first, because it decides whether the
`webUrl` in M6's fifth bullet is spelled `https` or `http`:

0. **`tailscale serve` in front of the loopback port.** S1 proved Tailscale SSH.
   What was unproven is the proxy, the identity header, and whether a WebSocket
   survives the hop. *(done — see below.)*
1. **The event channel, and what an event is allowed to carry.** `core/events.ts`,
   a write emitting on it, both shells carrying it to a renderer, and a renderer
   that treats what arrives as a reason to re-ask. One machine; no tailnet. *(done — see below.)*
2. **The poke from the MCP process.** An agent's write reaching the owner of the
   data directory over the loopback port it already publishes. *(done — see below.)*
3. **Tailnet exposure, identity, and `webUrl`.** `tailscale serve` behind a
   settings toggle, the gate learning a second way to be satisfied, and the URL
   that goes into an MCP result once a host listens. The phone works at the end
   of this one. *(done — see below.)*
4. **The listening carrier.** The third `HostConnection`: a WebSocket client in
   the app, reaching a machine that listens rather than one it spawns.
5. **Events across a host, and `host.state`.** `RpcEvent` on a wire in the one
   direction nothing has exercised, and the pool's `onStateChange` finally
   rendered — which is what greys a machine nobody is looking at.
6. **Discovery.** Peers from `tailscale status --json`, proposed rather than
   added.
7. **Links across installs, and the words.** What a `gitwarren://<other-id>/…`
   link does now that there is somewhere for it to go, and the README, the
   tagline and Known limitations catching up with the thing that shipped.

**What was settled before any of it was written.**

*An event is a refetch hint, and that is the same rule as "a lost request is
never retried".* The doc already said the first and `core/rpc/stdio-client.ts`
already said the second, and it is worth writing them as one idea rather than
two rules, because a person who holds the idea will get the next case right on
their own.

The idea is that **a message may never stand in for the asking side's own
knowledge.** A retry decides, on the caller's behalf, what a missing answer
meant — and it cannot know, so for `comments.reply` it guesses wrong by posting
a second comment. An event carrying data decides, on the screen's behalf, that
the push and the database agree — and it cannot know that either, because the
push crossed a network that reorders, drops and duplicates, while the database
is the thing that is actually true. Both replace evidence with inference, and
both are the sort of wrong that is invisible until it matters.

So an event carries a *name and a scope* and nothing else: "something about
review 4 on this machine changed". What it produces is the read the poll would
have done anyway, only sooner. Two consequences fall straight out and both are
load-bearing. A lost event costs latency and never correctness, which is what
makes the fifteen-second poll a genuine fallback rather than a story told about
one. And an event that arrives out of order, twice, or about something that has
since changed again is harmless, because the answer comes from re-asking rather
than from the message.

*An event for a host nobody is looking at is dropped, and dropping it is the
point rather than a gap.* This is the case the channel was supposed to exist
for, so it deserves the sentence. If an event is a refetch hint, then an event
about a review with no screen on it has nothing to invalidate: SWR has no
subscriber for that key, `mutate` finds nothing, and the cost is one map lookup.
When somebody does open that review the read happens then and is current. There
is no backlog to replay and no queue to bound, which is what a channel carrying
data would have needed.

`host.state` is the exception, and it is worth being precise that **the banner
is not what it is for**, because that is the thing M4.5 was careful about and
the thing it would be easy to undo here. M4.5's banner is raised by request
*outcomes* and stays that way: a request that failed is evidence about the
screen in front of someone, and it is carrier-agnostic — M5 proved that against
`wsl.exe` with no new code. `renderer/lib/host-reachability.ts` is not replaced
and does not read events.

What `host.state` adds is the machine with no screen on it at all, and the
mechanism is narrower than it first looks. The pool only learns anything by
*connecting*, so for most of M4 a host nobody was asking about was a host
nothing could have said anything about. What changes here is that a listening
carrier holds an open socket with a heartbeat on it (`WEBSOCKET_HEARTBEAT_MS`,
30 seconds, written at M3 with the sentence "over the tailnet in M6 it is
Tuesday"). A machine that is switched off kills that socket, the pool notices,
and the Hosts screen greys a row *without anybody having asked it anything*.
That is the whole of what M6 adds to disconnection, and it is why the verify
line says "turn the PC off" rather than "open a review and turn the PC off".

*One channel, two sources, and that is the cheap answer to M4.5's objection.*
`host.state` is about a machine and is known only to this install's pool;
`reviews.changed` is about data and is known only to the machine that owns it.
They look like two channels and they are not, because what they do at the far
end is identical: invalidate a key family. So `core/events.ts` is one bus with
two sources — the pool emits straight onto it, and an `RpcEvent` arriving from
a host is re-emitted onto it tagged with the host it came from — and one
subscription in the renderer drains it. M4.5 refused "two half-built event
channels for one banner"; what it was objecting to was the *cost*, and one bus
carrying names is most of that cost removed.

*Identity and the token are two different questions, and a request satisfies
exactly one of them.* This is the thing that must not be collapsed, so here is
the difference stated in the form the code checks.

`core/web/token.ts` answers **"did the user point something at GitWarren, or
does this merely know the port?"** — a question about *intent*, asked on
loopback, where the principal is uninteresting because every process the user
runs is already the user. The tailnet header answers **"is the person at the
other end the owner?"** — a question about *principal*, asked over a network,
where intent cannot be checked at all and the principal is the whole of it.

So a request is admitted when it is loopback-with-token **or**
tailnet-with-owner-login, and never by one standing in for the other. In
particular a token presented on a tailnet request is *ignored rather than
honoured*: a token minted on the PC is not evidence about the person holding a
phone, and accepting it would be precisely the collapse. This also keeps
`token.ts`'s three properties untouched — M4.5 found the consequence of
per-launch minting from the tab's side and deliberately did not change it, and
nothing here changes it either.

The honest boundary, written down because the alternative is pretending the
header is unforgeable: `Tailscale-User-Login` is set by `tailscaled` on this
machine, which also proxies to loopback, so a *local process* could send the
header itself with a `Host` naming the tailnet authority and get in without the
token. That grants it nothing, because a local process running as the user can
already read the 0600 token file and open the SQLite database directly — it is
the same principal `token.ts` says loopback has. The door that stays shut is the
one that matters: a web page cannot set `Host` or `Tailscale-User-Login`, both
being forbidden header names, so the DNS-rebinding attack `origin.ts` was built
against is closed exactly as it was.

*The MCP process pokes the owner over the port the owner already publishes, and
a host with no owner has no push.* The doc offered a counter in
`daemon-runtime.json` or a local socket. A counter in a file is a poll with
extra steps — the GUI would have to watch the file, and `fs.watch` is per
platform, unreliable on network filesystems and a timer underneath on several
of them. So: a socket, and the one already there. `daemon-runtime.json` names
the owner's pid and its `linkPort`, the owner is serving a gated HTTP server on
it, and the token sitting in a 0600 file next door is readable by exactly the
principal that may poke — the user. One `POST` under `WEB_PREFIX`, token
required, `Origin` required and ours, and the MCP process is a client of a
server that already existed.

The consequence is worth stating plainly rather than discovering: **a daemon
spawned over `ssh` or `wsl.exe` owns nothing.** It binds no port and writes no
runtime file, deliberately, since M2 — a data directory has one owner and a
stdio daemon is not competing to be it. So an agent writing on a host reached
that way pokes nobody, and the fifteen-second poll is what notices. The remedy
is not a new mechanism; it is the toggle in slice 3, which gives that host an
owner. Turning on "Reachable on your tailnet" is what buys live updates, and
saying so is better than building a second channel for the case where it is off.

*Discovery runs when somebody opens the Hosts screen, and never on its own.*
"With no configuration" is about what the *user* types, not about what the app
does while nobody is watching. Probing every peer on a schedule is a connection
to every machine on the list, which is what `core/hosts/pool.ts` exists to avoid
and what M4.3 refused to do to render a home screen — and it would be worse
here, because the list includes machines that are not this user's problem.

So it is a screen-triggered read with a bounded cost, and the cost is worth
computing rather than hand-waving. The candidate set is peers from `tailscale
status --json` that are `Online` and carry the same `UserID` as `Self` — an
ownership check from the same file the identity check reads, not a guess. Each
candidate gets one HTTP `GET` with a one-second timeout. A phone is not
filtered out by its `OS` field, because a blocklist of operating systems is the
same shape as M5.2's blocklist of distribution names and goes stale the same
way; it is filtered out by *answering nothing*, which costs a refused TCP
connect in single-digit milliseconds. Nine phones and one PC is ten parallel
connects, nine of them refused, once, when a screen is opened. That is the
whole bill.

*Discovery proposes; it never adds.* `isLocalOnly` refuses the whole `hosts.`
prefix so that a hub cannot be talked into becoming a mesh, and a discovery that
inserted rows would walk around that from the other side. Found peers appear as
a proposal with an Add button. A peer whose instance id already names a row is
shown as already added, naming the row it collided with — which is M4.1's
collision report doing its job one step earlier, before the insert rather than
after it. M5.2 fired that report for real and drew the conclusion this relies
on: one machine is one row even when two carriers reach it, because
`#/h/<instance>/…` routes by instance id and two rows bearing one id make every
remote route ambiguous. `pc-wsl` is already an `ssh` row on this Mac, so it is
the case discovery meets first rather than a hypothetical.

**M6.0, done on the Mac against the real tailnet, 11 September.** Three
questions, and the third one had a surprise in it.

*The identity header arrives, and it survives a WebSocket upgrade.* `tailscale
serve --bg --http=8080 http://127.0.0.1:43111` in front of a header-echoing
server produced `tailscale-user-login: michal-wrzosek@github` on an ordinary
`GET` — from the Mac itself, and from `pc-wsl` over the tailnet — and on the
upgrade request of a `ws://` connection that then carried frames both ways. The
upgrade is the half that could have failed silently, because a proxy that
forwards headers on requests and drops them on upgrades would have left the
gate working for the phone and refusing every carrier.

*The proxy connects from loopback, which is what makes this a change to the
gate rather than an addition beside it.* `req.socket.remoteAddress` is
`127.0.0.1` for a request that came from another machine, and `Host` is
`mac.tail688c0c.ts.net:8080`. So the existing `isAllowedHost` refuses it — not
because the request is suspect, but because "the authority this server was
reached at" now has two legitimate values instead of one. `x-forwarded-for`
carries the peer's tailnet IP, which is how the two are told apart from the
inside.

*`--https` is not available on this tailnet, and the milestone has to be
honest about it rather than assume.* `tailscale serve --bg --https 8443` hangs
with no output; `tailscale cert` says why — *your Tailscale account does not
support getting TLS certs*, which is HTTPS certificates being off for the
tailnet rather than anything about this machine. `--http` applies instantly and
needs no certificate.

The consequence for the fifth bullet is that a `webUrl` spelled
`https://<host>.<tailnet>.ts.net/review/4/…` by *convention* would be a URL
that does not open, on a tailnet where nothing warned anybody. So `webUrl` is
**derived from what this install actually did** — the scheme and port it asked
`tailscale serve` for, and the `DNSName` from `tailscale status --json` →
`Self` — rather than assembled from a template. It is the same rule
`core/mcp-launcher.ts` follows for the launcher path: a fact reported by the
machine that knows it beats a string that is usually right.

Plain HTTP over a tailnet is not plaintext on a network: WireGuard is doing the
encryption a layer down, between the two machines, and `tailscale serve`
refuses to leave the tailnet at all — that is what `funnel` is for and it is a
non-goal here. Enabling HTTPS in the admin console is a one-click improvement
and the code takes it automatically when a certificate is obtainable, because
it reads what happened rather than deciding in advance.

The port is `LINK_SERVER_PORT`, the same 41427 on the tailnet as on loopback.
S6 chose that number so a link written on one machine on Tuesday opens on
another on Thursday; a tailnet URL that used a different one would be a second
number to defend for no benefit, and the port is not what makes the two
authorities different.

**M6.1, done on the Mac, 11 September.** The claim in `shared/rpc.ts` turned out
to be true, and checking it first was worth most of a slice. `RpcEvent` and
`isRpcEvent` have been sitting there since M1 with nothing emitting on them, and
`core/rpc/stdio-client.ts` was written in M4 against that shape — it reads a
frame, asks `isRpcEvent`, and hands anything that is one to `onEvent` rather
than looking for a request to answer. The comment said the shape was there so
"the message simply arrives", and it does: **the stdio carrier needed no change
at all**, which is the difference between M6 having five carriers to teach and
three.

What did need teaching was the browser's carrier, and it is the same lesson from
the other side. `web/carrier.ts` dropped anything without a numeric id —
`if (!response || typeof response.id !== 'number') return` — which is a
perfectly good guard against a malformed frame and also, silently, against every
event that would ever be pushed to a tab. It now asks `isRpcEvent` first, using
the shared discriminator rather than "has no id", because the two ends of that
socket have to agree about what a frame is and one of them is a Node process.

    core/events.ts          one bus, two sources, names only
    core/rpc/dispatcher.ts  a write that succeeded announces itself
    main/events.ts          the window's half, four lines
    web/carrier.ts          the tab's half, and the guard that hid it
    renderer/lib/events.ts  a hint becomes a `mutate`
    renderer/lib/event-scope.ts  which keys, on which machine

**The emit is in the dispatcher because that is where the human surface already
was.** M1 put `HUMAN_AUTHOR` there and wrote down why: agents do not come
through the dispatcher at all — the MCP server imports `core/services` directly
— so the boundary *is* the enforcement. The same boundary answers "who
announces a write", and it answers it the same way: a person's writes announce
themselves here, and the agent's process announces its own (M6.2). Putting the
emit in the services would have covered both in one place and thrown that
distinction away, and it is the distinction the next three slices are built on.

`EVENT_FOR_METHOD` is a table someone maintains rather than a guess from the
method name, for the reason `READ_METHODS` is: being wrong is silent in both
directions. A missing entry is a screen that waits fifteen seconds; an extra one
is a refetch nobody needed; neither is a type error.

**The event names a family, not a row, and that is what makes it the same
behaviour as a local write rather than a second one.** `comments.reply` names a
thread and `comments.remove` names a comment, so deriving "review 4" would mean
a database lookup in the one place that must not fail after a write has already
committed. It does not need to, because the renderer's own writes already
invalidate by family — `mutate(key => key.startsWith('reviews:'))` — so an event
doing exactly that is one code path rather than two. If a local write refreshes
the right screens, a remote one now does too, by the same lines.

**The scoping is a suffix, and it is the only part with a test.** `scoped()` in
`lib/api.ts` puts `@<instance>` on the *end* of every key a host owns, so
"everything about that machine" is `endsWith` — the same trick
`use-reconnect.ts` uses from the other direction. An event from `pc-wsl`
refreshes `pc-wsl`'s keys and leaves this Mac's alone. Getting that wrong would
have been invisible: every screen still correct, and six machines' worth of
SQLite re-read whenever an agent typed anything. So the rule moved into
`renderer/lib/event-scope.ts`, which has **no imports at all** — the same shape
`host-reachability.ts` chose and for the same reason. `lib/events.ts` cannot be
a node program, because it reads `CACHE_PREFIXES` from `lib/api.ts` and that
module throws at import without `window.gitwarren`, deliberately; the rule can
be, and the rule is the part worth pinning down.

**Verified on one machine with two shells, which is the arrangement that already
existed.** The Electron window reaches the core over IPC and a browser tab
reaches the same process over the loopback socket, so a write arriving on one
and being noticed on the other has crossed the whole channel. `scripts/verify/
m6-1.mjs` plays the tab with `ws`, the session cookie and the real `Origin`, so
what it exercises is the same upgrade, the same gate and the same
`serveWebSocket` a browser gets.

A comment written on the socket reached the window's carrier in **2 ms**,
carrying `{event: "comments.changed", data: null}` and no host — correctly, since
this core *is* the window's own install. A reply typed in the window reached the
socket. Three reads — `reviews.open`, `reviews.diff`, `repositories.list` —
produced no events at either end, which is the check that matters most, because
an event per read is a refetch storm that looks exactly like working software.

And the part a person actually sees: with the conversation tab open on review 1,
a comment written over the socket **appeared in the window with nothing
touching it** — no focus, no navigation, no fifteen-second wait. That is the one
step that would still have been missing if the scoping were wrong, and nothing
earlier in the script would have noticed.

**What is still a poll, deliberately.** Everything. The fifteen seconds,
`onErrorRetry`, `revalidateOnFocus` and M4.5's banner are untouched, and the
application with `core/events.ts` deleted is M5 exactly — slower, never wrong.
That is the property "additive" has to mean, and it is worth checking rather
than asserting: `mutate` on a key with no subscriber does nothing at all, so an
event for a review nobody has open costs one map lookup and produces no read.

**M6.2, done on the Mac, 11 September.** The channel from M6.1 is per process,
and the agent is in a different one. `core/daemon-runtime.ts` argued years of
this repository's thinking into one paragraph — the MCP server opens SQLite
directly and never routes reads through a running GUI, so quitting GitWarren
does not stop an agent working — and the cost of that, which nothing had had to
pay before, is that `emitEvent` in the MCP process reaches nobody.

**The poke is a `POST` to the owner, and the argument for it is that nothing had
to be invented.** `daemon-runtime.json` already names the owning pid and its
`linkPort`; the owner is already serving `core/web/handler.ts` there;
`core/web/token.ts` already writes the session token beside it at mode 0600,
readable by exactly the principal that may poke. So the whole delta is one path,
one header and a client that never throws.

The plan's other candidate was a counter in `daemon-runtime.json`, and it is
worse for a reason worth stating: something would have to *watch* the file.
`fs.watch` is a different mechanism on each platform, unreliable on network
filesystems, and a poll underneath on several of them — so a counter is a poll
with extra steps, dressed as a push. The file stays what it has always been, a
published fact read fresh on every use.

**It breaks a property `handler.ts` had held since M3, so the exception is
written into that file's header rather than left to be found.** Everything
behind that gate was a read; this is the one write. Three independent locks, and
the interesting part is that each answers a different question: the token asks
whether the caller was *pointed at* GitWarren; `Host` and `Origin` ask whether
it is a web page, which is the attacker `origin.ts` was built against; and a
closed vocabulary decides what may go on the bus here rather than letting a
caller's string decide. `host.state` is refused by name — it is minted by this
install's own pool from a connection it is holding, and nothing outside the
process has any evidence about it.

The honest bound is in the module: a local process running as the user can
already open the database, so the worst this endpoint grants is making a window
re-read something it could have caused by writing a row. The token is not
authentication of a person and `token.ts` never claimed it was.

**A host with no owner has no push, and that is the design.** A daemon spawned
over `ssh` or `wsl.exe` binds nothing and writes no runtime file — deliberately,
since M2 — so an agent on a machine reached that way finds no owner, pokes
nobody, and the GUI notices on its next poll. The remedy is not a second
mechanism; it is M6.3's toggle, which gives that machine an owner and a socket
to push down. Saying so is better than building a channel for the case where it
is off.

**Verified against a real MCP session, `scripts/verify/m6-2.mjs`.** Not the
services called directly: the poke lives in `runWrite`, after the service call
and inside the agent boundary, so a harness that skipped the tool call would
have proved nothing. An agent's `add_review_comment` reached the window's
carrier in **12 ms** as `{event: "comments.changed", data: null}`, and with the
conversation tab open the comment appeared with nobody touching the window. Two
agent *reads* produced no events, which is the check that matters most.

And the property the whole arrangement exists to protect, checked rather than
assumed: an MCP server started against a data directory nothing owns answers its
tools normally. No owner is the common case, not an error.

**Two things bit, and one of them was a real bug.**

*A refusal nobody receives is not a refusal.* The body cap destroyed the request
socket the moment it was passed, which took the connection down *before* the
`413` could be written — so the caller saw `other side closed` where it should
have seen a status it could read. Found by the test rather than by reading, and
the fix is an ordering: stop accumulating (which is what bounds the memory),
settle immediately rather than waiting for an `end` an endless body will never
send, answer, and only then hang up. It is the same shape as M4.1's
`diagnostics()` lesson from the other direction — the useful thing and the
teardown are in a race, and the teardown must lose.

*A protocol change is a protocol change even when both ends are on this
machine.* The first run failed with `405 Allow: GET, HEAD` from an app that was
perfectly healthy: it was running the build from before the notify path existed.
M4.5 and M5 were the only slices with nothing to say about version skew, and
this is the cheapest possible version of it — two processes from the same
checkout, one of them stale. Every slice from here needs the app rebuilt and
restarted before it is asked anything, and a host reinstalled before it is.

**M6.3, done on the Mac against the real tailnet, 11 September.** The biggest
slice, and the one where the plan's own wording turned out to need checking
against the machine.

    core/tailnet.ts        what Tailscale knows, asked rather than assumed
    core/web/exposure.ts   one answer, for three layers that need the same one
    core/web/origin.ts     a second authority, and a different question on it
    core/web/handler.ts    the gate, satisfied two ways and never one for the other
    mcp/gui-link.ts        `webUrl`, when there is one
    features/settings/tailnet-panel.tsx   the switch

**A second authority, not a second server.** `tailscale serve` proxies from the
tailnet *to loopback*, so a request from a phone arrives on 127.0.0.1 with
`Host: mac.tail688c0c.ts.net:41427`. There is no socket to tell the two apart
by; the header is the whole difference. That makes this a change to
`isAllowedHost` rather than a listener beside it, and everything `origin.ts`
already said stays true - a browser cannot change `Host`, so requiring it to be
one of the two we hand out forecloses rebinding on both.

**The token and the identity header answer different questions, and a request
satisfies one or the other.** Written into `isTailnetOwner` rather than only
into this document, because it is the thing most likely to be undone by somebody
being helpful. `token.ts` asks *did the user point something at GitWarren, or
does this merely know the port* - about intent, on a machine where every process
is already the user. The header asks *is the person at the other end the owner* -
about principal, on a network where intent cannot be checked at all. So a token
presented on the tailnet authority is **ignored rather than honoured**: a token
minted on the Mac is not evidence about the person holding a phone. `token.ts`
is untouched, and M4.5's finding about per-launch minting still stands exactly
as it did.

The honest bound is in the module rather than implied: a *local* process can set
the header itself with a tailnet `Host` and get in without the token. It gains
nothing - it can already read the 0600 token file and open the database - and it
is the same principal `token.ts` says loopback has. The door that matters stays
shut, because a web page can set neither `Host` nor `Tailscale-User-Login`,
both being forbidden header names.

**`webUrl` is derived from what happened, not from the plan's spelling.** The
plan writes it `https://<host>.<tailnet>.ts.net/review/4/…`. M6.0 found that
this tailnet has no HTTPS at all, so a URL assembled by convention would have
been handed to an agent, handed to a person, and refused to open, with nothing
anywhere having warned. `serveTailnet` asks for HTTPS, falls back to HTTP, and
reports which it got; the panel and the MCP result both show what the machine
said. A tailnet that enables certificates later gets `https` on the next toggle
with no code change.

It also carries the *mount*, which is not cosmetic: the app serves the web build
at `/app/` and the daemon at `/`, so a URL naming only the origin would land a
phone on the Electron link page rather than in the app.

**The route in a `webUrl` is an ordinary app hash, and that is M2's two
notations finally paying off.** A loopback link's fragment is `h=<id>/review/4`
- a *deep link waiting to be assembled*, handed by the page to a local
GitWarren which then decides whose review it is. A tailnet URL is not waiting
for anything: the server answering it is the machine that owns the review, so
the fragment is `#/reviews/4/conversation` with no host segment, because there
is no other machine in the story. `deep-link.ts` predicted in M2 that those two
"stop being the same machine in M4"; this is where they stop.

**The switch is `hosts.setTailnetExposure`, and the prefix is the point.**
Turning exposure on is genuinely an *act* on a machine, which is the thing the
dispatcher may never let travel - and it does not, because `isLocalOnly` refuses
the whole `hosts.` prefix. So a browser tab can expose the install that served
it, which is exactly what the person running `gitwarren serve` on a headless box
needs, and a GUI on the Mac cannot reach across and start `tailscale serve` on
the PC. M5.2 made the same argument for `hosts.distros` and this is the harder
case it was rehearsing for.

**Verified two ways, and the second one is the one that mattered.**
`scripts/verify/m6-3.mjs` forges headers against the running app and checks the
refusals: exposure off is `403` on the tailnet authority; the owner is `200`
with no token; another login is `401`; no header is `401`; a token on the
tailnet authority mints no session; an identity header on *loopback* grants
nothing; the poke endpoint is `404` there; and turning the switch off takes the
authority and the published `webRoot` away again.

Then the same thing from a machine whose header was stamped by a real
`tailscaled` rather than by the test: from `pc-wsl`, `GET
http://mac.tail688c0c.ts.net:41427/app/` answered **200**, and
`/gitwarren/app-info` came back with the Mac's instance id - a second computer,
through the proxy, through the gate, with no configuration on either side beyond
the switch. And the half that could have failed silently: the same request with
upgrade headers answered **101 Switching Protocols**, which is M6.4's carrier
proved before a line of it was written.

**One thing bit, and a test found it rather than a machine.** `isAllowedOrigin`
accepted *either* authority's origin on *either* authority, so a page on
loopback could act on the tailnet authority. Nothing escalated - both pages are
ours, and both had already got through the gate - but the shape was wrong, and
what makes it worth recording is that the comment above the function already
said the right thing ("what neither may be is *the other one*") while the code
did not. A page acts on the server that served it; the origin check now takes
which authority the request arrived at and accepts exactly one value. The next
authority added would have been wrong the same way.

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
- **Per-harness snippets stay, as a fallback.** Three formats, since that is how
  many there are: `mcpServers` covers Claude Code, Cursor, Windsurf and Gemini
  CLI, VS Code renamed the object to `servers`, and Codex keeps its config in
  TOML (`[mcp_servers.gitwarren]`). Behind a "configure by hand" disclosure,
  generated from the same launcher path — `shared/agent-setup.ts` since M3.4.
- **`gitwarren agent-setup`** prints the prompt on any host, for people who
  never open the UI. Prompt on stdout, the state of the launcher on stderr;
  `--manual` adds the three formats.
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
| Daemon process on headless hosts | M2, M3, M4, M5 | Bundle in M2, `gitwarren service install` in M3.3, spawned on demand over SSH in M4 and through `wsl.exe` in M5 — the same installer either way, since it was written against "a machine with a shell and a `tar`". |
| Users who will not run Electron | M3 | The same renderer served by the local daemon; the `gitwarren-cli` formula, `npx gitwarren` and the tarball, all from M3.3. |
| A screen the size of a phone | M3.5, M6 | Files list and diff as separate screens below `lg`, composer above the keyboard, paths that wrap at their separators; the route to the device itself is M6's tailnet. |
| MCP setup per harness and on remote hosts | M2, M3, M4 | Stable launcher path plus a one-sentence prompt the agent applies to its own config. |
