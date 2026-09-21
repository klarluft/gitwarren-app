# The `gitwarren` command line

The same GitWarren, with a browser tab for a shell. One binary, a handful of
subcommands, and no Electron anywhere in it.

```bash
# Run it now
gitwarren serve [--open]        # run GitWarren in this terminal and print its URL; Ctrl-C stops it
gitwarren open [link]           # open the running GitWarren in your browser

# Keep it running
gitwarren service install       # run GitWarren in the background, from now and at every login
gitwarren service uninstall     # stop that, and remove the login item
gitwarren service status        # what is running, and where the data is

# Let a coding agent in
gitwarren agent-setup           # print the one sentence to give an agent so it can reach this GitWarren

# Keep it current, or remove it
gitwarren update                # move to the newest release (--check only says whether there is one)
gitwarren doctor                # check every path GitWarren asks another program to run; --fix repoints stale ones
gitwarren uninstall             # remove GitWarren from this machine; reviews stay unless --data says otherwise

gitwarren serve --stdio         # answer GitWarren's protocol on stdin/stdout (what another machine spawns)
```

It exists for two audiences that the app cannot serve. Someone who will not
install an Electron app gets the identical renderer in a tab — every line is
shared, the shell is not. And a machine with no screen at all — a VPS, a WSL
distro, a box an agent works on — gets the daemon and the MCP server, which is
what [Your other machines](remote-hosts.md) is built on.

## Which command you want

Three things a person wants from it, and one command for each. They are
independent: none of them requires another to have been run first.

- **Use it now.** `gitwarren serve` runs GitWarren in the terminal until Ctrl-C,
  and prints the URL. `--open` opens it as well; `gitwarren open` in another
  terminal does the same later.
- **Have it always there.** `gitwarren service install` registers a login item
  — a LaunchAgent on macOS, a `systemd --user` unit on Linux, an at-logon task
  on Windows — and starts it now, so `gitwarren open` and the links an agent
  hands you always have something to open. `gitwarren service uninstall` undoes
  it.
- **Let an agent in.** `gitwarren agent-setup` prints the sentence to paste into
  Claude Code, Codex or any other MCP client. The MCP server is part of every
  install and reads the same SQLite file the browser view does, so an agent can
  open and comment on reviews whether or not GitWarren is being served — what
  serving adds is that the `guiUrl` an agent hands back opens in a browser.

