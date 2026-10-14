# Your other machines

A repository lives on one machine, and so does its review. GitWarren does not
copy either. What it does instead is reach the machine the code is already on,
run the same review there, and render it in the window in front of you.

Five rules hold this together, and every screen below follows from them:

1. **A host owns its repositories.** SQLite, git and the MCP server for a repo
   live on the machine that repo is on. Reviews never move.
2. **Nothing syncs.** The window is a view onto hosts. It caches nothing across
   a disconnect, and a machine that is offline is shown as offline rather than
   as its last known state.
3. **One protocol, several carriers.** The same requests, responses and events
   run unchanged over a child-process pipe, `wsl.exe`, `ssh`, or a WebSocket.
4. **Links resolve where they are clicked.** A loopback link names the host in
   its fragment and opens on whichever GitWarren you clicked from. A tailnet URL
   is offered in addition, but only while that host is actually listening.
5. **Agents never cross the network.** MCP stays on stdio, local to its host,
   reading real paths. The daemon exists for the human elsewhere, not for the
   agent next to the code.

The **Hosts** screen (the card on the home screen, or `g s`) is where all of it
is driven, in both directions: the machines this one reaches, and whether this
one can be reached back.

## On the home screen

After this machine's repositories, the home screen lists each other machine's,
one section per host, each row marked with the machine it is on. Opening a row,
editing it or removing it acts on that machine, never on a repository here that
happens to have the same id. Where a repository on another machine is a clone
of one on this machine — the two share a root commit — the row links to the
local one. Each section is its own read, so a machine that is asleep costs its
section one grey line and holds up nothing else.

Listing another machine's repositories means opening a connection to it, so the
**Other machines** switch above the list turns the sections off. While they are
off, no host is contacted at all, and the screen is one local read again — the
setting for a host that is slow to wake or on a metered link. Only hosts that
have answered at least once are listed.

## Over SSH

Add a machine you can already reach over `ssh` — a VPS, a build box, a PC's WSL
distro — and GitWarren installs itself there over the same connection. The host
needs nothing but git: the daemon tarball ships a Node binary of its own, so
there is no runtime to install and nothing to keep up to date by hand. It is
fetched from the GitHub release by the machine you are sitting at and streamed
down the pipe.

Nothing is left running. `ssh host gitwarren serve --stdio` is spawned on
demand, and a connection pool hangs up after ten idle minutes rather than
holding a socket open to every machine you own.

## WSL, from the Windows app

A WSL distro is a host like any other, reached over `wsl.exe` instead of `ssh`.
The Windows app lists the distributions on the machine and installs into the one
you pick, running as that distribution's own default user.

Windows-native repositories stay first class — most Windows developers do not
run WSL, and agents have run natively there since late 2025. A Windows path and
a WSL path are *different machines*, so a WSL path offered as a local repository
is refused rather than read through `\\wsl$`, which is the wrong architecture
even on the days it works.

## On your tailnet

Turn on **Reachable on your tailnet** and GitWarren runs `tailscale serve` in
front of the loopback port. Every request then has to carry a Tailscale login
equal to this machine's owner; anything else is refused before it reaches the
dispatcher. There is no pairing token, and nothing is exposed to the internet —
`funnel` is deliberately not used.

Your other machines find this one by themselves: peers from
`tailscale status --json` are probed, and the ones that answer are proposed as
hosts with the instance id they reported. Manual entry stays for everything
else. A machine added twice under two names is recognised as one machine,
because the identity that settles it is the instance id rather than the address
you typed.

A listening host is also the only kind that can **push**. Comments and reviews
arrive as events the moment they are written — including writes from an agent,
which pokes the owner of its data directory over the port it already publishes.
A host reached over SSH or `wsl.exe` has no process of its own to push from, so
there the 15-second poll is still the floor. It is the floor everywhere: a lost
event costs seconds, never correctness.

## The phone

There is no phone app, and none is needed. The web view is reachable at the
host's `webUrl` from any device on the tailnet, and `tailscale serve` supplies
the identity, so there is no token to get onto a phone.

The review screens are laid out to be used there, not only looked at: anything
that can be done on the desktop can be done on a phone. Below 1024 pixels the
file list and the diff become separate screens and the diff is always unified.
At phone width the headers and toolbars shrink to icons, the comment composer
is short enough to leave the line in view and sits above the keyboard, and its
text is large enough that iOS does not zoom the page when you start typing. The
per-line comment button is a faint outline until you pick a line, since there
is no hover to hide it behind. Line numbers stay pinned while code scrolls
sideways, the progress strip can be scrubbed with a thumb, and an attached
image opens full size when tapped.

MCP results carry that `webUrl` alongside the always-present loopback `guiUrl`
whenever the host is listening — so a link an agent prints can be opened on the
machine you are holding, not only the one it ran on.

The full design, its spikes and the outcome of every milestone are in
[docs/across-hosts.md](across-hosts.md).
