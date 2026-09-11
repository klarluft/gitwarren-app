# Contributing to GitWarren

Thanks for taking an interest. GitWarren is a desktop app for doing local-only
code reviews — human and agent alike — and it is maintained by one person, so
clear, small, well-described changes are much more likely to land than large
ones that arrive without warning.

## Before you write code

**Open an issue first for anything non-trivial.** A bug fix or a typo can go
straight to a pull request. A new feature, a dependency, a schema change, or a
refactor that touches more than a couple of files should start as an issue so we
can agree on the shape before you spend time on it.

Two things are deliberate design constraints rather than gaps, and changes that
break them will not be merged:

- **It runs on one machine.** No server, no account system, no telemetry, no
  network calls in the core review path. If a feature needs a backend, it is out
  of scope for this project.
- **Git is read, not reimplemented.** GitWarren shells out to the user's own
  `git`. It does not bundle a git implementation and does not write to the user's
  repositories.

The [Known limitations](README.md#known-limitations) section of the README lists
things that are already understood to be missing. Those are fair game, and an
issue confirming you are picking one up avoids duplicated effort.

## The Contributor License Agreement

GitWarren is licensed under the **GNU General Public License v3.0 or later**.

Before your first contribution can be merged, you need to sign the
[Contributor License Agreement](CLA.md). This is automated: open your pull
request and a bot will comment with a one-line statement to reply with. It takes
about ten seconds and you will never be asked again.

**Why a CLA?** So that the copyright in the codebase stays in one place. That
keeps it possible to offer GitWarren under a commercial licence alongside the
GPL, and to change licence later, without having to track down and get
permission from every past contributor — something that becomes impossible in
practice once a project has been going for a while. The CLA does not take your
rights away: you keep full ownership of your contribution and can use it
elsewhere however you like.

## Development setup

Requirements: the Node in [`.nvmrc`](.nvmrc) (**24.20.0**) and **git on your
PATH**. `nvm` and `fnm` read `.nvmrc` on `cd`; `engine-strict` in `.npmrc`
turns a mismatched toolchain into an error rather than a warning.

```bash
npm install          # also rebuilds native deps for Electron
npm run dev          # start the app with hot reload
```

See [Development setup](README.md#development-setup) in the README for the full
list of scripts, and [Project layout](README.md#project-layout) for where things
live.

## Before you open a pull request

Run the same four things CI runs:

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

The tests create throwaway git repositories in a temp directory and point the
app at a temp data directory via `GITWARREN_DATA_DIR`, so they never touch your
real database.

### What CI runs

`.github/workflows/ci.yml` runs those four, plus one daemon tarball build, on
**Windows, macOS and Linux** — all three, on every pull request. The comments in
that file explain each choice; the short version is why it is shaped that way at
all.

Four platform-shaped breakages in this repository were found by a person at a
keyboard rather than by the suite, because CI used to run ubuntu only: `npx.cmd`
spawned from `scripts/run-tests.mjs`, which meant `npm test` had never once
worked on Windows; a drive-letter path; the symlink `fs.test.ts` created in
`before`, which took thirteen tests down with it; and `du -h` in
`scripts/build-daemon-tarball.mjs`. Three of those four are `npm test`. The
fourth lived in a script CI never ran, which is why the tarball build is a step
now — and `npm run build` is a step for a separate reason, that CI never ran the
bundler at all.

macOS is in the matrix for a fifth thing, which is not a breakage but a
disagreement: `tailscale serve` needs `--operator` on Linux and succeeds
silently as the user on macOS. What exposed it was two platforms differing,
which no single-platform job can notice however well chosen the platform is.

Two things worth knowing when you read a green check:

- **A skip is reported by name.** `npm test` fails if a test skips itself
  without being listed in `MAY_SKIP` in `scripts/run-tests.mjs`. Four tests skip
  everywhere and a fifth skips on a Windows machine without Developer Mode, and
  before this the two were the same line of output — so a test that quietly
  stopped running on one platform looked exactly like the one that is meant not
  to run there. Every run now prints what it did *not* check.
- **Green means the lockfile installs, not that your `node_modules` is right.**
  CI installs with `npm ci`, from the lockfile. A developer's `node_modules`
  drifts on its own — `ws` went missing from one for two milestones without CI
  noticing, and it could not have. What a publicly visible green Windows build
  gives you is the other half of that answer: if your checkout fails and CI
  does not, the problem is your install, not the repository.

If you changed the Drizzle schema in `src/core/db/schema.ts`, regenerate the
migrations and commit the generated SQL:

```bash
npm run db:generate
```

Migrations are shipped as real `.sql` files and read from disk at runtime, so the
generated files must be committed — see
[Database migrations](README.md#database-migrations).

## Pull request expectations

- **One concern per pull request.** A fix and a refactor in the same diff is two
  pull requests.
- **Describe the behaviour, not just the code.** What was wrong, what is right
  now, and how you checked.
- **Match the surrounding style.** The codebase has a consistent voice in both
  its code and its comments — comments explain *why*, not *what*. ESLint covers
  the mechanical part; the rest is a matter of reading the neighbours.
- **Tests for behaviour changes.** The suite runs against a real SQLite file and
  a real `git`, so a test that reproduces the bug is usually straightforward to
  write.
- **No new runtime dependencies without discussion.** Everything shipped to
  users is bundled into the app, and the dependency list is intentionally short.

## Reporting bugs

Include your OS and architecture, the GitWarren version, your `git --version`,
and what you expected to happen. If it involves a specific repository state
(a detached HEAD, a submodule, a worktree), describing how to reproduce that
state matters more than anything else.

## Security

Do not open a public issue for a security problem. Email
**contact@klarluft.com** with the details and give a reasonable window for a fix
before disclosing.

## Licence

By contributing, you agree that your contributions will be licensed under the
GPL-3.0-or-later, and — per the [CLA](CLA.md) — that the maintainer may also
license them under other terms.
