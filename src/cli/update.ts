/**
 * `gitwarren update` - the command line moving itself forward.
 *
 * The app has updated itself since M1 and a *host* has been upgradable from
 * the app since M5.2, by a function four commands long. The machine nobody
 * could update was the one in front of the person typing: an install from
 * `install.sh` had exactly one way forward, which was to remember the curl
 * one-liner, and no way at all to find out that there was something to move
 * to.
 *
 * ## It is the same install, done again
 *
 * Nothing here is a new mechanism. `packaging/install.sh` and
 * `core/hosts/install.ts` already lay out `~/.gitwarren/daemon/<version>/` with
 * a stable launcher in front of it, unpack beside the destination and rename
 * into place, and finish by having the *new* binary write the launchers -
 * which is also the proof that it runs on this machine. This does those steps,
 * in that order, from inside the program. The layout is the contract, and this
 * file deliberately adds nothing to it.
 *
 * What it adds is the two things a shell script run from a pipe cannot do:
 *
 *  - **Restart the background GitWarren.** `install.sh` finishes with the
 *    launchers pointing at the new install while the daemon that is already
 *    running goes on serving the old code until the next login. See
 *    `restartLoginItem` in `service.ts`.
 *  - **Prune.** Every install since the first one has left its predecessor on
 *    disk. Nothing ever removed one, on any machine, including the hosts the
 *    app installs onto - a ~45 MB directory per version, for as long as the
 *    machine lasts.
 *
 * ## What it refuses to do
 *
 * Update an install it does not own. A Homebrew install has a package manager
 * with a record of every file it poured, an npm install belongs to a project's
 * dependency tree, and an npx copy is a cache entry that is already
 * `gitwarren@latest` on the next run. Writing over any of those would leave
 * two things that disagree about what is installed. `cli/layout.ts` is the
 * file that decides which case this is; here, a case that is not `managed` is
 * a sentence naming the command that *is* the right one, and an exit code of
 * zero, because the user asked a reasonable question and got a true answer.
 *
 * `--check` is the half that works everywhere, and is the point of the whole
 * thing for the users this cannot update: a Homebrew install can still be told
 * that 0.1.15 exists.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveTarball,
  tarballName,
  targetForThisMachine,
  type DaemonTarget
} from '../core/hosts/release.js'
import { APP_VERSION } from '../core/version.js'
import {
  describeLayout,
  directorySize,
  formatBytes,
  listDaemonDirectories,
  type InstallLayout
} from './layout.js'
import { restartLoginItem } from './service.js'

const USAGE = `gitwarren update [--check] [--version <version>] [--force]

Moves this GitWarren to the newest release, restarts the background service if
one is running, and removes the versions it replaced.

  --check              say what is installed and what the newest release is,
                       and change nothing
  --version <version>  install that release instead of the newest one
  --force              install even when the version asked for is the one
                       already here

Only an install under ~/.gitwarren/daemon can be updated in place - the layout
install.sh writes, and the one GitWarren installs onto another machine over
ssh. A Homebrew, npm or npx copy belongs to its package manager, and this says
which command to run instead. Reviews are never touched: they live in the data
directory \`gitwarren service status\` prints.
`

const RELEASES = 'https://github.com/klarluft/gitwarren-app/releases'

export interface UpdateDeps {
  fetchImpl?: typeof fetch
  resolve?: typeof resolveTarball
}

/**
 * The newest published version, from the redirect rather than from the API.
 *
 * `releases/latest` on github.com answers with a redirect to the newest
 * *stable* release and has no rate limit to run into; the API has both a rate
 * limit and a token to explain when it bites. `install.sh` resolves the
 * version exactly this way, and a command that disagreed with the script that
 * installed it about what "latest" means would be the worst kind of wrong.
 *
 * Prereleases are skipped by it, which is right: nobody typing `gitwarren
 * update` is asking to be moved onto one.
 */
export async function latestVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`${RELEASES}/latest`, { method: 'HEAD', redirect: 'follow' })
  const tag = /\/tag\/v?([^/]+)$/.exec(response.url ?? '')?.[1]
  if (!response.ok || !tag) {
    throw new Error(
      `could not work out the newest release from ${RELEASES}/latest` +
        (response.ok ? ` - it answered ${response.url}` : ` (${response.status})`)
    )
  }
  return tag
}

/**
 * Check the bytes against what the release itself says they should be.
 *
 * The same trick `install.sh` uses, and for the same reason: the Homebrew
 * formula attached to every release names the sha256 of each tarball and was
 * written by the run that built them, so it is the release's own statement
 * about its own files, and checking against it costs one small download.
 *
 * A formula that cannot be fetched is not a failure. It is missing for a
 * development release, for a build installed from
 * `GITWARREN_DAEMON_TARBALL_DIR`, and on a machine whose network went away
 * between two requests - and in none of those does refusing to update make the
 * user safer than the HTTPS the tarball already arrived over. A checksum that
 * is present and *wrong* is a different thing entirely, and stops everything.
 */
