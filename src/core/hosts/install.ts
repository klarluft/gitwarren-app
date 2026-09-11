/**
 * Putting GitWarren on a machine that has never had it, over the connection
 * that was already open.
 *
 * The promise M4 makes is that a host needs nothing installed but git. This is
 * the file that has to keep it, so the shape of the whole thing follows from
 * one constraint: the host may have no package manager worth using, no Node, no
 * route to the internet and no shell but `sh`. What it does have is a way in,
 * `tar` and a home directory. So four commands cross the wire and nothing else:
 *
 *   1. `uname -sm`                     - which tarball
 *   2. `gitwarren --version`           - whether there is anything to do
 *   3. `tar xzf -` reading stdin       - the bytes
 *   4. `gitwarren service install`     - the launchers
 *
 * ## Why the host writes its own launchers
 *
 * Step 4 is the one worth defending. It would be a shorter file to `echo` two
 * `sh` scripts into `~/.gitwarren/bin` from here, and it would be wrong twice
 * over. `src/cli/launchers.ts` already knows what a launcher looks like, down
 * to the symlink loop and the two exported paths that a login shell cannot work
 * out for itself, and a second implementation across an ssh pipe would be a
 * copy that drifts. More to the point, running the binary we just unpacked is
 * the only *proof* that we picked the right architecture: a linux-arm64 tarball
 * on an x86-64 box gets as far as a working `tar` and then fails at the first
 * `exec`, and it is much better for that to happen here, during an install
 * someone is watching, than at the first review they try to open.
 *
 * `--no-login-item` is there because a remote host is not where a login item
 * belongs. The carrier spawns `gitwarren serve --stdio` on demand and hangs up
 * after ten idle minutes (`core/hosts/pool.ts`); a daemon that also started
 * itself at boot would be a second process on the same database that nobody
 * asked for. The flag exists for exactly this - see the note in
 * `src/cli/service.ts`, which named the VPS case before there was one.
 *
 * ## The versioned directory, and what is allowed to be atomic
 *
 * The tarball unpacks into `~/.gitwarren/daemon/<version>/` and the stable
 * `~/.gitwarren/bin/gitwarren` points into it. That indirection is M2's, and it
 * is what lets an agent config written today survive every upgrade after it:
 * the launcher path never changes, only what it resolves to.
 *
 * Unpacking goes to a scratch directory beside the destination and is moved in
 * with one `mv`, because a `tar` interrupted halfway through the destination
 * itself leaves a directory that exists, looks installed and cannot run. On one
 * filesystem `mv` is `rename`, which either happened or did not.
 *
 * ## What this deliberately does not do
 *
 * It does not report progress. There is no event channel yet - `shared/rpc.ts`
 * reserves one for M6 and nothing emits on it - and inventing half of one for a
 * progress bar would put a push-shaped hole in a request/response protocol for
 * a wait that is a few seconds on a LAN. The screen says what is happening and
 * how big the download is; the honest thing to do about the missing bar is to
 * wait for the channel that other things also need.
 *
 * It also does not uninstall. `hosts.remove` forgets a host, which is a
 * statement about this machine's list; going onto someone's server to delete a
 * directory is a different act, and `rm -rf ~/.gitwarren` is one the person can
 * type themselves and read before pressing return.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { runOverSsh } from './ssh.js'
import { runOverWsl } from './wsl.js'
import type { RunOnHost } from './carrier.js'
import { resolveTarball, targetFromUname, type DaemonTarget } from './release.js'
import { shellQuote } from '../shell-quote.js'
import { APP_VERSION } from '../version.js'
import { AppError } from '../../shared/errors.js'
import type { InstallAction } from '../../shared/schemas.js'
import type { HostRoute } from './pool.js'

/** Where everything lives on the far end. `~` is expanded by the remote shell. */
const REMOTE_ROOT = '$HOME/.gitwarren'

/**
 * Run one command on a host, whichever carrier reaches it.
 *
 * The whole of M5.2's install work, and it is a switch. Everything above and
 * below is M4.2's and did not change: four commands cross a connection, the
 * archive unpacks into a scratch directory beside the destination, the host
 * writes its own launchers by running the binary just unpacked, and the version
 * is read back rather than assumed. That is what it means for the installer to
 * have been written against "a machine with a shell and a `tar`" rather than
 * against `ssh`.
 *
 * ## The bytes go over the pipe, and `\\wsl.localhost` was rejected
 *
 * A WSL distribution is visible from Windows as `\\wsl.localhost\<distro>\…`, so
 * the tarball could be *copied* there instead of streamed. It is not, and the
 * reason is not speed - spike S2 measured 56 MB/s through this pipe on this
 * machine, which puts the 46 MB archive under a second, and M4.2's `ssh` pipe
 * did the same file in 3.4 seconds with nobody complaining.
 *
 * It loses on moving parts. The file route still needs a shell inside the
 * distribution to unpack the archive and to run `service install`, so it
 * replaces `tar xzf -` reading stdin with a file copy *plus* that same shell
 * invocation - strictly more, to save nothing. It also puts the bytes through
 * SMB, and M5.4 is about what SMB does to a Linux working tree. And it is only
 * available while the distribution is running, which is a precondition the pipe
 * does not have, because starting it is what the pipe does.
 */
