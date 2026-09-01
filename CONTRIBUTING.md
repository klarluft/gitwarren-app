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

Requirements: **Node 22+**, **npm 10+**, and **git on your PATH**.

```bash
npm install          # also rebuilds native deps for Electron
npm run dev          # start the app with hot reload
```

See [Development setup](README.md#development-setup) in the README for the full
list of scripts, and [Project layout](README.md#project-layout) for where things
live.

## Before you open a pull request

Run the same three things CI runs:

```bash
npm run lint
npm run typecheck
npm test
```

The tests create throwaway git repositories in a temp directory and point the
app at a temp data directory via `GITWARREN_DATA_DIR`, so they never touch your
real database.

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
**michal@wrzosek.pl** with the details and give a reasonable window for a fix
before disclosing.

## Licence

By contributing, you agree that your contributions will be licensed under the
GPL-3.0-or-later, and — per the [CLA](CLA.md) — that the maintainer may also
license them under other terms.
