# gitwarren

Local-only code review for your git repositories. Your code, your diffs and
your comments stay on your machine — there is no server, no account and nothing
to sign in to.

This package is the command line. There is also a desktop app; see
[gitwarren-app](https://github.com/klarluft/gitwarren-app).

```
npx gitwarren serve
```

That serves the review UI on `127.0.0.1:41427` and prints a URL carrying a
token minted for that launch. Open it, add a repository, pick two refs, and
review the diff.

## Commands

| | |
| --- | --- |
| `gitwarren serve` | serve the web view on loopback and print its URL |
| `gitwarren serve --stdio` | answer GitWarren's protocol on stdin/stdout |
| `gitwarren open [link]` | open this machine's GitWarren in a browser, carrying the token |
| `gitwarren service install` | write the agent launcher, and start at login |
| `gitwarren service uninstall` | remove the login item |
| `gitwarren service status` | what is registered, and what is running |

`gitwarren open` takes a `gitwarren://` deep link or the `http://127.0.0.1`
URL an agent hands out, and lands on that review rather than the home screen.

## Letting an agent in

`gitwarren service install` writes `~/.gitwarren/bin/gitwarren-mcp`, which is a
GitWarren MCP server your coding agent can start. Point the agent at that one
path — it is the same on every machine, and GitWarren keeps it pointing at
whichever install ran last.

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
