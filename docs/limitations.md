# Known limitations

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
- **Live updates need a machine that is listening.** An agent's comment appears
  the moment it is written when GitWarren is running on the machine that owns
  the review — locally, or on a host reached over the tailnet. A host reached
  over SSH or `wsl.exe` has no process of its own to push from, so there the
  window still finds out on its next poll (every 15s) or when it regains focus.
  The poll is the floor everywhere: a lost update costs seconds, never
  correctness.
- **A host is only greyed if something has asked it something recently.** The
  connection pool hangs up after ten idle minutes, so a machine that goes away
  having been untouched for longer is noticed the next time you look at it
  rather than the moment it goes. Keeping a socket open to every host would mean
  connecting to every machine you own, which is the thing the pool exists to
  avoid.
- **A link from an unknown machine can only be resolved for you on a tailnet.**
  When a link names a GitWarren you have not added, the screen offers to find
  and add that machine — but finding it is a tailnet probe, so a machine you
  reach over SSH or `wsl.exe` cannot be offered that way. The screen names the
  instance id and sends you to the Hosts screen, which remembers what you were
  opening and offers the way back once the machine is in the list.
- **On Linux, `tailscale serve` needs to be allowed to run.** It refuses without
  root unless `sudo tailscale set --operator=$USER` has been run once; GitWarren
  reports what Tailscale said rather than silently failing to turn the switch on.
  macOS and Windows both apply it as the ordinary user, so this is a Linux-only
  step.
  HTTPS is a tailnet-wide setting: with it off, your machines are reachable over
  plain HTTP inside the tailnet, which WireGuard is encrypting either way.
- **Repo-relative images are not rendered.** `![](docs/arch.png)` in a comment
  stays as written rather than resolving against the repository — it needs a
  second protocol host and repository context threaded into the renderer. Such a
  URL is left alone rather than copied into the attachment store, since a
  committed file is git's and reading it live is the rule everywhere else here.
- **Remote images are shown as links, never inlined**, and raw HTML in markdown
  is not rendered at all. Both are deliberate; see
  [Images in comments](agents.md#images-in-comments).
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
- **macOS auto-update requires signing** (see
  [Code signing and notarization](releasing.md#code-signing-and-notarization)).
  Unsigned builds install and run, but will not self-update.
- **The renderer bundle is ~1 MB** unminified-by-dependency-count (React, Base
  UI, zod). It loads from disk, so this costs startup milliseconds rather than
  bandwidth, and has not been optimised.
- **Editing a repository's path** is allowed and re-validated, but there is no
  detection of a repository having moved — you have to notice the *Folder
  missing* badge and repoint it yourself.