export async function verifyChecksum(
  tarball: string,
  version: string,
  target: DaemonTarget,
  fetchImpl: typeof fetch = fetch
): Promise<'checked' | 'unavailable'> {
  let formula: string
  try {
    const response = await fetchImpl(`${RELEASES}/download/v${version}/gitwarren-cli.rb`)
    if (!response.ok) return 'unavailable'
    formula = await response.text()
  } catch {
    return 'unavailable'
  }

  const asset = tarballName(version, target)
  const after = formula.split(`/${asset}"`)[1]
  const expected = after === undefined ? null : /sha256\s+"([0-9a-f]{64})"/.exec(after)?.[1]
  if (!expected) return 'unavailable'

  const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `the download did not match the checksum the release published for ${asset}. ` +
        'Not installing it.'
    )
  }
  return 'checked'
}

/**
 * Unpack into a scratch directory beside the destination, then rename.
 *
 * The rename is the whole point, and it is M2's rule rather than this file's:
 * a `tar` interrupted halfway through the destination leaves a directory that
 * exists, looks installed and cannot run - and the launcher in front of it
 * points straight at it. On one filesystem a rename either happened or did
 * not, so the window in which `~/.gitwarren/daemon/<version>` is not a working
 * install is one syscall wide.
 *
 * `tar` rather than a library: it is on every machine this can run on, it is
 * what `install.sh` and the ssh installer both use, and a third implementation
 * of untarring in a code review tool would be three.
 */
function unpack(tarball: string, daemonRoot: string, version: string): string {
  const destination = join(daemonRoot, version)
  const stage = join(daemonRoot, `.install-${process.pid}`)

  mkdirSync(daemonRoot, { recursive: true })
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  try {
    execFileSync('tar', ['xzf', tarball, '-C', stage], { stdio: ['ignore', 'ignore', 'pipe'] })

    const unpacked = join(stage, 'gitwarren-daemon')
    if (!existsSync(join(unpacked, 'bin', 'gitwarren'))) {
      throw new Error(`${tarball} did not contain gitwarren-daemon/bin/gitwarren`)
    }

    // The old version moved aside rather than deleted first, so there is no
    // moment at which nothing is installed. It goes with the scratch directory.
    if (existsSync(destination)) renameSync(destination, join(stage, '.previous'))
    renameSync(unpacked, destination)
    return destination
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/**
 * Everything under `~/.gitwarren/daemon` that is not the version just
 * installed, including the scratch directories interrupted installs leave.
 *
 * Deliberately not "all but the last two". Keeping one for a rollback sounds
 * prudent and is not: nothing in GitWarren can *start* the kept one - the
 * launcher points at the new install and a person would have to know the path
 * by heart - so it would be a directory that exists to be believed in rather
 * than used. Moving back a version is `GITWARREN_VERSION=0.1.13 install.sh`,
 * or `gitwarren update --version 0.1.13`, both of which fetch.
 */
function prune(daemonRoot: string, keep: string): { removed: string[]; bytes: number } {
  const removed: string[] = []
  let bytes = 0

  for (const directory of listDaemonDirectories(daemonRoot)) {
    if (directory.version === keep) continue
    bytes += directorySize(directory.path)
    rmSync(directory.path, { recursive: true, force: true })
    removed.push(directory.version)
  }

  return { removed, bytes }
}

export interface UpdateReport {
  destination: string
  /** What was restarted, or null when nothing was running to restart. */
  restarted: string | null
  pruned: { removed: string[]; bytes: number }
}

/**
 * The part that touches the disk, in the order the other two installers do it.
 *
 * Separated from the printing above it so that a test can watch a real tarball
 * become a real install: unpack, then let the *new* binary write the
 * launchers, then restart what is running, then take away what was replaced.
 * The order is the interesting thing about this function, and it is the same
 * order `install.sh` and `core/hosts/install.ts` use - with the two steps
 * neither of them can take at the end.
 */
export function applyUpdate(
  layout: InstallLayout,
  version: string,
  tarball: string,
  target: DaemonTarget
): UpdateReport {
  const destination = unpack(tarball, layout.daemonRoot, version)

  // The new binary writes the launchers, which points them at itself and - the
  // reason it is done this way rather than from here - proves it runs on this
  // machine before anything else is told that it did. The ssh installer has
  // made the same move since M5.2; see the note at the top of
  // `core/hosts/install.ts`.
  try {
    execFileSync(join(destination, 'bin', 'gitwarren'), ['service', 'install', '--no-login-item'], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `GitWarren ${version} unpacked into ${destination} but could not run: ${detail}. ` +
        `The ${target} build may be the wrong one for this machine. The previous version was ` +
        'replaced, so reinstall with install.sh if this machine is now without one.',
      { cause: error }
    )
  }

  return {
    destination,
    restarted: restartLoginItem(),
    pruned: prune(layout.daemonRoot, version)
  }
}

interface Parsed {
  check: boolean
  force: boolean
  version: string | null
}

/** Null when argv says something that is not a flag of this command. */
function parse(argv: readonly string[]): Parsed | null {
  const parsed: Parsed = { check: false, force: false, version: null }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') parsed.check = true
    else if (argument === '--force') parsed.force = true
    else if (argument === '--version') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) return null
      parsed.version = value.replace(/^v/, '')
      index += 1
    } else return null
  }

  return parsed
}

