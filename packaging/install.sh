#!/bin/sh
# GitWarren's command line, installed from a release tarball.
#
#   curl -fsSL https://gitwarren.com/install.sh | sh
#
# For a Linux or macOS machine with no Homebrew and no Node: the tarball brings
# its own Node, so nothing has to be on the machine but a shell, `tar` and
# `curl` (or `wget`). Windows is not served here - `npx gitwarren` is the
# answer there, and a `.tar.gz` is not how anything is installed on it.
#
# ## It lays the files out exactly as the app does
#
# When the desktop app installs GitWarren onto another machine over ssh
# (`src/core/hosts/install.ts`), the tarball goes into
# `~/.gitwarren/daemon/<version>/` and the stable `~/.gitwarren/bin/gitwarren`
# points into it. This script produces the same layout by the same steps,
# down to the unpack-then-rename and the final `gitwarren service install
# --no-login-item`, which is what writes the launchers. So a machine set up by
# this script is one the app already knows how to upgrade, and a machine the
# app set up is one this script can bring forward - there is one layout, not
# two.
#
# Set GITWARREN_VERSION to install a specific release instead of the latest.
#
# Uninstall: `gitwarren service uninstall`, then `rm -rf ~/.gitwarren`. Reviews
# live elsewhere (`gitwarren service status` prints where) and are not touched
# by either.
set -eu

repo="klarluft/gitwarren-app"
root="$HOME/.gitwarren"

say() { printf '%s\n' "$*" >&2; }
die() { say "install.sh: $*"; exit 1; }

# 1. Which tarball. The same mapping as `targetFromUname` in
#    src/core/hosts/release.ts: Linux says aarch64 where macOS says arm64.
kernel="$(uname -s)"
machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) die "no GitWarren build for $kernel/$machine. Linux and macOS on x86-64 or arm64 are what the release builds." ;;
esac
case "$kernel" in
  Linux) target="linux-$arch" ;;
  Darwin) target="darwin-$arch" ;;
  *) die "no GitWarren build for $kernel/$machine. Linux and macOS on x86-64 or arm64 are what the release builds." ;;
esac

# 2. How to fetch. curl first because it is what the one-liner names; wget
#    because a minimal Debian has that and not curl.
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
  latest_tag() { curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
  latest_tag() { wget -qO /dev/null --max-redirect=5 -S "https://github.com/$repo/releases/latest" 2>&1 | sed -n 's/^ *Location: *//p' | tail -1; }
else
  die "neither curl nor wget is installed, and one of them is needed to download GitWarren."
fi

# 3. Which version. `releases/latest` on github.com, not the API: it answers
#    with a redirect to the newest stable release, and it has no rate limit to
#    run into. Prereleases are skipped by it, which is right for a one-liner.
version="${GITWARREN_VERSION:-}"
if [ -z "$version" ]; then
  version="$(latest_tag | sed -n 's|.*/tag/v\{0,1\}\([^/]*\)$|\1|p')"
  [ -n "$version" ] || die "could not work out the latest release from https://github.com/$repo/releases/latest"
fi
version="${version#v}"

dest="$root/daemon/$version"
launcher="$root/bin/gitwarren"

if [ -x "$launcher" ] && [ "$("$launcher" --version 2>/dev/null || true)" = "$version" ]; then
  say "GitWarren $version is already installed at $dest."
  say "Run \`gitwarren serve\` to start it."
  exit 0
fi

asset="gitwarren-daemon-$version-$target.tar.gz"
url="https://github.com/$repo/releases/download/v$version/$asset"

work="$(mktemp -d "${TMPDIR:-/tmp}/gitwarren-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT

say "Downloading GitWarren $version for $target..."
fetch "$url" "$work/$asset" || die "could not download $url"

# 4. The checksum, from the same release. The Homebrew formula attached to
#    every release names the sha256 of each tarball, and was written by the run
#    that built them - so it is the release's own statement of what the bytes
#    should be, and checking against it costs one small download.
if command -v sha256sum >/dev/null 2>&1; then
  sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  sum() { :; }
fi
if fetch "https://github.com/$repo/releases/download/v$version/gitwarren-cli.rb" "$work/formula.rb" 2>/dev/null; then
  expected="$(grep -A1 -F "/$asset\"" "$work/formula.rb" | sed -n 's/.*sha256 "\([0-9a-f]*\)".*/\1/p' | head -1)"
  actual="$(sum "$work/$asset")"
  if [ -n "$expected" ] && [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
    die "the download did not match the checksum the release published for $asset. Not installing it."
  fi
fi

# 5. Unpack beside the destination and rename into place, so an interrupted
#    unpack can never leave a directory that exists, looks installed, and
#    cannot run. Same as the app's installer.
mkdir -p "$root/daemon" "$root/bin"
stage="$root/daemon/.install-$$"
rm -rf "$stage"
mkdir -p "$stage"
tar xzf "$work/$asset" -C "$stage"
chmod +x "$stage/gitwarren-daemon/bin/"* 2>/dev/null || true
[ -x "$stage/gitwarren-daemon/bin/gitwarren" ] || { rm -rf "$stage"; die "the tarball did not contain bin/gitwarren"; }
if [ -e "$dest" ]; then mv "$dest" "$stage/.previous"; fi
mv "$stage/gitwarren-daemon" "$dest"
rm -rf "$stage"

# 6. The launchers, written by the binary just unpacked - which is also the
#    proof that it runs on this machine. `~/.gitwarren/bin/gitwarren` is the
#    command to put on PATH; `gitwarren-mcp` beside it is what an agent starts.
if ! "$dest/bin/gitwarren" service install --no-login-item >/dev/null; then
  die "GitWarren unpacked into $dest but could not run. The $target build may be the wrong one for this machine."
fi

say ""
say "GitWarren $version is installed."
say ""
case ":$PATH:" in
  *":$root/bin:"*) ;;
  *)
    say "Add its bin directory to your PATH - for example, in your shell's rc file:"
    say ""
    say "    export PATH=\"\$HOME/.gitwarren/bin:\$PATH\""
    say ""
    ;;
esac
say "Then:"
say ""
say "    gitwarren serve              run it now, in this terminal"
say "    gitwarren service install    or keep it running in the background, from now and at every login"
say "    gitwarren agent-setup        the sentence to give a coding agent so it can use GitWarren"
