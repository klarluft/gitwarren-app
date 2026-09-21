# syntax=docker/dockerfile:1

# GitWarren's MCP server, in a container.
#
# This is not how a person runs GitWarren. The point of the product is that the
# reviews are on your machine, next to the working copy the diff is read from,
# and a container is by construction not your machine. What this image is for is
# the two places that insist on one: a directory like Glama, which builds every
# server it lists from a Dockerfile and will not distribute a server whose build
# does not come out reproducibly, and anyone who wants to look at what the
# server does with no compiler, no daemon and no npm cache of their own involved.
#
# So it runs the published package, at a pinned version, exactly as `npx` would
# fetch it - anything else would be scanning a build nobody runs. The version is
# kept in step with package.json by `scripts/sync-plugin-versions.mjs`, which
# the `npm version` script runs on every bump, the same way the plugin and
# registry manifests are kept honest.
#
#   docker build -t gitwarren .
#   docker run --rm -i -v "$PWD:/workspace:ro" -v gitwarren-data:/data gitwarren
#
# The first mount is the repository to review; the second is where the review
# database lives, and without it every run starts empty.

ARG NODE_IMAGE=node:24-bookworm-slim

# A build stage that exists only to hold a compiler.
#
# `better-sqlite3` ships prebuilt binaries for the platforms most people are on
# and falls back to building from source when it lands somewhere they do not
# cover. Both paths have to work here or the image is only reproducible on the
# architectures that got a prebuild - so the toolchain is present, and it is
# present in a stage that is thrown away, which is why the image that actually
# runs the server has no compiler, no headers and no package index in it.
FROM ${NODE_IMAGE} AS build

ARG GITWARREN_VERSION=0.1.17

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global --omit=dev "gitwarren@${GITWARREN_VERSION}"


FROM ${NODE_IMAGE}

ARG GITWARREN_VERSION=0.1.17

LABEL org.opencontainers.image.title="GitWarren" \
      org.opencontainers.image.description="Code review on your own machine, for you and your coding agent. Nothing leaves your computer." \
      org.opencontainers.image.version="${GITWARREN_VERSION}" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.vendor="Klarluft B.V." \
      org.opencontainers.image.url="https://gitwarren.com" \
      org.opencontainers.image.source="https://github.com/klarluft/gitwarren-app"

# `git` because the diff is never stored: every review reads it live out of the
# working tree, through `execFile('git', ...)` with no shell anywhere on the
# path. `ca-certificates` is for the git remotes a mounted repository may have;
# the server itself asks the network for nothing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/lib/node_modules/gitwarren /usr/local/lib/node_modules/gitwarren
RUN ln -s ../lib/node_modules/gitwarren/bin/gitwarren.mjs /usr/local/bin/gitwarren \
 && chmod +x /usr/local/lib/node_modules/gitwarren/bin/gitwarren.mjs \
 && gitwarren --version

ENV NODE_ENV=production

# Where the review database goes, named rather than left to the platform
# default. Outside a container that default is the user's application-data
# directory, which is right there and wrong here: it would put the one piece of
# state this server keeps inside a container layer, where it is both invisible
# and gone at the end of the run. Naming it means there is exactly one path this
# process ever writes to, it is declared, and it is the one to mount.
ENV GITWARREN_DATA_DIR=/data

# `node` is a user the base image already ships, uid 1000. Nothing here needs
# root: the package is installed at build time, and at runtime the server reads
# a mounted working tree and writes one SQLite file.
RUN mkdir -p /data /workspace && chown node:node /data /workspace
USER node
WORKDIR /workspace

# A bind-mounted repository is owned by whoever owns it on the host, which is
# almost never uid 1000, and git refuses to read a repository it thinks belongs
# to someone else. The refusal is a defence against a repository's own config
# running commands as you; inside a container whose whole contents are one
# server and one mount, with the config read by a `git` that is never handed a
# shell, the trade is worth making, and it is made here rather than asked of
# whoever runs the image.
RUN git config --global --add safe.directory '*'

# stdio, and nothing else. `mcp --serve` would also serve the review page on
# 127.0.0.1:41427 for the length of the run, which is how the links the server
# hands out open on a machine with nothing else installed - useful when you have
# published the port, and a listener nobody asked for when you have not.
ENTRYPOINT ["gitwarren"]
CMD ["mcp"]
