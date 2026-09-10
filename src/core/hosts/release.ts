/**
 * Finding the right daemon tarball, and having it locally before a host is
 * asked to accept it.
 *
 * The whole reason this module is on the *asking* side rather than on the host
 * is stated in M4: the host needs nothing installed but git. It does not fetch,
 * it does not resolve a version, and it never talks to GitHub — the machine
 * with a browser and a person at it does all of that, and what crosses the pipe
 * is bytes. That is what makes an air-gapped box, a locked-down VPS or a WSL
 * distro behind a corporate proxy work without a single exception in the code.
 *
 * ## The name is the contract
 *
 * `scripts/build-daemon-tarball.mjs` says so at the bottom of the file, and
 * this is the other end of that sentence: `gitwarren-daemon-<version>-<target>.tar.gz`
 * is composed here from a version and a `uname`, and fetched by URL. One
 * request, no listing and no search — which matters because a release listing
 * needs an API call, an API call needs a token when the rate limit bites, and a
 * review tool has no business asking for one.
 *
 * ## Why a local directory can stand in for the release
 *
 * `GITWARREN_DAEMON_TARBALL_DIR` is not a test seam bolted on afterwards. There
 * are two ordinary situations where the release cannot answer: a development
 * build, whose version is `0.0.0-dev` and which no release has ever heard of,
 * and a machine that genuinely has no route to github.com but does have the
 * file on a stick. Both want the same thing — "use this file" — and both are
 * better served by a directory than by a flag on a form, because the answer is
 * a property of the *machine* and not of the host being added.
 *
 * ## Guarding on the magic bytes rather than on the status code
 *
 * A draft release's asset URL 404s, which is caught. The failure worth guarding
 * against is the other one: a proxy or a login wall that answers 200 with a
 * page of HTML, which `fetch` reports as a perfectly good response and which
 * lands on disk as `gitwarren-daemon-….tar.gz`. Cached, it would then fail on
 * every host it was streamed to, with `tar` complaining somewhere across an ssh
 * pipe. Two bytes at the front settle it here, where the URL that produced them
 * is still in scope.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { getDaemonCacheDirectory } from '../paths.js'
import { AppError } from '../../shared/errors.js'

/**
 * The four the release builds. Windows is absent on purpose and not by
 * omission — see the note in `scripts/build-daemon-tarball.mjs`; a `.tar.gz`
 * unpacked by hand is not how anything is installed there, and M5 reaches a
 * Windows machine's WSL with the linux tarball anyway.
 */
export const DAEMON_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const
export type DaemonTarget = (typeof DAEMON_TARGETS)[number]

/** Set to a directory of `gitwarren-daemon-*.tar.gz` files to use those instead. */
export const TARBALL_DIR_ENV_VAR = 'GITWARREN_DAEMON_TARBALL_DIR'

const RELEASE_BASE = 'https://github.com/klarluft/gitwarren-app/releases/download'

/** gzip. Checked on the way in; see the note at the top. */
const GZIP_MAGIC = [0x1f, 0x8b]

/**
 * `uname -sm`, as a tarball target.
 *
 * `uname` is the right question because it is the only one every host can
 * answer: it predates all of this, it is in the base install of everything with
 * an `ssh` daemon, and it costs nothing on a connection that is already open.
 * Asking the host's package manager or reading `/etc/os-release` would be
 * asking about a *distribution*, which is not what a tarball of a Node binary
 * and a prebuilt addon cares about.
 *
 * The arm spellings are both real: Linux says `aarch64` and macOS says `arm64`
 * for the same silicon, and a host answering one of them while the file is
 * named the other is the whole reason this function is not a lookup table
 * written inline at the call site.
 */
export function targetFromUname(output: string): DaemonTarget {
  const [kernel, machine] = output.trim().split(/\s+/)

  const arch =
    machine === 'x86_64' || machine === 'amd64'
      ? 'x64'
      : machine === 'aarch64' || machine === 'arm64'
        ? 'arm64'
        : null

  if (kernel === 'Linux' && arch) return `linux-${arch}` as DaemonTarget
  if (kernel === 'Darwin' && arch) return `darwin-${arch}` as DaemonTarget

  throw new AppError(
    'INVALID_INPUT',
    `There is no GitWarren daemon for ${output.trim() || 'that machine'}. ` +
      'Linux and macOS on x86-64 or arm64 are what the release builds.'
  )
}