All three write the same two files, `~/.gitwarren/bin/gitwarren` and
`~/.gitwarren/bin/gitwarren-mcp`, the first time they run; see
[`service install`](#service-install) for what they are.

## Four ways to install it

| | |
| --- | --- |
| `brew install klarluft/tap/gitwarren-cli` | Pours the self-contained tarball. Brings its own Node, so nothing on the machine can upgrade out from under the native addon. macOS and Linux. |
| `curl -fsSL https://gitwarren.com/install.sh \| sh` | The same tarball, without Homebrew — for a Linux box or a Mac with nothing on it. Unpacks into `~/.gitwarren/daemon/<version>/` and writes `~/.gitwarren/bin/gitwarren`, which is the layout the app itself produces when it installs onto a host over SSH, so either can upgrade what the other installed. Add `~/.gitwarren/bin` to `PATH`. `packaging/install.sh` is the script; `GITWARREN_VERSION` pins a release. |
| `npx gitwarren` | Uses the Node you already have (22.14 or newer; the SQLite prebuild needs Node-API 10); `better-sqlite3` arrives as an ordinary dependency. The Windows answer, and about 700 KB. |
| The release tarball | `gitwarren-daemon-<v>-<target>.tar.gz`, unpacked anywhere and run as `bin/gitwarren`. What the two rows above and the SSH installer all use. |

The formula is `gitwarren-cli` and the cask stays `gitwarren`. The tokens differ
so `brew install klarluft/tap/gitwarren` keeps meaning the app; the *binary* is
called `gitwarren` in all four.

## Updating, and removing it again

```bash
gitwarren update            # move to the newest release
gitwarren update --check    # only say what is installed and what is newest
gitwarren doctor            # is every path GitWarren hands out still pointing at something?
gitwarren uninstall         # remove it; add --data to take the reviews too
```

**One of the four installs is ours to replace, and `update` says so about the
other three.** An install under `~/.gitwarren/daemon/<version>/` — what
`install.sh` writes, and what the app installs onto another machine over SSH —
is versioned, has a stable launcher in front of it and no package manager with
an opinion about it, so `gitwarren update` does the whole thing: downloads the
release, checks it against the sha256 the release published in its own Homebrew
formula, unpacks beside the destination and renames into place, has the *new*
binary write the launchers (which is also the proof that it runs here),
restarts the background service if one is running, and deletes the version it
replaced. A Homebrew, npm or npx copy belongs to its package manager; `update`
names `brew upgrade gitwarren-cli` rather than writing over a Cellar, and
`--check` still tells that user a new release exists. See `src/cli/layout.ts`,
which is the file that decides which case this is.

Two things `update` does that re-running `install.sh` does not, and did not:
the background daemon that is *already running* is restarted, rather than
serving the old code until the next login; and the version it replaced is
removed, rather than left in `~/.gitwarren/daemon` forever at ~45 MB a time.

**`uninstall` removes only what it can attribute to this install.** The login
item, the launchers in `~/.gitwarren/bin` that name *this* install, and
`~/.gitwarren/daemon` when GitWarren put it there. It prints the plan and asks
before doing any of it — `--yes` to skip the question, and `--yes` is required
when nothing is attached to the terminal. Reviews are kept unless `--data` is
given. A launcher belonging to another GitWarren — commonly the desktop app,
which writes `gitwarren-mcp` too — is named and left alone, because removing it
would take agent access away from an install the user never touched.
Afterwards it lists the agent configs that may still name the launcher, which
is the one part of this no command can do for you.

**`doctor` is for the failure with no symptom on this machine.** A launcher
whose target is gone — after `brew uninstall`, after an AppImage is deleted,
after a checkout is rebuilt elsewhere — still sits there, and the only thing
anyone sees is their agent reporting *MCP server failed to connect*, in another
product, with nothing naming the cause. `gitwarren doctor` reads every path
GitWarren asks another program to run, marks the broken ones with `!` and exits
non-zero so a script can be what notices; `--fix` rewrites a stale launcher to
name this install. It never deletes: a file at a launcher path that GitWarren
did not write is reported and left where it is.

`gitwarren service uninstall` remains the smaller command — it stops the
background GitWarren and removes the login item, and leaves everything else. To
remove a Homebrew install the command is still `brew uninstall gitwarren-cli`;
run `gitwarren uninstall` first and it will take the launchers and the login
item with it, which `brew` does not know about.

## The token, and why nothing is copied

`gitwarren serve` binds `127.0.0.1` only and mints a token for that launch,
which it writes to `web-token` in the data directory at mode 0600 and prints in
the URL. `gitwarren open` reads that file and hands the whole URL to the
browser, which swaps it for a `SameSite=Strict` cookie on the first request. A
token is never copied by a person, never persisted across a launch, and
revoking it is quitting the process. See `src/core/web/token.ts`.

`gitwarren open` also takes a link — either a `gitwarren://` deep link or the
`http://127.0.0.1:41427/#h=…` URL an agent hands out — and lands on that review
rather than the home screen. The argument is parsed to a route and written back
out from that, so nothing typed on a command line is pasted into a URL that is
then handed to the operating system.

## `service install`

Two things, and only the second is about logging in:

1. **The launchers.** `~/.gitwarren/bin/gitwarren` and `~/.gitwarren/bin/gitwarren-mcp`,
   at the paths the rest of GitWarren already names — the Agent Access page
   prints the second as a command to paste, and the app spawns the first over ssh as
   `~/.gitwarren/bin/gitwarren serve --stdio`. Rerunning after an update points
   them at the install that ran last. `gitwarren serve` and `gitwarren
   agent-setup` write the same two files when they are missing, the way the app
   writes the MCP one on every launch, so nobody has to ask for a login item to
   get an agent working.
2. **The login item.** A LaunchAgent on macOS, a `systemd --user` unit on Linux,
   an at-logon Scheduled Task on Windows — each running `gitwarren serve
   --listen`, and each started right away as well as at the next login.
   `--no-login-item` writes the launchers and stops, which is what a headless
   host wants and what the SSH installer and `install.sh` ask for.

Nothing restarts a dead daemon, deliberately. `serve --listen` has a refusal it
is *meant* to exit on — a data directory has one owner, so it stands aside when
the app is running — and under launchd's `KeepAlive` or systemd's `Restart=`
that refusal becomes a process respawning every ten seconds for as long as
GitWarren is open. See `src/cli/units.ts`.

The launcher scripts name absolute paths for the migrations folder and the web
build rather than inheriting them. Both have a fallback relative to the working
directory, and a login item does not have one — launchd starts a job in `/`.
That is resolved once, at install time, while the answer is still knowable; see
`src/cli/install.ts`.