/**
 * What the user should be told when this install is not ours to replace.
 *
 * Printed by `--check` too, because that is the moment it is most useful: a
 * Homebrew user who has just been told 0.1.15 exists wants the next command,
 * and it is one line away.
 */
function sayWhoOwnsIt(layout: InstallLayout): void {
  console.log(`\nThis copy is ${layout.description.replace(/^GitWarren [^,]*, /, '')}.`)
  if (layout.updateWith) console.log(`To update it: ${layout.updateWith}`)
}

async function update(parsed: Parsed, deps: UpdateDeps): Promise<void> {
  const { fetchImpl = fetch, resolve = resolveTarball } = deps
  const layout = describeLayout(APP_VERSION)

  const wanted = parsed.version ?? (await latestVersion(fetchImpl))

  if (parsed.check) {
    console.log(`Installed:  ${APP_VERSION}${layout.prefix ? `  (${layout.prefix})` : ''}`)
    console.log(`Newest:     ${wanted}`)
    if (wanted === APP_VERSION) console.log('\nThis is the newest release.')
    else if (layout.selfUpdatable) console.log(`\nRun \`gitwarren update\` to move to ${wanted}.`)
    if (!layout.selfUpdatable) sayWhoOwnsIt(layout)
    return
  }

  if (!layout.selfUpdatable) {
    console.log(`GitWarren ${APP_VERSION} is installed here, and ${wanted} is the newest release.`)
    sayWhoOwnsIt(layout)
    return
  }

  if (wanted === APP_VERSION && !parsed.force) {
    console.log(`GitWarren ${APP_VERSION} is already the newest release.`)
    // Said even when there is nothing to install: a machine that has been
    // updated by `install.sh` a few times has the old versions to show for it,
    // and this is the only command that will ever offer to take them away.
    const stale = listDaemonDirectories(layout.daemonRoot).filter((d) => d.version !== APP_VERSION)
    if (stale.length > 0) {
      console.log(
        `\n${stale.length} older ${stale.length === 1 ? 'version is' : 'versions are'} still in ` +
          `${layout.daemonRoot} (${formatBytes(stale.reduce((sum, d) => sum + directorySize(d.path), 0))}). ` +
          '`gitwarren update --force` reinstalls this version and removes them.'
      )
    }
    return
  }

  const target = targetForThisMachine()
  console.log(`Downloading GitWarren ${wanted} for ${target}...`)
  const tarball = await resolve(wanted, target)

  if ((await verifyChecksum(tarball, wanted, target, fetchImpl)) === 'checked') {
    console.log('Checksum matches the one the release published.')
  }

  const report = applyUpdate(layout, wanted, tarball, target)
  console.log(`Unpacked into ${report.destination}`)

  console.log(`\nGitWarren ${wanted} is installed.`)
  if (report.restarted) console.log(`Restarted the background GitWarren (${report.restarted}).`)
  if (report.pruned.removed.length > 0) {
    console.log(
      `Removed ${report.pruned.removed.join(', ')} - ${formatBytes(report.pruned.bytes)} freed.`
    )
  }
  console.log(
    'Agent configs and login items name ~/.gitwarren/bin, which now points here, so ' +
      'nothing else has to change.'
  )
}

/**
 * Argv is checked before anything is awaited, so a typo is the usage and an
 * exit code rather than a download.
 */
export function runUpdate(argv: readonly string[], deps: UpdateDeps = {}): boolean | Promise<boolean> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return true
  }

  const parsed = parse(argv)
  if (parsed === null) {
    console.error(USAGE)
    return false
  }

  return update(parsed, deps)
    .then(() => true)
    .catch((error: unknown) => {
      console.error(`[gitwarren] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      return true
    })
}
