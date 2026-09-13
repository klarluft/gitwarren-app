# gitwarren

Local-only code review for your git repositories. Your code, your diffs and
your comments stay on your machine — there is no server, no account and nothing
to sign in to.

This package is the command line. There is also a desktop app; see
[gitwarren-app](https://github.com/klarluft/gitwarren-app).

```
npx gitwarren serve --open
```

That serves the review UI on `127.0.0.1:41427`, prints a URL carrying a token
minted for that launch, and opens it. Add a repository, pick two refs, and
review the diff. Ctrl-C stops it. Needs Node 22 or newer; on a machine without
Node, the Homebrew formula and the install script in the
[app repository](https://github.com/klarluft/gitwarren-app#the-gitwarren-command-line)
bring their own.

## Commands

**Run it now**

| | |
| --- | --- |
| `gitwarren serve [--open]` | run GitWarren in this terminal and print its URL; `--open` opens it too |
| `gitwarren open [link]` | open the running GitWarren in your browser, carrying the token |

**Keep it running**

| | |
| --- | --- |
| `gitwarren service install` | run GitWarren in the background, from now and at every login |
| `gitwarren service uninstall` | stop that, and remove the login item |
| `gitwarren service status` | what is running, and where the data is |

**Let a coding agent in**

| | |
| --- | --- |
| `gitwarren agent-setup` | print the one sentence to give an agent so it can reach GitWarren over MCP |

`gitwarren serve --stdio` answers GitWarren's protocol on stdin and stdout; it
is what a GitWarren on another machine spawns, and nothing a person needs to
type.

`gitwarren open` takes a `gitwarren://` deep link or the `http://127.0.0.1`
URL an agent hands out, and lands on that review rather than the home screen.

## Letting an agent in

Every install carries GitWarren's MCP server. What an agent needs is one
stable command to start it with, and that is `~/.gitwarren/bin/gitwarren-mcp` —
the same path on every machine, written by `gitwarren serve`, `gitwarren
agent-setup` and `gitwarren service install` alike, and kept pointing at
whichever install ran last. `gitwarren agent-setup` prints the sentence to
paste into the agent.

The MCP server reads the same SQLite file the browser view does, so an agent
can open and comment on reviews whether or not GitWarren is being served. What
serving adds is that the links an agent hands you have something to open.

## Where your data is

One SQLite database in the usual place for your platform —
`~/Library/Application Support/GitWarren` on macOS, `~/.config/GitWarren` on
Linux, `%APPDATA%\GitWarren` on Windows. `gitwarren service status` prints the
path.

The web view binds `127.0.0.1` only, checks `Host` and `Origin` on every
request and on the WebSocket upgrade, and requires a token minted per launch
which it exchanges for a `SameSite=Strict` cookie. A page on another origin
cannot reach it.

## Licence

GPL-3.0-or-later. Copyright © 2026 Klarluft B.V.
