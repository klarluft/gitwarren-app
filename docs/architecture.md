# Architecture

How GitWarren is put together, and what it keeps on disk. If you are changing
code, read [Development](development.md) alongside this.

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
> in the [packaging setup](releasing.md) exists to serve it.

> **Base UI, not Radix.** The components in `src/renderer/src/components/ui`
> follow shadcn/ui conventions (CVA variants, `cn()` merging, the same prop
> shapes) but are built on Base UI primitives. They were written for this
> project rather than pulled from the shadcn registry, because the registry's
> default output targets Radix.

---

## The shared service layer

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
[Who wrote what](agents.md#who-wrote-what).

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
comments](agents.md#images-in-comments). Note what it does *not* have: a foreign key to
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
