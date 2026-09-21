# The Glama build spec

The fields to paste into
`https://glama.ai/mcp/servers/klarluft/gitwarren-app/admin/dockerfile`, and why
they say what they say.

## Why this file exists at all

There is a `Dockerfile` at the root of this repository and Glama does not read
it. That page is a form — a base image, a list of build steps, a CMD, an
environment schema — and Glama generates its own Dockerfile from those fields,
clones this repository into `/app` at a pinned commit, and runs the build steps
there. Whatever is committed here is ignored.

That is easy to get wrong in the other direction, because the published
methodology says a server is built "from a Dockerfile … authored by the
maintainer and checked into the repository, or inferred by Glama's AI-assisted
build system", which reads as though the committed file is one of the two
options. It is not, at least not from this page. So the fields live here, in
version control, next to the file they are deliberately kept similar to.

## What Glama prefills, and why none of it works

The inferred spec for this repository is:

```json
["pnpm install", "pnpm run build"]
["mcp-proxy", "--", "node", "bin/gitwarren.mjs"]
```

Three separate problems:

- **`pnpm`.** This repository has `package-lock.json` and no `pnpm-lock.yaml`.
- **`run build`.** That script typechecks, then runs `electron-vite build` and
  three more Vite builds. It needs the `electron` devDependency, whose install
  downloads a platform binary. It is minutes of work and a large download to
  produce bundles this server does not start from.
- **`bin/gitwarren.mjs`.** No such path exists in this repository. The launcher
  of that name is `packaging/npm/bin/gitwarren.mjs`, it is published rather
  than checked out, and it loads `../lib/gitwarren.cjs`, which only exists
  inside the built npm package.

## The spec to use

Leave the base image, Node version and Python version at their defaults. The
generated image already installs `git`, Node 24 and `mcp-proxy`, which is
everything this server needs.

**Build steps**

```json
["npm install -g gitwarren@0.1.17"]
```

**CMD arguments**

```json
["mcp-proxy", "--", "gitwarren", "mcp"]
```

**Placeholder parameters**

```json
{"GITWARREN_DATA_DIR": "/tmp/gitwarren"}
```

**Pinned commit SHA** — leave empty.

## Why install the published package instead of building the checkout

Because it is the honest thing to put in front of a scanner. `npx gitwarren
mcp` is how every agent runs this server, so the published tarball is the
artifact that should be started, watched and rated. Building the checkout would
scan bundles that no user ever receives, and would do it through the heaviest
path in the repository.

It does mean the pinned commit is not what runs, which is why that field is
left empty rather than set to something misleading.

The one field that must move on a release is the version in the build step.
`scripts/sync-plugin-versions.mjs` cannot reach it, because it is not in this
repository. Nothing here can fail when it goes stale, so treat it as part of
making a Glama release rather than part of making a release.

## The two buttons

- **Build** runs the build and starts the server, and nothing else. It is a
  test. Use it first, and use it after any change to the fields above.
- **Build & Release** does that and then publishes a release. This is the one
  that matters: it is what puts the image through the security scan, what lets
  people deploy the server from Glama, and what lifts the quality rating.

Run **Build** until it is green, then **Build & Release**.

## What the scan should find

The same three properties the root `Dockerfile` is arranged to demonstrate, and
they hold here for the same reasons:

- The server writes to one directory, the one `GITWARREN_DATA_DIR` names.
- It opens no outbound connection. It speaks stdio, reads the working tree and
  writes SQLite; the only socket it can open is a best-effort poke to a running
  GUI on loopback, which finds no owner in a container and carries on.
- `mcp` is passed without `--serve`, so it binds nothing. `mcp-proxy` in front
  of it is Glama's own HTTP wrapper and is expected to listen.

## A note on hosting

Glama's hosting product is separate, paid and opt-in, and it does not suit this
server: a copy running on their hardware cannot see anybody's repositories.
Making a release is still worth it, because the scan, the rating and the
listing all hang off it. The registry description already says the review
happens on your own machine and that nothing leaves your computer, which is the
sentence that has to do the work if somebody deploys it anyway.
