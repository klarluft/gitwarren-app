<img src="src/renderer/src/assets/logo.png" alt="" width="112" height="112" />

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
- [Navigating a large diff](#navigating-a-large-diff)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Data storage](#data-storage)
- [Database migrations](#database-migrations)
- [Agent access (MCP)](#agent-access-mcp)
- [Images in comments](#images-in-comments)
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

### Attribution

Comments carry an author; nothing else does. The rule that makes it trustworthy
is that **the author is an argument to the service, never a field in the
payload**:

```ts
commentsService.createThread(input, actor)   // actor supplied by the surface
```

`main/ipc.ts` passes `HUMAN_AUTHOR` and nothing else can, because typing into the
app is the only way to reach an IPC channel. `mcp/server.ts` passes an agent
author built from the connection. No caller can name itself by putting an author
in the request body — there is nowhere in the input schemas to put one. See
[Who wrote what](#who-wrote-what).

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

### Navigating a large diff

Files changed carries three things a long diff needs, all of them optional and
none of them costing anything until used:

- **A file tree** down the left, folded so a lone directory collapses into its
  parent (`renderer/src` on one row). Clicking a file scrolls to it, and the row
  for whatever is nearest the top of the page stays highlighted as you scroll.
  The toggle beside it is remembered across restarts.
- **Unfolding the lines between the hunks**, the way GitHub does. `git diff`
  prints three lines of context, so most of a file is not on screen; the
  expanders in the gutter reveal twenty lines at a time or the whole run, and
  **Expand all lines** in the file header opens every gap at once. Unfolded
  lines are ordinary context rows — a comment can be left on one exactly as on
  any other line.

A `@@` header announces a break in the file, so it is drawn only while there is
still a break to announce. A folded gap carries the header on its own expander
row, the way GitHub puts the unfold controls there; unfold that gap and the
header goes with it, because the code now runs continuously into the hunk and a
divider across continuous code is a false statement about the file. Expand
everything and the file reads top to bottom with no markers in it at all.

The same rule removes the header from the top of a hunk that starts at line 1,
which is every new file and every deleted one: there is nothing above it to be
separated from. What keeps a header is a real break with no expander to mark it
— which happens in the files the diff cannot unfold at all (binary, clipped),
where it is the only thing saying two lines are not adjacent.
`continuesFromAbove` in `shared/diff-gaps.ts` decides this, using the same
off-by-one convention for empty ranges as the gap arithmetic beside it.
- **Copy path** and **open in your editor**, per file.
- **Back to top**, once you are a screen or so down. It is app-wide rather than
  a diff feature, but the diff is where the scrollbar gets small enough to
  matter. Two details: the whole app scrolls inside `<main>` rather than the
  window, so the button acts on that element (`window.scrollTo` would do
  nothing at all here); and the trip is animated only when it is short enough
  to follow — smooth-scrolling the length of a large diff takes seconds and
  reads as the app hanging, so past five thousand pixels it simply jumps.

Every icon-only control carries a real tooltip rather than a `title` attribute
(`components/ui/tooltip.tsx`). The browser decides when to show a `title` —
usually a second or more after the pointer stops — it cannot be styled, and it
never appears for keyboard users at all; a button whose whole meaning is its
label cannot afford any of that. One `TooltipProvider` at the root groups them,
so the first tooltip waits and moving along a row of buttons then shows each
immediately. `title` is still used for *supplementary* text: the full path
behind a truncated one, the meaning of a badge.

The unfolding costs one read of the whole file, taken the first time the
reviewer asks and reused for every later expansion of the same file. It is
deliberately not a line-range API: a range per click would be a git process per
click, and reading the file once is also the only way to know where it *ends*,
which no hunk header can say. The read follows the "include uncommitted" switch,
because context taken from the other version of the file would not line up with
the hunks it sits between. `src/shared/diff-gaps.ts` holds the arithmetic that
decides where the hidden runs are and which line number each unfolded line gets;
it is pure, and unit-tested against the shapes that get this wrong — a diff that
does not start at line 1, and git's off-by-one convention for an empty range.

### Opening a file in an editor

`system.editors()` probes for VS Code, Cursor, Windsurf, Zed, Sublime Text and
the JetBrains launcher, once per run: the application bundle in the usual
locations, and the command on `PATH`. Whatever is found is offered in a picker
next to the diff, and the choice is kept in `localStorage` — a preference of the
person, not a fact about the review, and this app has no settings screen to put
it on.

Opening prefers the URL scheme the application registered for itself
(`vscode://file/…:12`), which carries the line number and works whether or not
the user ever installed the shell command; the CLI is the fallback, and the
platform's default handler for the file is the fallback to that.

Set `GITWARREN_EDITOR` to override, either with an id from the list above or
with a command template:

```sh
GITWARREN_EDITOR='emacsclient +{line} {file}'
```

The file is resolved inside the worktree that holds the head branch, not
necessarily the directory the repository was added from — the same rule the rest
of the app follows. A file that exists only in a commit has nothing to open, and
says so.

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
│   ├── actors.ts        who wrote a comment; Human vs "<tool> (AI)"
│   ├── comment-anchors.ts  re-finding a comment's lines after the branch moves
│   ├── diff-gaps.ts     where a diff's hidden lines are, for unfolding them
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
│   ├── attachment-ingest.ts  rewrite a body's local image paths to tokens
│   ├── db/              drizzle schema, client (WAL), migration resolution
│   └── services/        repositories.ts, reviews.ts, comments.ts,
│                        attachments.ts — the one implementation of each
│                        operation
│
├── main/              Electron main process
│   ├── index.ts         window lifecycle
│   ├── ipc.ts           thin delegations to core/services
│   ├── attachment-protocol.ts  serves gitwarren:// attachment images
│   ├── updater.ts       electron-updater wiring
│   ├── editors.ts       finds the user's code editor and opens a file in it
│   └── mcp-launch.ts    computes this install's MCP launch command
│
├── preload/           The only bridge into the renderer
├── mcp/               stdio MCP server
│   ├── server.ts        tool definitions
│   └── identity.ts      naming an agent from its MCP handshake
└── renderer/          React app (no Node access)
    └── src/
        ├── assets/          logo.png, inlined as a data: URI by the CSP
        ├── components/      markdown.tsx + ui/ (shadcn-style, on Base UI)
        ├── features/        repositories/, reviews/, comments/, agent/
        └── lib/             api access, error helpers, hash router
```

`shared/schemas.ts` holds zod schemas; `shared/git.ts` holds plain types. The
rule dividing them: **zod is for values that cross a trust boundary** — anything
a caller supplies that the service must not believe. Git output is produced by
reading the disk and flows one way out to the UI, so a runtime schema for it
would be ceremony with no payoff.

Outside `src/`, `gitwarren-logo.png` in the repository root is the 1710px master
of the logo. The two files that are actually used are cut from it and should be
recut from it rather than from each other:

| File | Size | Used for |
| --- | --- | --- |
| `build/icon.png` | 1024px, artwork inset to 860px | electron-builder renders the `.icns`, `.ico` and Linux icons from it; `main/index.ts` also hands it to `BrowserWindow` so Linux windows have an icon at all. The inset is the padding the macOS icon grid expects — without it the Dock icon sits noticeably larger than its neighbours. |
| `src/renderer/src/assets/logo.png` | 128px, no padding | The app header, and the image at the top of this README. |

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

Alongside the database, in the same directory, is `attachments/` — images
copied in from comments, named by the sha256 of their contents and sharded a
directory deep (`attachments/ab/abc….png`). It is the only other thing GitWarren
writes.

Connection settings, all in `src/core/db/client.ts`:

- `journal_mode = WAL` — the GUI can read while the MCP server writes
- `busy_timeout = 5000` — wait out a brief lock instead of failing
- `synchronous = NORMAL` — the recommended durability level under WAL
- `foreign_keys = ON`

### What is and is not stored

Five tables.

**`repositories`** — `id`, `path` (canonical repository root, UNIQUE), `name`,
`createdAt`, `updatedAt`.

**`reviews`** — `id`, `repositoryId`, `title`, `description`, `baseRef`,
`headRef`, `status`, `createdAt`, `updatedAt`, `closedAt`. Deleting a repository
cascades to its reviews; they are meaningless without it.

**`comment_threads`** — `id`, `reviewId`, then the anchor: `filePath`, `side`,
`line`, `anchorText`, `anchorSha`. All five are null together for a review-level
thread and set together for a line comment. Plus `resolvedAt`, `resolvedBy`,
`createdAt`, `updatedAt`. Cascades from `reviews`.

**`comments`** — `id`, `threadId`, `authorKind`, `authorName`, `authorLabel`,
`authorSession`, `body`, `createdAt`, `updatedAt`. Cascades from
`comment_threads`.

Authorship is denormalised onto every comment row rather than pointing at a
users table, and there will not be a users table. An author here is not an
account but a description of where a message came from — the person at the
keyboard, or a named agent process that has since exited. Copying the label onto
the row keeps that description true forever, which a foreign key to a mutable
identity would not.

**`attachments`** — `sha` (PRIMARY KEY), `ext`, `mimeType`, `byteSize`, `width`,
`height`, `originalName`, `createdAt`. See [Images in
comments](#images-in-comments). Note what it does *not* have: a foreign key to
the comment it belongs to. The body text is the only record of which images a
comment uses, and unreferenced rows are collected by a sweep at startup — so
deleting an image from a comment is just deleting it from the text.

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

The MCP server exposes seventeen tools, all backed by the same services the UI
uses:

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
| `agent_identity` | How this session's comments will be attributed. Optionally sets a session `label`. |
| `list_review_comments` | Every thread, with messages, authors, resolved `attachments`, and where each one lands in the current diff. Read-only. |
| `add_review_comment` | Opens a thread. Omit `filePath`/`line` for a review-level comment. Local image paths in the body are copied in and rewritten. |
| `reply_to_review_comment` | Adds a message to an existing thread. Same image handling as above. |
| `resolve_review_comment` | Marks a thread settled, or reopens it. |
| `update_review_comment` | Edits one message. Own comments only. |
| `delete_review_comment` | Deletes one message; the thread goes too if it was the last. |

**There is deliberately no `get_review_diff` or `list_review_commits`**, even
though the service layer produces both for the UI. An agent pointed at these
repositories can run `git log` and `git diff` itself, against the real working
tree, with whatever options the task needs — a tool returning a second-hand copy
would be a lossier version of data the agent already has. What GitWarren
uniquely holds is the *discussion* around the code, which is what the comment
tools carry.

Failures come back as tool errors prefixed with the code
(`NOT_A_GIT_REPOSITORY`, `DUPLICATE_REPOSITORY`, `PATH_NOT_FOUND`, `NOT_FOUND`,
`INVALID_INPUT`, `FORBIDDEN`, `GIT_UNAVAILABLE`), so an agent can react to the
kind of failure rather than parsing prose.

### Who wrote what

Comments from the UI are `Human`. Comments over MCP are `<tool> (AI)`. The
question that shapes the design is where `<tool>` comes from — and the answer is
**not** "the agent tells us".

Asking an agent to name itself does not survive contact with reality: the same
Claude Code install would introduce itself as *Claude*, *claude-code*, *Claude
Code* and *Claude Opus* across four sessions, and a thread with four names for
one participant is worse than a thread with none.

So the name is taken from the MCP handshake instead. Every client sends
`clientInfo: { name, version }` in `initialize`, before any tool runs, and the
SDK keeps it (`Server.getClientVersion()`). That value is chosen by the *tool*
rather than by the model driving it, which is exactly the property needed:

```
initialize { clientInfo: { name: "claude-code" } }   →   "Claude Code (AI)"
initialize { clientInfo: { name: "codex-cli"   } }   →   "Codex (AI)"
initialize { clientInfo: { name: "opencode"    } }   →   "opencode (AI)"
```

`mcp/identity.ts` maps the known clients to names their users would recognise.
An unknown client is not lumped in with the rest — it is title-cased and used as
is (`some-new-agent` → `Some New Agent`), which still identifies that tool
consistently across all of its own sessions. A client that sends no `clientInfo`
at all becomes plain `AI`, so the one guarantee the UI makes — a machine-written
comment is always marked as one — holds even there.

**Telling two sessions of the same tool apart.** stdio gives one server *process*
per client session, so the process is the session: an 8-character id is minted at
startup and stamped on everything that session writes. That keeps two concurrent
Claude Code sessions distinct in the database with no cooperation from either.
A session id is not a *name*, though, so an agent may also set a short label for
itself — `auth-refactor`, `perf-pass` — which is remembered for the rest of the
session and renders as `Claude Code · auth-refactor (AI)`. This is the one
self-reported piece, and it is fine that it is: it is a nickname for a session,
not a claim about identity, and the tool name underneath it is still the
handshake's. It can also be pinned per-project in the server config with
`GITWARREN_AGENT_LABEL`.

**Editing.** The person at the keyboard may edit or delete anything — it is their
app. An agent is held to its own tool's messages. That asymmetry is not security
(there is no attacker in this model); it is the difference between an agent
fixing its own typo and an agent quietly rewriting someone else's review.

### Comments on code that keeps moving

A review follows its refs rather than pinning a sha, so the diff a comment was
written against is not the diff the next visitor sees. GitHub avoids this by
pinning each comment to a commit; GitWarren cannot, because following the branch
is the point of the app.

Instead, each line comment stores the **text** of the line as well as its number,
and the anchor is re-derived on every read (`shared/comment-anchors.ts`). The
rule is to trust the text over the number — a line number is a position in a
document that keeps being rewritten:

| State | Meaning | Where it shows |
| --- | --- | --- |
| `anchored` | The stored line still holds the text it was commented on. | Inline, at that line. |
| `moved` | The text is now at a different line. | Inline, at its new line, badged *moved*. |
| `outdated` | The text is not in this diff at all. | Listed above the file, badged *outdated*. |

`outdated` covers both "the code was rewritten under it" and "the comment was
left on a line the diff never showed" — an agent commenting on an unchanged part
of a file, say. Both mean the same thing to a reader, so both are kept and shown
out of line rather than dropped. Where several identical lines match (a lone `}`),
the nearest to the original position wins; a near miss inside the right file
beats losing the comment.

The same function runs in both surfaces. The renderer anchors against the diff
already on screen — which matters, because the *include uncommitted* switch
produces a genuinely different diff with different line numbers — and
`list_review_comments` anchors against a diff it reads itself, so an agent and
the screen never disagree about where a comment sits.

### Comments on a block of lines

Press the `+` in the gutter and drag down it, or shift-click a second line, to
comment on several lines at once. Agents get the same thing by passing
`startLine` to `add_review_comment`.

A range is stored as `startLine` plus `line`, where **`line` is the last line**
— and that asymmetry is the design. Only one end carries an anchor text, and the
rest of the range follows it by keeping the span the same length. Re-finding
both ends independently would let a range quietly grow, shrink or invert when
one of them matched somewhere unhelpful, and a comment that claims to cover code
it was never about is worse than one sitting a line off. A range of one line is
normalised to no range at all, so nothing downstream has to compare the two
numbers to find out whether a comment is about a block.

The diff marks every line a range covers with a bar in the gutter, and the
thread itself renders under the last line — where the eye already is after
dragging down to it.

### Getting from the conversation back to the code

Clicking a thread's file header in *Conversation* opens *Files changed*
scrolled to that line, with the line marked for a couple of seconds. The target
goes in the hash (`#/reviews/3/files/src%2Fapp.ts/head/42`), so it is a location
like any other: it survives a reload and the back button works.

The line in the URL is the **resolved** one, not the stored one — the
conversation tab has already anchored the thread against the diff it is
displaying, so a comment that has moved still lands on the code it is about. A
thread whose line is gone from the diff falls back to scrolling to the file's
card, which is where such a thread is listed.

### Images in comments

Comment bodies and review descriptions are **markdown** — GitHub-flavoured, so
tables, task lists, strikethrough and autolinks all work. The composer has the
usual Write/Preview tabs and a formatting toolbar, and the preview renders
through the same component the posted comment does, so it cannot drift.

Two things are deliberately not rendered. **Raw HTML** is not, which is why
there is no sanitiser anywhere in this app — react-markdown does not render
embedded HTML unless asked, so there is nothing to misconfigure. And **remote
images** are not: an `https://` image renders as a link, and the renderer's CSP
has no remote `img-src`. Both exist because a comment here may have been written
by an agent that just read untrusted content out of the repository under review,
and it is stored and replayed into the window every time someone opens it.

Images that *are* rendered come from the app's own store:

```
  body        ![dropdown behind modal](gitwarren://attachment/abc….png)
                                       └──────────────┬──────────────┘
  disk        <dataDir>/attachments/ab/abc….png       │  opaque token
  renderer    <img src="gitwarren://…">  ─────────────┘  custom protocol
  agent       attachments[].path  →  /Users/…/attachments/ab/abc….png
```

**Humans** paste, drop or pick an image; it is copied in and the markdown is
inserted at the cursor. **Agents** write a file to disk and reference it as an
ordinary markdown image — the path is rewritten to a token when the comment is
saved. They cannot upload: base64 in a tool call means *emitting* over half a
million characters for a 400KB screenshot, so a path is the only workable
currency. In the other direction, every comment carries a resolved `attachments`
array whose `path` is a real file, which an agent reads with the tools it
already has. That is why there is no `get_attachment` tool — a path is strictly
more reliable than an MCP `ImageContent` block, whose delivery varies by client.

The bytes are copied rather than referenced because **a discussion has to
outlive the file it is about**: `/tmp` gets purged, `test-results/` is wiped at
the start of every Playwright run, and a pasted screenshot has no path at all.
It is the same reason `anchorSnapshot` exists. Files are content-addressed by
sha256, which makes ingest idempotent — necessary, since the GUI and the MCP
server are separate processes that can ingest the same image at once.

Two details are load-bearing and easy to get wrong. The rewrite **parses** the
markdown rather than pattern-matching it, so an agent's example image inside a
fenced code block is not silently ingested. And it **splices** the original
string by node offset rather than re-serialising the parsed tree, so a body
comes back byte-identical apart from its URLs — a round trip through mdast would
quietly renormalise an author's bullet markers and fenced code.

A path that does not resolve is left in the text as written and the comment
saves anyway, on the same principle the composer already applies to humans: the
comment is worth more than the link.

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
- **Comment threads have no unread state.** The tab shows how many are
  unresolved, not how many are new since you last looked, so a reply an agent
  left overnight is not distinguishable from one you have already read.
- **Comment anchors are matched on exact line text.** Reindenting a line or
  changing its whitespace moves it out of `anchored` even though the code is
  unchanged. A trimmed comparison would handle that, at the cost of matching
  lines that differ only in indentation — which in a diff is a real difference.
- **Agent names are only as consistent as the client's `clientInfo`.** A client
  that changes the name it sends between versions will appear as two
  participants, and there is no way to merge them after the fact.
- **Nothing is pushed to the UI.** An agent's comment appears when the window
  polls (every 15s) or regains focus, not the moment it is written.
- **Repo-relative images are not rendered.** `![](docs/arch.png)` in a comment
  stays as written rather than resolving against the repository — it needs a
  second protocol host and repository context threaded into the renderer. Such a
  URL is left alone rather than copied into the attachment store, since a
  committed file is git's and reading it live is the rule everywhere else here.
- **Remote images are shown as links, never inlined**, and raw HTML in markdown
  is not rendered at all. Both are deliberate; see
  [Images in comments](#images-in-comments).
- **Fenced code in comments is not syntax highlighted**, and neither Mermaid nor
  any other diagram syntax is rendered.
- **SVG cannot be attached.** It is a script-bearing document rather than a
  raster image, so only PNG, JPEG, GIF and WebP are accepted, up to 10 MB.
- **Orphaned attachments are collected at startup, not immediately.** An image
  pasted into a composer that is then abandoned sits on disk until the next
  launch of the GUI. The sweep runs only there, never in the MCP server, which
  may be one of several concurrent processes.
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