export const runOnHost: RunOnHost = (route, options) => {
  switch (route.kind) {
    case 'wsl':
      return runOverWsl({ distro: route.target, ...options })
    case 'ssh':
      return runOverSsh({ target: route.target, ...options })
    case 'websocket':
      // There is no shell on this carrier and there must not be one. `ssh` and
      // `wsl.exe` reach a machine by *starting a process on it*, which is what
      // makes an installer possible at all; a WebSocket reaches a daemon that
      // is already running, and everything it can be asked to do is a method on
      // the dispatcher - which, by the note at the top of
      // `core/rpc/dispatcher.ts`, may never start a process.
      //
      // So this is not a gap to be filled later. A listening host is one that
      // already has GitWarren on it, by construction: if it did not, there
      // would be nothing to connect to. Installing onto it is somebody's job at
      // that machine, or M4's `ssh` carrier's, and the message says which.
      return Promise.reject(
        new AppError(
          'FORBIDDEN',
          `${route.target} is reached over its own network connection, so GitWarren cannot be ` +
            `installed onto it from here - a machine that answers is a machine that already has ` +
            `it. Update it on that machine, or add it as an SSH host to install over a shell.`
        )
      )
  }
}

/**
 * What happened, minus the host row.
 *
 * `already-current` is a first-class outcome rather than a silent no-op: a
 * person who pressed "Install" and saw nothing move has learned nothing, and
 * the useful sentence is "0.1.7-beta.1 is already there". The service adds the
 * row and hands the whole thing to the screen; this layer knows nothing about
 * SQLite.
 */
export interface DaemonInstallReport {
  action: InstallAction
  /** What is on the host now. Read back from the launcher, not assumed. */
  version: string
  /** What was there before, or null for a host that had no GitWarren. */
  previousVersion: string | null
  target: DaemonTarget
  /** Bytes streamed, or 0 when nothing had to be. For the sentence afterwards. */
  bytes: number
}

export interface InstallOptions {
  /** Reinstall even when the version already matches. */
  force?: boolean
  /** The version to put there. The asking machine's, unless a test says otherwise. */
  version?: string
  /** Swapped in tests; see `runOnHost`. */
  run?: RunOnHost
  resolve?: typeof resolveTarball
}

/**
 * Ask the launcher what it is.
 *
 * Null covers both "no launcher" (127) and "a launcher too old to understand
 * `--version`", which are the same thing as far as the next step is concerned:
 * whatever is there cannot be identified, so it gets replaced. Nothing branches
 * on the difference, so nothing here works to tell them apart.
 */
async function installedVersion(route: HostRoute, run: RunOnHost): Promise<string | null> {
  const { code, stdout } = await run(route, {
    command: `${REMOTE_ROOT}/bin/gitwarren --version 2>/dev/null`
  })
  if (code !== 0) return null
  const version = stdout.trim().split('\n').pop()?.trim()
  return version || null
}

/**
 * The script that receives the bytes.
 *
 * `sh`, not `bash`: a BSD host, a minimal container and a busybox WSL image all
 * have the first and not reliably the second, and there is nothing here that
 * needs more. No `--strip-components` for the same reason - it is a GNU and
 * bsdtar spelling and busybox's `tar` has neither, so the archive's own
 * `gitwarren-daemon/` directory is moved rather than stripped, which every
 * `tar` in existence agrees about.
 *
 * `$$` in the scratch name is the remote shell's pid, so two installs onto one
 * host cannot collide in the seconds they overlap.
 */