export function tarballName(version: string, target: DaemonTarget): string {
  return `gitwarren-daemon-${version}-${target}.tar.gz`
}

export function tarballUrl(version: string, target: DaemonTarget): string {
  return `${RELEASE_BASE}/v${version}/${tarballName(version, target)}`
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Reject anything that is not a gzip stream, naming where it came from.
 *
 * Reads the file rather than the response so that a cached file corrupted by a
 * full disk is caught on the next install too, not only on the download that
 * wrote it.
 */
async function assertGzip(path: string, source: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0)
    if (bytesRead === 2 && buffer[0] === GZIP_MAGIC[0] && buffer[1] === GZIP_MAGIC[1]) return
  } finally {
    await handle.close()
  }
  throw new AppError(
    'INTERNAL',
    `${source} did not return a GitWarren daemon tarball. It may be a login page or ` +
      'an error page served with a success status.'
  )
}

export interface ResolveTarballOptions {
  /** Where downloads are kept. Defaults to the app's daemon cache. */
  cacheDirectory?: string
  /** Checked before the cache and before the network. Defaults to the env var. */
  localDirectory?: string | undefined
  /** Swappable so the tests can serve a real file over a real socket. */
  baseUrl?: string
  fetchImpl?: typeof fetch
}

/**
 * The path to a local file holding this version's tarball for `target`.
 *
 * Three places, in the order of "already answered" to "costs a download": a
 * directory the machine was told about, the cache, then the release. The
 * download lands on a `.partial` named after the process so that two installs
 * racing on two hosts of the same architecture cannot hand each other a half a
 * file — the rename at the end is what publishes it, and rename is the only
 * filesystem operation that can promise that.
 */
export async function resolveTarball(
  version: string,
  target: DaemonTarget,
  {
    cacheDirectory = getDaemonCacheDirectory(),
    localDirectory = process.env[TARBALL_DIR_ENV_VAR]?.trim() || undefined,
    baseUrl = RELEASE_BASE,
    fetchImpl = fetch
  }: ResolveTarballOptions = {}
): Promise<string> {
  const name = tarballName(version, target)

  if (localDirectory) {
    const local = join(localDirectory, name)
    if (await isFile(local)) {
      await assertGzip(local, local)
      return local
    }
    // Named and missing is an error rather than a quiet fall-through to the
    // network: someone who set this variable meant it, and silently downloading
    // a *different* build than the one they staged is the surprise worth
    // avoiding on a machine where the two can differ.
    throw new AppError(
      'NOT_FOUND',
      `${TARBALL_DIR_ENV_VAR} is set to ${localDirectory}, which has no ${name}. ` +
        'Build it with `node scripts/build-daemon-tarball.mjs ' +
        `${target}\`, or unset the variable to download it.`
    )
  }

  const cached = join(cacheDirectory, name)
  if (await isFile(cached)) {
    await assertGzip(cached, cached)
    return cached
  }

  const url = `${baseUrl}/v${version}/${name}`
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) {
    throw new AppError(
      response.status === 404 ? 'NOT_FOUND' : 'INTERNAL',
      `Could not download the GitWarren daemon for ${target} (${response.status} from ${url}). ` +
        (response.status === 404
          ? `Version ${version} may not be published yet — a draft release's files cannot be ` +
            `downloaded. Set ${TARBALL_DIR_ENV_VAR} to a directory holding ${name} to install ` +
            'from a build you have locally.'
          : 'Try again in a moment.')
    )
  }

  await mkdir(cacheDirectory, { recursive: true })
  const partial = `${cached}.${process.pid}.partial`
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
    await assertGzip(partial, url)
    await rename(partial, cached)
  } catch (error) {
    await rm(partial, { force: true })
    throw AppError.from(error)
  }

  return cached
}
