# GitWarren

A cross-platform desktop app for doing local code reviews of your own git
repositories. Single user, single machine, no server, no account.

Tell GitWarren which local git repositories you care about, then open **reviews**
against them — a review is a comparison of two refs, presented the way a pull
request is, with *conversation*, *commits* and *files changed* tabs.

The part that makes it worth having: a review can include work that has not been
committed. If the branch you are reviewing is checked out in a worktree,
GitWarren finds that worktree — wherever it is — and folds its staged, unstaged
and untracked changes into the diff. You can review a change before it is a
commit, which is exactly when review is most useful.

Nothing is cached: every branch name, commit and diff on screen is read from git
at the moment it is shown.

Local AI agents get the same capabilities through an MCP server over stdio.

---

## Contents

- [Stack](#stack)
- [Architecture](#architecture)
- [Reviews](#reviews)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Data storage](#data-storage)
- [Database migrations](#database-migrations)
- [Agent access (MCP)](#agent-access-mcp)
- [Release process](#release-process)
- [Auto-update](#auto-update)
- [Code signing and notarization](#code-signing-and-notarization)
- [Known limitations](#known-limitations)

---

## Stack

| Concern | Choice |
| --- | --- |
| Shell | Electron 44 + TypeScript |
| UI | React 19, Tailwind CSS v4, shadcn/ui-style components on **Base UI** (`@base-ui/react`) |
| Data fetching | SWR (client-side only, no SSR) |
| Storage | SQLite via `better-sqlite3`, Drizzle ORM, generated migration files |
| Validation | zod, shared between UI forms, IPC and MCP tools |
| Agent interface | `@modelcontextprotocol/sdk` over stdio |
| Packaging | electron-builder + electron-updater |

> **Why Electron and not `deno desktop`?** Silent auto-update has to work on
> Windows, and that is the requirement `deno desktop` could not meet. Everything
> in the packaging setup below exists to serve it.

> **Base UI, not Radix.** The components in `src/renderer/src/components/ui`
> follow shadcn/ui conventions (CVA variants, `cn()` merging, the same prop
> shapes) but are built on Base UI primitives. They were written for this
> project rather than pulled from the shadcn registry, because the registry's
> default output targets Radix.

---

## Architecture

The single most important rule in this codebase:

> **The UI and the MCP server both call one shared service layer. Neither one
> contains any repository or review logic of its own.**

```
   ┌────────────────────────────┐         ┌───────────────────────────────┐
   │  Renderer (Chromium)       │         │  MCP server (its own process) │
   │  React + SWR               │         │  stdio JSON-RPC               │
   │                            │         │                               │
   │  window.gitwarren.*        │         │  repository + review tools    │
   └────────────┬───────────────┘         └───────────────┬───────────────┘
                │ contextBridge                           │
                │ ipcRenderer.invoke                       │ direct import
   ┌────────────▼───────────────┐                         │
   │  Main process              │                         │
   │  src/main/ipc.ts           │                         │
   │  (thin delegation only)    │                         │
   └────────────┬───────────────┘                         │
                │                                          │
                └──────────────┬───────────────────────────┘
                               ▼
              ┌──────────────────────────────────────┐
              │  src/core/services/                  │
              │  repositories.ts · reviews.ts        │
              │  validation · path resolution ·      │
              │  duplicate rules · error semantics   │
              └───────┬───────────────────┬──────────┘
                      ▼                   ▼
            ┌──────────────────┐  ┌──────────────────┐
            │ SQLite (WAL)     │  │ git (subprocess) │
            │ durable facts    │  │ live state only  │
            └──────────────────┘  └──────────────────┘
```

The two surfaces are not identical in *reach*: the review service's
`commits` and `diff` reads are wired to the UI only, because an agent can read
the repository with git directly. The rule is that neither surface implements
logic of its own, not that every function must be exposed to both.

Three properties fall out of this shape:

**No drift between surfaces.** `src/main/ipc.ts` is a set of one-line
delegations, and each MCP tool is a thin wrapper. The service re-parses its own
input with the zod schema from `src/shared/schemas.ts` rather than trusting the
caller, so a rule added there applies to the UI, the IPC layer and the agent
tools simultaneously. It is not possible for an agent to write something the UI
would have rejected.

**Two processes, one database.** The GUI and the MCP server are separate OS
processes sharing one SQLite file. Hence WAL journalling and a busy timeout (see
`src/core/db/client.ts`). Changes made by an agent show up in the UI on the next
refresh; the window revalidates when it regains focus.

**`src/core` never imports `electron`.** That is what lets the MCP process reuse
it. It also means the application-data directory is computed by the same
platform-aware function in both processes (`src/core/paths.ts`) rather than one
using Electron's `app.getPath('userData')` and the other guessing.

### Why IPC and not a local HTTP server

The renderer reaches the main process over Electron's context bridge, not over
`fetch` to `127.0.0.1`. A local HTTP server would add a port to allocate and
discover, a listening socket other software on the machine could talk to, and a
startup ordering problem — in exchange for nothing this app needs. SWR is used
exactly as it would be with HTTP; only the fetcher differs.

There is no authentication anywhere. This is a local, single-user app; the MCP
transport is a pipe owned by the agent the user launched, and there is no
network surface to authenticate.

### Error handling across the boundary

Errors cannot cross `ipcRenderer.invoke` intact — Electron stringifies them and
the type is lost. Every handler returns an `IpcResult<T>` envelope instead, and
the preload script rebuilds a real `AppError` on the renderer side. That is what
lets a form show *"This folder is not inside a git repository"* underneath the
path input rather than a generic banner. The MCP tools map the same errors to
`CODE: message` tool errors so agents can branch on the code.

### Attribution, later

The service layer is the single place every write passes through, so adding
`"Person"` vs `"<name> (AI)"` attribution later means threading an actor argument
through one module — the IPC handlers would pass a UI actor, the MCP tools an
agent actor. Nothing is built for it now.

---

## Reviews

A review is two refs and a title. Everything else on the screen is computed from
git when you look at it.

```
  reviews table                    read live, never stored
  ┌──────────────────┐             ┌───────────────────────────────┐
  │ repository_id    │             │ merge base of the two refs    │
  │ base_ref  "main" │  ──────►    │ commits in base..head         │
  │ head_ref  "feat" │             │ diff from the merge base      │
  │ title            │             │ which worktree holds head     │
  │ description      │             │ that worktree's dirty state   │
  │ status           │             └───────────────────────────────┘
  └──────────────────┘
```

### Why the refs are stored and the commits are not

Pinning the resolved shas at creation time would be the obvious thing to do, and
it would defeat the feature. A review is meant to *follow* its branch: you open
one, keep working, and the review shows the work as it stands. That includes work
that is not committed at all, which no sha could ever refer to.

The cost is that a review can stop resolving — someone deletes the branch. That
is treated as a state to render, not an error: the review row survives, the tab
says which ref went missing, and you can repoint it.

### Merge-base, like a pull request

The *files changed* tab shows `base...head` — what head added since the two
diverged — rather than the literal difference between the endpoints. So commits
that landed on `main` after you branched do not show up as reversals in your
review. The *commits* tab lists the same range, `base..head`.

### Finding uncommitted work

This is the part that needs care, because **the repository row points at one
directory and the work under review is often in another**. A branch checked out
in a linked worktree has its uncommitted state there, not in the main checkout.

So every read starts with `git worktree list --porcelain`, which enumerates the
main checkout and every linked worktree from *any* of them — it does not matter
which one was added to GitWarren. The worktree whose branch matches the review's
head ref is the one whose `git status` and working-tree diff get read. If no
worktree has that branch checked out, the review quietly falls back to committed
work only and says so.

Given the head's worktree, the diff is `git diff <merge-base>` run **inside it**,
with no second endpoint — which compares the merge base against the working tree,
so committed, staged and unstaged changes all arrive in one patch.

Untracked files are handled separately: they are listed with
`git ls-files --others --exclude-standard` (so `.gitignore` still applies) and
rendered as whole-file additions. The tempting alternative — staging them into a
scratch index with `GIT_INDEX_FILE` — would write blobs into the user's object
database just to draw a screen, and this app only ever reads.

The switch at the top of the tab turns all of that off, leaving the committed
diff. It is view state, not part of the review: whether you want to read the
branch as it sits on disk or as it would arrive if pushed is a per-visit
question.

### Reading the diff

`git diff` output is parsed once, in `src/core/diff-parser.ts`, into files,
hunks and numbered lines. Two details that a naive line-splitter gets wrong and
this one does not: paths are taken from the `---`/`+++` and `rename from`/`to`
lines rather than the ambiguous `diff --git a/x b/x` line, and a pure rename
carries no hunks at all yet still has to name both paths. Very large files are
clipped for rendering but still report their true add/delete counts.

---

## Development setup

Requirements: **Node 22+**, **npm 10+**, and **git on your PATH** (GitWarren
shells out to your own git rather than bundling one).

```bash
npm install          # also rebuilds native deps for Electron
npm run dev          # start the app with hot reload
```

Other scripts:

| Command | Does |
| --- | --- |
| `npm run dev` | Run the app in development with HMR |
| `npm run build` | Typecheck, then build main / preload / renderer / MCP |
| `npm test` | Integration tests against a real SQLite file and real `git` |
| `npm run typecheck` | `tsc --noEmit` for both the Node and web projects |
| `npm run lint` | ESLint (type-aware) |
| `npm run db:generate` | Regenerate migrations after editing the Drizzle schema |
| `npm run mcp:dev` | Run the MCP server from source against your dev database |
| `npm run package` | Build installers for the current platform, no publish |
| `npm run release` | Build **and publish** to GitHub Releases |

The tests create throwaway git repositories in a temp directory and point the
app at a temp data directory via `GITWARREN_DATA_DIR`, so they never touch your
real database.

---

## Project layout

```
src/
├── shared/            Imported by every process. No Node-only APIs.
│   ├── schemas.ts       zod schemas — the source of truth for validation
│   ├── git.ts           read-only git shapes (types, not schemas — see below)
│   ├── validation.ts    one zod-error → AppError conversion, used everywhere
│   ├── errors.ts        AppError + the error-code vocabulary
│   └── api.ts           IPC channel names and the bridge's type
│
├── core/              The shared service layer. Never imports electron.
│   ├── paths.ts         per-platform data directory (+ env override)
│   ├── git-exec.ts      the one place `git` is spawned
│   ├── git.ts           live repository state; root resolution
│   ├── git-compare.ts   worktrees, refs, commits, diffs, dirty state
│   ├── diff-parser.ts   unified diff → files/hunks/lines
│   ├── db/              drizzle schema, client (WAL), migration resolution
│   └── services/        repositories.ts, reviews.ts — the one implementation
│
├── main/              Electron main process
│   ├── index.ts         window lifecycle
│   ├── ipc.ts           thin delegations to core/services
│   ├── updater.ts       electron-updater wiring
│   └── mcp-launch.ts    computes this install's MCP launch command
│
├── preload/           The only bridge into the renderer
├── mcp/               server.ts — stdio MCP server
└── renderer/          React app (no Node access)
    └── src/
        ├── components/ui/   shadcn-style components on Base UI
        ├── features/        repositories/, reviews/, agent/
        └── lib/             api access, error helpers, hash router
```

`shared/schemas.ts` holds zod schemas; `shared/git.ts` holds plain types. The
rule dividing them: **zod is for values that cross a trust boundary** — anything
a caller supplies that the service must not believe. Git output is produced by
reading the disk and flows one way out to the UI, so a runtime schema for it
would be ceremony with no payoff.

---

## Data storage

One SQLite file in the OS application-data directory:

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/GitWarren/gitwarren.db` |
| Windows | `%APPDATA%\GitWarren\gitwarren.db` |
| Linux | `~/.config/GitWarren/gitwarren.db` (or `$XDG_CONFIG_HOME`) |

Set **`GITWARREN_DATA_DIR`** to override it — used by the tests, and handy for
trying things against a scratch database.

Connection settings, all in `src/core/db/client.ts`:

- `journal_mode = WAL` — the GUI can read while the MCP server writes
- `busy_timeout = 5000` — wait out a brief lock instead of failing
- `synchronous = NORMAL` — the recommended durability level under WAL
- `foreign_keys = ON`

### What is and is not stored

Two tables.

**`repositories`** — `id`, `path` (canonical repository root, UNIQUE), `name`,
`createdAt`, `updatedAt`.

**`reviews`** — `id`, `repositoryId`, `title`, `description`, `baseRef`,
`headRef`, `status`, `createdAt`, `updatedAt`, `closedAt`. Deleting a repository
cascades to its reviews; they are meaningless without it.

**Not** stored: branch, existence, resolved commits, diffs, or anything else git
owns. Those are read on demand every time they are displayed. Caching them would
mean showing a branch name that stopped being true the moment you switched
branches in a terminal — and for reviews it would break the feature outright,
since a review is supposed to track uncommitted work that no sha can name.

### The duplicate rule

When you add a path, the service runs `git rev-parse --show-toplevel` on it and
stores the **repository root**, then canonicalises that with
`fs.realpath.native` — which resolves symlinks *and* reports true on-disk casing
on macOS and Windows. So `/work/app`, `/work/app/src/lib` and `/WORK/APP` all
collapse to one row, backed by a UNIQUE index as the final guard.

---

## Database migrations

Migrations are generated files, committed to the repo, and applied
automatically the first time either process opens the database — so the MCP
server is equally safe to start first.

```bash
# after editing src/core/db/schema.ts
npm run db:generate
```

**Making this work in the packaged app** is the part that usually breaks.
Drizzle's migrator reads `.sql` files from a folder at runtime, but the app's
source lives inside `app.asar`. So `drizzle/` is copied to the app's resources
directory via `extraResources`, and `src/core/db/migrations.ts` resolves it in
this order:

1. `GITWARREN_MIGRATIONS_DIR` if set
2. `process.resourcesPath/drizzle` — the packaged location
3. walking up from the working directory — the dev location

Each candidate is validated by checking for `meta/_journal.json`, so the dev
fallback cannot accidentally match in a packaged app. This path is verified: the
packaged MCP server runs migrations correctly when started from a directory with
no source tree anywhere above it.

---

## Agent access (MCP)

The MCP server exposes ten tools, all backed by the same services the UI uses:

| Tool | Notes |
| --- | --- |
| `list_repositories` | Includes live git state. Read-only. |
| `get_repository` | By id. Read-only. |
| `add_repository` | `path` may be any directory inside the working tree. `name` defaults to the folder name. |
| `update_repository` | Rename, and/or repoint at a moved working copy. |
| `remove_repository` | Stops tracking only — never touches the working copy. |
| `list_reviews` | Filterable by `repositoryId` and `status`. Read-only. |
| `get_review` | By id, with its repository attached. Read-only. |
| `create_review` | Both refs must exist and share history. `title` defaults to `"<head> into <base>"`. |
| `update_review` | Title, description, endpoints, or open/closed. |
| `remove_review` | Deletes the review record only. |

**There is deliberately no `get_review_diff` or `list_review_commits`**, even
though the service layer produces both for the UI. An agent pointed at these
repositories can run `git log` and `git diff` itself, against the real working
tree, with whatever options the task needs — a tool returning a second-hand copy
would be a lossier version of data the agent already has. What GitWarren will
uniquely hold is the *discussion* around the code, and that is what the tools
will carry once the conversation tab is built.

Failures come back as tool errors prefixed with the code
(`NOT_A_GIT_REPOSITORY`, `DUPLICATE_REPOSITORY`, `PATH_NOT_FOUND`, `NOT_FOUND`,
`INVALID_INPUT`, `GIT_UNAVAILABLE`), so an agent can react to the kind of
failure rather than parsing prose.

### Pointing an agent at it

**The app shows you the exact configuration for your install** — open the
*Agent access* panel at the bottom of the window and copy it. The paths depend
on where the app was installed, so prefer the panel over the templates below.

The server is launched using the app's own Electron binary in Node mode. That is
deliberate: `better-sqlite3` is a native addon that must be loaded by a runtime
whose ABI it matches, and it has to resolve out of the app's unpacked
`node_modules`. Using the bundled binary satisfies both, and means **no Node
installation is required**.

macOS:

```json
{
  "mcpServers": {
    "gitwarren": {
      "command": "/Applications/GitWarren.app/Contents/MacOS/GitWarren",
      "args": [
        "/Applications/GitWarren.app/Contents/Resources/app.asar.unpacked/out/mcp/server.cjs"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Windows (per-user install):

```json
{
  "mcpServers": {
    "gitwarren": {
      "command": "%LOCALAPPDATA%\\Programs\\GitWarren\\GitWarren.exe",
      "args": [
        "%LOCALAPPDATA%\\Programs\\GitWarren\\resources\\app.asar.unpacked\\out\\mcp\\server.cjs"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Linux — see [Known limitations](#known-limitations); an AppImage needs to be
extracted once first.

From a source checkout, `npm run mcp:dev` runs the same server against your dev
database.

The app does not need to be running for the MCP server to work — both open the
same database independently.

---

## Release process

Artifacts and the update manifest are published to **GitHub Releases**
(`michal-wrzosek/gitwarren-app`, configured in `electron-builder.yml`).

```bash
# 1. Bump the version. electron-builder reads it from package.json,
#    and it becomes the version electron-updater compares against.
npm version patch          # or minor / major — creates a commit and a tag

# 2. Verify before shipping.
npm run lint && npm test

# 3. Build and publish.
export GH_TOKEN=<a token with `repo` scope>
npm run release            # electron-builder --publish always

# 4. Push the tag.
git push --follow-tags
```

`npm run release` runs the typecheck, builds all four bundles, packages the
installers, and uploads them plus the manifests to a GitHub release for the
current tag. The release is created as a **draft** — publish it in the GitHub UI
when you are ready, and that is the moment clients begin to see the update.

To build without publishing (for local testing):

```bash
npm run package        # installers into release/<version>/
npm run package:dir    # unpacked app only, much faster
```

### What gets produced

| Platform | Artifacts |
| --- | --- |
| Windows | `GitWarren-<v>-x64.exe`, `-arm64.exe` (NSIS), `.blockmap` each, `latest.yml` |
| macOS | `-arm64.dmg`, `-x64.dmg`, `-arm64.zip`, `-x64.zip`, `.blockmap` each, `latest-mac.yml` |
| Linux | `-x64.AppImage`, `-arm64.AppImage`, `latest-linux.yml` |

The `.blockmap` files are what make updates differential: electron-updater
compares block hashes with the installed version and downloads only the changed
ranges.

The macOS **zip is required** — electron-updater reads the zip, not the dmg.
Dropping that target still produces a working installer but silently breaks
auto-update.

Cross-building for every platform from one machine is not reliable (Windows
code signing and macOS notarization both need their own host). Run the release
on each platform, or in a CI matrix, and publish to the same tag.

---

## Auto-update

Behaviour: check on launch and every 6 hours, download in the background without
asking, apply on the next restart. The only UI is a quiet banner once a version
is staged, offering an immediate restart. Doing nothing is also fine — it
applies on the next quit either way. A failed check never interrupts the
session; the app keeps running on the current version and retries later.

`src/main/updater.ts` sets `autoDownload` and `autoInstallOnAppQuit` explicitly.
Both are library defaults, but they *are* the requirement, so they should not be
silently inherited.

Auto-update is inert when `app.isPackaged` is false, so development builds don't
try to reach GitHub on every launch.

### Why these targets

| Platform | Target | Silent update |
| --- | --- | --- |
| Windows | NSIS, **per-user** (`perMachine: false`, `oneClick: true`) | ✅ |
| macOS | zip (feed) + dmg (distribution) | ✅ |
| Linux | AppImage | ✅ |
| Linux | deb / rpm | ❌ — needs `apt`/`dnf` and a sudo prompt |

The Windows install is **per-user**, which is what keeps updates free of UAC
prompts. A per-machine install writes to `Program Files` and every update would
raise an elevation dialog — which would defeat "silent" entirely.

`deleteAppDataOnUninstall` is off, so uninstalling does not throw away the
user's repository list.

---

## Code signing and notarization

**Not required for local development builds.** Unsigned builds run fine on your
own machine; electron-builder logs `skipped macOS application code signing` and
carries on.

They *are* required before distributing to anyone else — and specifically,
**auto-update on macOS will not work unsigned**, because Squirrel.Mac validates
the code signature of the downloaded build before swapping it in.

**macOS.** Needs an Apple Developer account ($99/year), a *Developer ID
Application* certificate in the login keychain, and an app-specific password (or
App Store Connect API key) for notarization. Then set `notarize: true` in
`electron-builder.yml` and provide:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

The hardened runtime is already enabled, with entitlements in
`build/entitlements.mac.plist` covering what this app actually needs: JIT for
V8, library validation disabled (the app spawns `git`, and agents spawn the
bundled MCP server), and user-selected file access for repositories on any
volume.

**Windows.** Needs a code-signing certificate — since June 2023 an OV
certificate must live on a hardware token or an HSM, so the practical options
are a cloud signing service or an EV certificate. Configure it through
`win.certificateFile`/`certificatePassword`, or a signing hook for a cloud
provider. Without signing, SmartScreen warns users on first run; updates still
work, since electron-updater verifies the sha512 from the manifest rather than
a signature.

**Linux.** AppImage needs no signing.

---

## Known limitations

- **Linux AppImage + MCP.** An AppImage is re-mounted at a new
  `/tmp/.mount_*` directory on every launch, so the paths inside it are not
  stable and cannot be pasted into an agent config that will be reused. The
  *Agent access* panel detects this and says so. Extract the AppImage once and
  point the agent at the result:
  ```bash
  ./GitWarren-0.1.0-x64.AppImage --appimage-extract
  # then use squashfs-root/gitwarren and
  #      squashfs-root/resources/app.asar.unpacked/out/mcp/server.cjs
  ```
- **git must be installed** and on the PATH. GitWarren shells out to it rather
  than bundling an implementation. If it is missing, the app says so explicitly
  (`GIT_UNAVAILABLE`) instead of showing an empty list.
- **Repository state is read serially per refresh.** Each repository costs a few
  `git` subprocess calls. They run in parallel across repositories, but a list of
  many hundreds on a slow or networked filesystem will feel it.
- **No file watching.** Git state refreshes when the window regains focus or you
  press refresh, not the instant you switch branches elsewhere. The commit and
  diff reads go further and do *not* refresh on focus — re-running a diff every
  time you alt-tab would spawn git processes behind your back — so those tabs
  have an explicit refresh button.
- **The conversation tab is a placeholder.** It shows the review's description
  and nothing else. Comments are the next piece of work, and the point at which
  `"Person"` vs `"<name> (AI)"` attribution becomes worth building.
- **Diffs are unified, not side-by-side**, and have no syntax highlighting or
  word-level intra-line highlighting.
- **Large diffs are clipped.** A file's patch stops rendering past 4,000 lines
  and untracked files over 512 KB are listed without content, though the
  add/delete counts stay honest. Commit lists stop at 500.
- **Uncommitted work is read from one worktree** — the one whose branch matches
  the review's head ref. If the same branch is somehow checked out in two places,
  the first one `git worktree list` reports wins.
- **Submodules are not descended into.** A dirty submodule shows as a changed
  entry, not as the changes inside it.
- **macOS auto-update requires signing** (see above). Unsigned builds install
  and run, but will not self-update.
- **The renderer bundle is ~1 MB** unminified-by-dependency-count (React, Base
  UI, zod). It loads from disk, so this costs startup milliseconds rather than
  bandwidth, and has not been optimised.
- **Editing a repository's path** is allowed and re-validated, but there is no
  detection of a repository having moved — you have to notice the *Folder
  missing* badge and repoint it yourself.