function unpackScript(version: string): string {
  const quoted = shellQuote(version)
  return [
    'set -e',
    `root=${REMOTE_ROOT}`,
    `dest="$root/daemon"/${quoted}`,
    `work="$root/daemon/.incoming.$$"`,
    'mkdir -p "$root/daemon"',
    'rm -rf "$work"',
    'mkdir -p "$work"',
    // The one command that reads the pipe. A failure here has to end the
    // script, which is what `set -e` is for: continuing would move an empty
    // directory into place and call it an install.
    'tar xzf - -C "$work"',
    // The executable bit is set here rather than trusted from the archive,
    // because the machine that built the archive may not have been able to
    // express one. A tarball built on Windows carries every file as 0666: NTFS
    // has no POSIX mode, `chmodSync` is a no-op there, and bsdtar records what
    // it is given - so `bin/gitwarren`, `bin/gitwarren-mcp` and the embedded
    // `bin/node` all arrive unexecutable and the check below fails on an
    // archive whose *contents* are perfectly correct. Found on this PC in M5.2.
    //
    // Nothing was ever read from those bits except this one check, and the step
    // after it runs the binary, so setting the bit we require is strictly more
    // reliable than asserting somebody else set it. `|| true` because a release
    // tarball already has them and a read-only oddity should not fail an
    // install that is about to prove itself by running the thing anyway.
    'chmod +x "$work/gitwarren-daemon/bin/"* 2>/dev/null || true',
    '[ -f "$work/gitwarren-daemon/bin/gitwarren" ] || {',
    '  echo "the tarball did not contain bin/gitwarren" >&2',
    '  rm -rf "$work"',
    '  exit 1',
    '}',
    '[ -x "$work/gitwarren-daemon/bin/gitwarren" ] || {',
    '  echo "bin/gitwarren is not executable and could not be made so" >&2',
    '  rm -rf "$work"',
    '  exit 1',
    '}',
    // Move the old aside rather than deleting it first, so the window in which
    // the destination does not exist is one rename wide.
    'if [ -e "$dest" ]; then mv "$dest" "$work/.previous"; fi',
    'mv "$work/gitwarren-daemon" "$dest"',
    'rm -rf "$work"',
    'echo "$dest"'
  ].join('\n')
}

/**
 * Install, or upgrade, GitWarren on a host.
 *
 * Throws `HOST_OFFLINE` when the machine cannot be reached and `INTERNAL` with
 * the host's own stderr when a step ran and failed - the difference matters to
 * the person reading it, and neither is a message this function invents.
 */
export async function installOnHost(
  route: HostRoute,
  { force = false, version = APP_VERSION, run = runOnHost, resolve = resolveTarball }: InstallOptions = {}
): Promise<DaemonInstallReport> {
  const uname = await run(route, { command: 'uname -sm' })
  if (uname.code !== 0) {
    throw new AppError(
      'INTERNAL',
      `\`uname -sm\` failed on ${route.target}: ${uname.stderr.trim() || `exit ${uname.code}`}`
    )
  }
  const daemonTarget = targetFromUname(uname.stdout)

  const previousVersion = await installedVersion(route, run)
  if (previousVersion === version && !force) {
    return { action: 'already-current', version, previousVersion, target: daemonTarget, bytes: 0 }
  }

  // Fetched before anything on the host is touched. A download that fails
  // should leave the host exactly as it was, not part-way through an upgrade.
  const tarball = await resolve(version, daemonTarget)
  const bytes = (await stat(tarball)).size

  const unpack = await run(route, {
    command: unpackScript(version),
    stdin: createReadStream(tarball)
  })
  if (unpack.code !== 0) {
    throw new AppError(
      'INTERNAL',
      `Unpacking GitWarren on ${route.target} failed: ${unpack.stderr.trim() || `exit ${unpack.code}`}`
    )
  }

  // The host writes its own launchers, and by running proves the tarball's
  // `node` can execute here. See the note at the top of the file.
  const launchers = await run(route, {
    command: `${REMOTE_ROOT}/daemon/${shellQuote(version)}/bin/gitwarren service install --no-login-item`
  })
  if (launchers.code !== 0) {
    throw new AppError(
      'INTERNAL',
      `GitWarren unpacked on ${route.target} but could not start: ` +
        (launchers.stderr.trim() || `exit ${launchers.code}`) +
        `. The tarball for ${daemonTarget} may be the wrong one for that machine.`
    )
  }

  // Read back rather than assumed. This is the assertion that the launcher the
  // carrier will spawn - the stable path, not the versioned one - now resolves
  // to what we just put there.
  const now = await installedVersion(route, run)
  if (now !== version) {
    throw new AppError(
      'INTERNAL',
      `${route.target} still reports ${now ?? 'no GitWarren'} after installing ${version}. ` +
        'Something else on that machine is maintaining ~/.gitwarren/bin/gitwarren.'
    )
  }

  return {
    action: previousVersion === null ? 'installed' : 'upgraded',
    version,
    previousVersion,
    target: daemonTarget,
    bytes
  }
}
