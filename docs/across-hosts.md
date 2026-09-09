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
- **Outcome.** *(pending)*

### S2 — `wsl.exe` stdio from an Electron main process on Windows

- **Question.** Is the pipe clean (UTF-8, no console window, no CRLF mangling)
  when Electron spawns `wsl.exe -d Ubuntu -- cat` and round-trips JSON lines?
- **How.** `node scripts/spikes/s2-wsl-stdio.mjs --distro Ubuntu --mb 10` on
  the PC.
- **Pass.** 10 MB of newline-delimited JSON round-trips byte-exact with
  `windowsHide: true`, and a small line round-trips well under 10 ms.
- **On fail.** Daemon binds a localhost port inside WSL; Windows connects over
  TCP (WSL2 forwards localhost by default).
- **Outcome.** *(pending)*

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
- **Outcome.** *(pending)*

### S4 — Editor deep links to remote files

- **Question.** Does `vscode://vscode-remote/ssh-remote+host/path:42` land on
  line 42 in current VS Code and Cursor? Same for `wsl+Ubuntu`.
- **Pass.** Both editors open the file at the line from `shell.openExternal`.
- **On fail.** Use the CLI form `code --remote ssh-remote+host --goto path:42`,
  which `src/main/editors.ts` already knows how to spawn.
- **Outcome.** *(pending)*

### S5 — How chatty is a screen today?

- **Question.** Count IPC calls and their dependency depth for: the repository
  list, opening a review, the files tab.
- **How.** Start the app with `GITWARREN_TRACE_IPC=1`; every call is logged
  with its duration.
- **Output.** A number per screen and the list of calls that could be one. Sets
  the coarse endpoints in M1. Target: opening a review costs at most three
  sequential round trips.
- **Outcome.** *(pending)*

### S6 — The fixed loopback port

- **Question.** Pick a port outside common ranges, check it is free by default
  on macOS, Windows and Ubuntu, and define behaviour when it is taken (the
  Agent Access panel warns; links are still emitted).
- **Output.** One constant in `src/shared/` and a sentence for the README.
- **Outcome.** *(pending)*

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
  (`src/core/db/schema.ts`, `npm run db:generate`).
- **Routes with a host segment.** `src/shared/routes.ts` accepts
  `h/<instance>/review/4/…`; the segment is optional and omitted for local, so
  every existing link keeps working.
- **Git hygiene.** `--` before user-supplied refs and paths at every `runGit`
  call site in `src/core/git.ts` and `git-compare.ts`; refs validated with
  `git check-ref-format`; worktree file reads confined to the worktree root.

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
