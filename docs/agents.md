# Agent access (MCP)

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

Every result above that carries a review or a comment also carries a `guiUrl`
that opens it in the app — see
[Linking the user back into the app](#linking-the-user-back-into-the-app).

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

## Linking the user back into the app

Every payload that carries a review or a comment also carries a **`guiUrl`** —
an address that opens the app on exactly that review, and on the commented line
where there is one. It is there so an agent can end its turn with a link instead
of "I've left three comments on review 4, have a look".

It is **never null**. It used to be, whenever the app was not running, because
the port it named was one the OS had handed that particular launch. But a
`guiUrl` outlives the call that made it — pasted into a chat, left in a commit
message, read on Thursday — so deciding at mint time that the user has nothing
to open it with is a guess about a moment that has not happened yet, and it was
wrong in the ordinary case: the user closes the window, the agent works for
twenty minutes, the user opens it again. A dead link costs one refused
connection in a browser. A null cost an agent telling the user there was
nothing to click. The tool descriptions now say what a refused connection means
instead.

The URL names the instance that minted it, in the fragment:

```
http://127.0.0.1:41427/#h=<instance-id>/review/4/conversation
```

which the page turns into `gitwarren://<instance-id>/review/4/conversation`.
That is what lets a link resolve on whichever GitWarren the user clicked from —
the app can tell its own review 4 from another machine's. If the install it
names is a host this one knows, the link opens *that* machine's review — the
host segment travels with it, so this install's review 4 is never reachable by
a link that meant another machine's.

If the install it names is one this GitWarren has never been told about, the
screen says so and offers to fix it: it names the machine the link came from,
looks for it on your tailnet, and — when it is there — adds it and opens the
review you clicked. When it is somewhere only SSH or WSL reaches, the Hosts
screen remembers what you were opening and offers the way back once the machine
is in the list.

When the page at that address is served by a daemon rather than by the app —
`gitwarren serve`, or the plugin's `gitwarren mcp --serve` — the link also
carries that launch's token:

```
http://127.0.0.1:41427/?token=<token>#h=<instance-id>/review/4/conversation
```

The web view is behind the token (see
[The token, and why nothing is copied](cli.md#the-token-and-why-nothing-is-copied)),
and a link without it lands on a page saying so. A person who typed `serve` has
the token on their terminal; the person an agent's plugin is serving has it in
a log they will never read. So the MCP server reads it from the same 0600 file
`gitwarren open` does and puts it in the link. The handler exchanges it for the
session cookie and takes it back out of the address bar, and the route survives
in the fragment. The app's own link page needs no token, so links minted while
the app owns the port are unchanged. A link from before a daemon restart
carries a token that no longer exists, and the newest link is the one that
works.

The link is a chain of three hops, and each one is load-bearing:

```
http://127.0.0.1:52413/#review/4/files/src%2Fapp.ts/head/42   ← what the agent prints
        │  terminal linkifies it, and clicking opens the browser
        ▼
a one-page server inside the GUI, serving an "Open GitWarren" button
        │  the user clicks it
        ▼
gitwarren://review/4/files/src%2Fapp.ts/head/42                ← OS protocol handler
```

**Why not hand out the `gitwarren://` URL directly?** Terminals linkify `http`
and almost none of them linkify a custom scheme, so the agent would be printing
text the user has to copy by hand.

**Why a button rather than a redirect?** Two reasons. Browsers refuse scripted
navigation to a custom scheme — but more importantly, the click is what makes
the window actually come forward. Windows grants foreground rights only to the
process that *is* foreground or that launched the one asking, so an Electron app
woken by a background HTTP request cannot raise itself: `win.focus()` flashes the
taskbar and stops there ([electron#2867](https://github.com/electron/electron/issues/2867)).
GNOME's Mutter demotes self-requested activation in much the same way. A protocol
launch from the browser the user just clicked in inherits the right on all three
platforms. So the third hop is not an inefficiency to optimise away — it is the
only hop that works.

A consequence worth keeping: **the loopback server never takes an action.** It
answers every request with the same static page and has no other endpoint. That
is a property to defend rather than an accident of it being small — anything on
loopback is reachable by every process on the machine and by whatever web page
the user has open next, so an endpoint here that mutated state, read a
repository or drove IPC would be a capability handed out to the whole world. It
validates the `Host` header, and the route it is linking to never even reaches
it: that rides in the URL fragment, which browsers do not send.

The port is **41427**, fixed, on `127.0.0.1` and never `0.0.0.0`. It used to be
whatever the OS handed out (`listen(0)`), written to a runtime file for the MCP
server to read — which meant a link could only be minted while the app was
running, and only for this machine. Neither survives contact with a second
machine: a link written on one is read on another, and a link left in a comment
on Tuesday is clicked on Thursday. So the port is a constant every install
agrees on (`src/shared/link-port.ts`, chosen in spike S6 for being outside every
default ephemeral range, absent from `/etc/services`, and not on Chromium's
restricted-port list), and `guiUrl` no longer depends on anything being up.

If something else holds 41427, the app starts anyway and says which port and
why; links are still handed out, because they name the same port on every
machine and must not depend on this one's luck. The *Agent access* panel shows
the warning.

`daemon-runtime.json` in the data directory still records who owns this machine
— instance id, pid, link port, and whether the owner is the GUI or a daemon —
but nothing needs it to build a link any more. Readers treat it as a hint and
never as a fact: a crash leaves it behind, so the pid is checked with
`process.kill(pid, 0)` before it is believed, and it is re-read on every call
rather than cached.

The incoming URL is **parsed to a `Route` before anything acts on it**, never
forwarded as a string, using the same grammar the hash router uses
(`shared/routes.ts`). Comment bodies are agent-writable, so this parser will
one day receive `gitwarren://review/../../../../etc/passwd`; anything it does not
recognise degrades to the home screen. It is the same whitelist-not-filter
reasoning as `main/attachment-protocol.ts`. Note that `gitwarren:` is registered
twice over, for two unrelated mechanisms — an OS protocol handler and Chromium's
`protocol.handle` for attachment images. They coexist because they answer to
different hosts: `review` and `attachment`, each ignoring the other's.

## Who wrote what

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

## Comments on code that keeps moving

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
already on screen — which matters, because each view of the changes is a
genuinely different diff with different line numbers — and
`list_review_comments` anchors against a diff it reads itself, so an agent and
the screen never disagree about where a comment sits.

## Comments on a block of lines

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

## Getting from the conversation back to the code

Clicking a thread's file header in *Conversation* opens *Files changed*
scrolled to that line, with the line marked for a couple of seconds. The target
goes in the hash (`#/reviews/3/files/src%2Fapp.ts/head/42`), so it is a location
like any other: it survives a reload and the back button works.

The line in the URL is the **resolved** one, not the stored one — the
conversation tab has already anchored the thread against the diff it is
displaying, so a comment that has moved still lands on the code it is about. A
thread whose line is gone from the diff falls back to scrolling to the file's
card, which is where such a thread is listed.

## Images in comments

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

## Installing it as a plugin

The repository root is also a plugin, in three formats at once, so one address
installs GitWarren into whichever agent a person uses:

| Agent | How |
| --- | --- |
| Claude Code | `/plugin marketplace add klarluft/gitwarren-app`, then `/plugin install gitwarren@gitwarren` |
| Codex, Cursor, VS Code, Kiro | The same repository, from each tool's plugin screen, through the shared [Agent Plugins](https://agent-plugins.org) manifest |
| Gemini CLI | `gemini extensions install https://github.com/klarluft/gitwarren-app` |
| Any agent, the note alone | `npx skills add klarluft/gitwarren-app` |

What the plugin carries, beyond the server: `skills/gitwarren/SKILL.md`, the
note that teaches the agent one habit — open a review when a task that changed
code is done and hand over the link, read the review's comments before the next
task, reply in the thread and resolve what was fixed — and the rules around it;
`commands/review.md`, a `/gitwarren:review` command that opens the review on
demand;
and `agents/gitwarren-reviewer.md`, a reviewer that reads a change with git and
leaves its findings as line comments in the review, attributed as
machine-written, next to yours.

**Which GitWarren answers.** The plugin carries no GitWarren of its own.
Claude Code's entry runs `packaging/plugin/start.mjs`, which asks whether a
GitWarren is *listening* on the machine. If one is, it runs the launcher that
GitWarren wrote, so links open there. If not, it runs `npx gitwarren mcp
--serve`: the published package, with the review page switched on, so a link
the agent hands out opens even on a machine with nothing else installed. The
other formats name that command directly. "Listening" rather than "installed",
because an installed-but-closed app would leave the agent handing out dead
links; the starter's header has the reasoning.

**The Node on the PATH has to be 22.14 or newer.** `better-sqlite3` ships a
prebuilt binary built against Node-API 10, and under an older Node - any 22.x
before 22.14, which has Node-API 9 - it loads and then segfaults on the first
database read, which an agent reports as "server failed to connect" and
nothing more. Claude Code runs the plugin with the first `node` on the PATH,
so a shell whose default Node is old fails even on a machine that also has a
new one. The starter checks the Node-API version before spawning anything and
says which Node it found and which it needs; `gitwarren mcp` checks the same
and then opens the addon once in a child process before loading the server, so
any other crash is a sentence rather than a silence. The npm package's
`engines` says the same minimum.

`gitwarren mcp` is the server by name, and `--serve` is the page beside it: the
same `--listen` a person gets from `gitwarren serve`, loopback and token-gated,
for exactly as long as the agent keeps the server running. It defers to a
running app or `serve` the way `serve` does, and it exits when the agent's pipe
closes, so no page outlives the session that started it.

The server is also listed in the [MCP registry](https://registry.modelcontextprotocol.io)
as `io.github.klarluft/gitwarren`, from `server.json` at the repository root,
published by the release workflow after the npm package. The directories that
copy from the registry list it from there.

## Pointing an agent at it by hand

Without the plugin, or for a harness that only speaks MCP:
**GitWarren shows you the exact configuration for your install** — open the
*Agent access* page (the card on the home screen, or `g a`) and copy the prompt
at the top of it. The browser shell has the same page, and on a machine with no
screen `gitwarren agent-setup` prints the same words. The paths depend on where
GitWarren was installed, so prefer one of those over the notes below.

## One command, everywhere

GitWarren maintains a launcher at a path that is the same on every machine:

| | |
| --- | --- |
| macOS, Linux | `~/.gitwarren/bin/gitwarren-mcp` |
| Windows | `%USERPROFILE%\\.gitwarren\\bin\\gitwarren-mcp.cmd` |

It takes no arguments and needs no environment, and the app rewrites it
whenever the install moves — after an update, after dragging the app to a
different folder, after switching between a packaged build and a source
checkout. So an agent config that names it keeps working, and the *Agent
access* page leads with a sentence you paste into whatever agent you use
rather than with JSON you paste into a file:

> Set up the GitWarren MCP server for yourself. It speaks MCP over stdio and is
> started with the command `~/.gitwarren/bin/gitwarren-mcp` (no arguments, no
> environment). Register it under the name "gitwarren" in your own MCP
> configuration, then call its `agent_identity` tool to confirm it works.

Agents know their own configuration format better than a page can. What they
need from us is a stable command.

To configure it by hand instead, that command is all an entry needs. Three
formats cover every harness we know of, and the page generates all three from
the launcher path (`gitwarren agent-setup --manual` prints them too):

```json
{
  "mcpServers": {
    "gitwarren": { "command": "/Users/you/.gitwarren/bin/gitwarren-mcp" }
  }
}
```

for Claude Code, Cursor, Windsurf and Gemini CLI; the same object called
`servers` for VS Code; and TOML for Codex:

```toml
[mcp_servers.gitwarren]
command = "/Users/you/.gitwarren/bin/gitwarren-mcp"
```

On Windows, double every backslash in that TOML string — `\U` is a real escape,
so a path pasted raw parses into a different one rather than into an error.

## What the launcher wraps

Two lines around the app's own Electron binary in Node mode. That is
deliberate: `better-sqlite3` is a native addon that must be loaded by a runtime
whose ABI it matches, and it has to resolve out of the app's unpacked
`node_modules`. Using the bundled binary satisfies both, and means **no Node
installation is required**.

An AppImage is the interesting case, and the reason this path exists at all: it
re-mounts itself at a new `/tmp/.mount_*` directory on every launch, so nothing
inside it is worth writing down. Its one stable path is the `.AppImage` file,
which AppRun exports as `APPIMAGE` and whose mount point it exports as
`APPDIR`, so the launcher names the former and finds the server through the
latter at run time. Nothing needs extracting.

From a source checkout, `npm run mcp:dev` runs the same server against your dev
database.

The app does not need to be running for the MCP server to work — both open the
same database independently, and an agent gets a working `guiUrl` either way.

## In a container

There is a `Dockerfile` at the root, and it is worth saying plainly what it is
for, because it is not how anybody should run this. The whole claim of the
product is that the review sits next to the working copy on your machine, and a
container is by construction not your machine: what you get in one is a server
that can only see what you remembered to mount, writing a database that is gone
at the end of the run unless you mounted that too.

It exists because the directories want one. Glama builds every server it lists
from a Dockerfile — the maintainer's, or one its own tooling guesses — runs the
result in a microVM, watches what it does at the syscall and network layers,
and withholds a server from search and recommendations when the build is not
reproducible. Writing the file ourselves is the difference between being
scanned as we actually ship and being scanned as somebody's inference of us.
The second reason is smaller and real: it is the shortest way for a stranger to
watch this server run without installing anything of ours.

```bash
docker build -t gitwarren .

docker run --rm -i \
  -v "$PWD:/workspace:ro" \
  -v gitwarren-data:/data \
  gitwarren
```

The image installs the published npm package at a pinned version — the same
artifact `npx gitwarren mcp` fetches, so what a scanner sees is what a user
runs. `scripts/sync-plugin-versions.mjs` keeps the pin level with package.json
the way it does for the plugin and registry manifests, and CI fails on a pin
that has drifted.

Three things about it are deliberate, and all three are the answer to the
question a security scan is asking:

- **It writes to exactly one directory.** `GITWARREN_DATA_DIR` is set to
  `/data` rather than left to the platform default, so the SQLite file and the
  instance id have a declared home instead of landing in a container layer. A
  `docker diff` after a real session — add a repository, open a review, leave a
  comment — lists `/data/gitwarren.db` and `/data/instance-id`, and nothing
  else anywhere in the filesystem.
- **It asks the network for nothing.** That same flow runs unchanged under
  `--network none`. The server speaks stdio, reads the working tree, and writes
  SQLite; the only socket it ever opens is the best-effort poke to a GUI on
  loopback, which in a container finds no owner and carries on. `--serve` is
  left out of the default command for the same reason — a listener nobody asked
  for is surface nobody wanted. Add it, and publish 41427, if you want the
  review page.
- **It runs as nobody in particular.** The compiler lives in a build stage that
  is thrown away, so the shipped image has no toolchain, no headers and no
  package index; the server runs as the base image's `node` user, uid 1000, and
  root owns nothing it touches.

The one concession is `safe.directory`. A bind-mounted repository belongs to a
uid from the host, and the version control tooling refuses to read a repository
it believes is someone else's, so the image waives that check rather than
asking whoever runs it to. The check defends against a repository's own config
running commands as you; inside a container holding one server and one mount,
where no shell is ever involved, that is a trade worth making — but it is a
trade, and it is made here and nowhere else.
