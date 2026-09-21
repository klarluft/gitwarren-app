# Development

Getting the app running from source, where everything lives, and how to change
the database schema. For the contribution workflow — CLA, pull requests, what CI
runs — see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Development setup

Requirements: the Node in [`.nvmrc`](../.nvmrc) (**24.20.0**, which ships npm
11.19) and **git on your PATH** (GitWarren shells out to your own git rather
than bundling one). With `nvm` or `fnm` the version is picked up automatically
on `cd`; `engines` in `package.json` sets the floor at Node 24.20 / npm 11.10
and `.npmrc` sets `engine-strict`, so an older toolchain fails loudly instead
of quietly writing a lockfile CI cannot install.

```bash
npm install          # also rebuilds native deps for Electron
npm run dev          # start the app with hot reload
```

Other scripts:

| Command | Does |
| --- | --- |
| `npm run dev` | Run the app in development with HMR |
| `npm run build` | Typecheck, then build main / preload / renderer / MCP / daemon |
| `npm test` | Integration tests against a real SQLite file and real `git` |
| `npm run typecheck` | `tsc --noEmit` for both the Node and web projects |
| `npm run lint` | ESLint (type-aware) |
| `npm run db:generate` | Regenerate migrations after editing the Drizzle schema |
| `npm run mcp:dev` | Run the MCP server from source against your dev database |
| `npm run serve:dev` | Run the headless daemon from source, protocol on stdin/stdout |
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
│   ├── routes.ts        the hash grammar, as data — parsed by three processes
│   ├── deep-link.ts     gitwarren:// URL ⇄ Route, the hostile-input boundary
│   ├── link-port.ts     41427: the one port every install agrees on
│   ├── rpc.ts           the message protocol — requests, responses, events
│   └── api.ts           IPC channel names and the bridge's type
│
├── core/              The shared service layer. Never imports electron.
│   ├── paths.ts         per-platform data directory (+ env override)
│   ├── instance.ts      this install's id, minted once into the data directory
│   ├── daemon-runtime.ts  who owns this machine right now, for other processes
│   ├── rpc/             the dispatcher, and one carrier per way of asking
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
│   ├── deep-link.ts     receives gitwarren:// URLs from the OS
│   ├── link-server.ts   the loopback page holding the "Open GitWarren" button
│   ├── updater.ts       electron-updater wiring
│   ├── editors.ts       finds the user's code editor and opens a file in it
│   ├── tray.ts          the menu bar / notification area item: Open, Quit
│   ├── login-item.ts    start at login, per platform; opt-in
│   ├── start-hidden.ts  whether this launch should come up without a window
│   └── mcp-launch.ts    maintains ~/.gitwarren/bin/gitwarren-mcp
│
├── preload/           The only bridge into the renderer
├── daemon/            The core with a pipe instead of a window
│   ├── serve.ts         argv, signals, exit code → out/daemon/serve.cjs
│   └── daemon.ts        opens the database, picks a carrier
├── mcp/               stdio MCP server
│   ├── server.ts        tool definitions
│   ├── gui-link.ts      the `guiUrl` on every review and comment payload —
│   │                    always a link, whether or not the app is running
│   └── identity.ts      naming an agent from its MCP handshake
└── renderer/          React app (no Node access)
    └── src/
        ├── assets/          logo.png, inlined as a data: URI by the CSP
        ├── components/      markdown.tsx + ui/ (shadcn-style, on Base UI)
        ├── features/        repositories/, reviews/, comments/, agent/,
        │                     settings/
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
| `src/renderer/src/assets/logo.png` | 128px, no padding | The app header, and the image at the top of the README. |

The repository root is also the plugin, so the manifests that install GitWarren
into an agent sit beside the source rather than under it. Three plugin formats
and a registry entry, because no two families of tool read the same manifest:

| File | Read by |
| --- | --- |
| `.claude-plugin/marketplace.json` | Claude Code, as the marketplace `/plugin marketplace add klarluft/gitwarren-app` adds — this repository, listing exactly one plugin: itself. |
| `.claude-plugin/plugin.json` | Claude Code, as that plugin's manifest. |
| `.mcp.json` | Claude Code, for the server the plugin carries. Names `packaging/plugin/start.mjs` through `${CLAUDE_PLUGIN_ROOT}`. |
| `plugin.json` | Codex, Cursor, VS Code and Kiro, through the shared [Agent Plugins](https://agent-plugins.org) manifest. |
| `mcp.json` | The server entry beside it, for those same tools. Names `npx -y gitwarren mcp --serve` — the published package rather than a path, since they install from the repository without leaving a checkout behind to point at. |
| `gemini-extension.json` | Gemini CLI, for `gemini extensions install`. Carries its own copy of that same command. |
| `server.json` | The [MCP registry](https://registry.modelcontextprotocol.io), as `io.github.klarluft/gitwarren`. Published by the release workflow, after the npm package. |

What those manifests point at is the plugin itself — three files a person
notices, and one that does the starting:

| Path | What |
| --- | --- |
| `skills/gitwarren/SKILL.md` | The note that teaches the agent one habit — open a review when a task that changed code is done, hand over the link, read the comments before the next task. Also what `npx skills add klarluft/gitwarren-app` installs on its own. |
| `commands/gitwarren.md` | `/gitwarren`, which opens the review on demand. |
| `agents/gitwarren-reviewer.md` | The reviewer that reads a change with git and leaves its findings as line comments, attributed as machine-written. |
| `packaging/plugin/start.mjs` | The starter behind `.mcp.json`: the launcher of a GitWarren that is *listening* on this machine if there is one, `npx gitwarren mcp --serve` if there is not. Its header has the reasoning. |

Each of those manifests insists on carrying its own `version`, and none can
point at `package.json` instead, so `scripts/sync-plugin-versions.mjs` copies
the number into all five. It runs from the `version` script on `npm version`,
and `--check` is the CI gate for the hand-edited case.

[Installing it as a plugin](agents.md#installing-it-as-a-plugin) has the install lines
and the rest of the reasoning.

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
