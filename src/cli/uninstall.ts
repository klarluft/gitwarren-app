/**
 * `gitwarren uninstall` - taking it off the machine, and saying what is left.
 *
 * Until now the answer to "how do I remove this" was assembled by the reader
 * from three places that each knew a third of it: the README's install table,
 * the comment at the top of `packaging/install.sh`, and the formula's caveats.
 * Nothing anywhere removed the launchers, which is the part that matters -
 * `~/.gitwarren/bin/gitwarren-mcp` outlives every uninstall there is, and an
 * agent config that names it goes on naming it, pointing at a Cellar or a
 * daemon directory that is not there any more.
 *
 * ## Four things, and it will only ever remove three of them
 *
 *  1. **The login item**, which is the one piece of this that keeps running
 *     after the files are gone. Removed first, for that reason.
 *  2. **The launchers**, but only the ones that name *this* install. A machine
 *     with both the app and the command line shares that directory - see the
 *     note at the top of `launchers.ts` - and uninstalling the command line
 *     must not take the app's agent access with it. `removeOwnedLaunchers`
 *     decides, and what it leaves is printed rather than passed over.
 *  3. **The install**, when it is one GitWarren put there itself:
 *     `~/.gitwarren/daemon`. A Homebrew or npm copy belongs to a package
 *     manager that has a record of every file it wrote, and deleting those
 *     files behind its back would leave two stories about what is installed.
 *     Those cases get the command that is the right one instead.
 *  4. **The reviews**, only when asked with `--data`, and never by default.
 *     This is the one thing here that cannot be reinstalled. Everything else
 *     is a download; the comments a person wrote on their own code are not.
 *
 * ## It says what it will do before it does it
 *
 * The plan is printed and then confirmed, because every line of it is a
 * deletion in a home directory. `--yes` is how a script says it has read the
 * plan already, and is *required* when nothing is attached to the terminal -
 * an uninstall that silently proceeds because there was no one to ask is the
 * one failure mode worth designing out.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { readLiveDaemonRuntime } from '../core/daemon-runtime.js'
import { getLauncherDirectory, getMcpLauncherPath } from '../core/mcp-launcher.js'
import { getDataDirectory } from '../core/paths.js'
import { agentConfigSnippets } from '../shared/agent-setup.js'
import { APP_VERSION } from '../core/version.js'
import { describeLayout, directorySize, formatBytes, type InstallLayout } from './layout.js'
import { inspectLaunchers, removeOwnedLaunchers, type LauncherReport } from './launchers.js'
import { isLoginItemRegistered, removeLoginItem } from './service.js'

const USAGE = `gitwarren uninstall [--data] [--yes] [--dry-run]

Removes GitWarren from this machine: the login item, the launchers in
~/.gitwarren/bin that name this install, and the install itself when it is one
GitWarren put there (~/.gitwarren/daemon). A Homebrew, npm or npx copy belongs
to its package manager, and this says which command removes it.

  --data      also delete the data directory - every review, comment and
              repository list on this machine. There is no undo and no copy
              anywhere else.
  --yes       do not ask. Required when this is not run from a terminal.
  --dry-run   print what would be removed and stop.

\`gitwarren service uninstall\` is the smaller command: it stops the background
GitWarren and leaves everything else where it is.
`

export interface Step {
  /** The line in the plan. */
  title: string
  /** Run it, and say what happened. Empty means "nothing to report". */
  act: () => string[]
}

export interface Plan {
  steps: Step[]
  /** Said before the question, about things this will not do. */
  notes: string[]
  /** Launchers left alone, to be named after the fact. */
  keeping: LauncherReport[]
}

/**
 * What will be removed, worked out before anything is, so that the sentence a
 * person answers `y` to is the same object that then runs.
 *
 * Exported because this is the part worth testing: whether a launcher is taken
 * or left is the difference between uninstalling the command line and breaking
 * the desktop app's agent access, and that decision should be assertable
 * without a prompt in the way.
 */
export function buildPlan(layout: InstallLayout, data: boolean): Plan {
  const steps: Step[] = []
  const notes: string[] = []
  const launchers = inspectLaunchers(layout)

  if (isLoginItemRegistered()) {
    steps.push({
      title: 'Stop the background GitWarren and remove the login item',
      act: () => [`removed ${removeLoginItem()}`]
    })
  }

  const mine = launchers.filter(
    (report) => report.state === 'this-install' || report.state === 'dangling'
  )
  if (mine.length > 0) {
    steps.push({
      title: `Remove ${mine.map((report) => report.path).join(' and ')}`,
      act: () => removeOwnedLaunchers(layout).removed.map((path) => `removed ${path}`)
    })
  }

  const keeping = launchers.filter(
    (report) => report.state === 'other-install' || report.state === 'foreign'
  )

  if (layout.kind === 'managed' && existsSync(layout.daemonRoot)) {
    const bytes = directorySize(layout.daemonRoot)
    steps.push({
      title: `Delete ${layout.daemonRoot} (${formatBytes(bytes)})`,
      act: () => {
        rmSync(layout.daemonRoot, { recursive: true, force: true })
        const removed = [`removed ${layout.daemonRoot}`]
        // `~/.gitwarren/bin` and then `~/.gitwarren` itself, but only when this
        // took the last thing out of them. A `bin` still holding the app's
        // launcher, or anything else a user put there, is a directory that
        // still has an owner.
        for (const directory of [getLauncherDirectory(), layout.home]) {
          if (isEmptyDirectory(directory)) {
            rmSync(directory, { recursive: true, force: true })
            removed.push(`removed ${directory}`)
          }
        }
        return removed
      }
    })
  } else if (layout.removeWith && layout.kind !== 'checkout') {
    notes.push(
      `The program itself is ${layout.description.replace(/^GitWarren [^,]*, /, '')} and is not ` +
        `this command's to delete. To remove it: ${layout.removeWith}`
    )
  } else if (layout.kind === 'checkout') {
    notes.push(
      'This is running from a source checkout, which is not an install and is not this ' +
        "command's to delete. What it can still remove is what a checkout writes outside " +
        'itself: the login item and the launchers, when they name it.'
    )
  }

  if (data) {
    const directory = getDataDirectory()
    if (existsSync(directory)) {
      steps.push({
        title: `Delete ${directory} (${formatBytes(directorySize(directory))}) - every review and comment on this machine`,
        act: () => {
          rmSync(directory, { recursive: true, force: true })
          return [`removed ${directory}`]
        }
      })
    }
  } else {
    notes.push(
      `Reviews are kept. They are in ${getDataDirectory()}, and \`--data\` is how you say to ` +
        'delete them.'
    )
  }

  return { steps, notes, keeping }
}

function isEmptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length === 0
  } catch {
    return false
  }
}

/**
 * The question, and the two ways of not being asked it.
 *
 * stderr for the prompt so that a `--dry-run` piped somewhere is the plan and
 * nothing else, and so the question cannot end up in a file someone is
 * capturing.
 */
async function confirm(data: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      '[gitwarren] nothing is attached to this terminal to answer with, so nothing was ' +
        'removed. Run it again with --yes if this is what you meant.'
    )
    process.exitCode = 1
    return false
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(
      data ? 'Remove all of this, reviews included? [y/N] ' : 'Remove all of this? [y/N] '
    )
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

async function uninstall(options: { data: boolean; yes: boolean; dryRun: boolean }): Promise<void> {
  const layout = describeLayout(APP_VERSION)
  const plan = buildPlan(layout, options.data)

  console.log(`${layout.description}\n`)

  if (plan.steps.length === 0) {
    console.log('There is nothing here for this command to remove.')
    for (const note of plan.notes) console.log(`\n${note}`)
    return
  }

  console.log(options.dryRun ? 'This would:' : 'This will:')
  for (const step of plan.steps) console.log(`  - ${step.title}`)

  for (const note of plan.notes) console.log(`\n${note}`)
  for (const report of plan.keeping) {
    console.log(
      `\n${report.path} is left alone: ` +
        (report.state === 'foreign'
          ? 'GitWarren did not write it.'
          : `it points at ${report.target}, which is another GitWarren.`)
    )
  }

  // Said before the question rather than after the deletion, because it is a
  // reason someone might answer no: files can be removed from under a running
  // process on POSIX and it will carry on happily until it is stopped.
  const running = readLiveDaemonRuntime()
  if (running !== null) {
    console.log(
      `\n${running.owner === 'gui' ? 'The desktop app' : 'A GitWarren'} is running right now ` +
        `(pid ${running.pid}). It keeps running until it is stopped.`
    )
  }

  if (options.dryRun) {
    console.log('\nNothing was removed (--dry-run).')
    return
  }

  console.log('')
  if (!options.yes && !(await confirm(options.data))) {
    if (process.exitCode === undefined) console.log('Nothing was removed.')
    return
  }

  // Asked before the steps run, because after them the answer is always no.
  const hadMcpLauncher = existsSync(getMcpLauncherPath())

  for (const step of plan.steps) {
    for (const line of step.act()) console.log(line)
  }

  console.log('\nGitWarren is removed from this machine.')

  // The last thing, because it is the one part of this a command cannot do.
  // An agent config is a file in someone else's product, and half of them are
  // edited by a harness rather than by hand; naming the command and the places
  // it is written is as far as this can honestly go.
  //
  // Only when there *was* a launcher for an agent to have been pointed at, and
  // it is the one that went. Telling someone to go and edit four config files
  // on a machine where nothing ever wrote the command they would name is a
  // chore invented out of nothing.
  if (hadMcpLauncher && !existsSync(getMcpLauncherPath())) {
    console.log(
      `\nAn agent may still be configured to start ${getMcpLauncherPath()}, which is now gone. ` +
        'Remove the `gitwarren` MCP server from:'
    )
    for (const snippet of agentConfigSnippets({ command: getMcpLauncherPath() })) {
      console.log(`  - ${snippet.label}: ${snippet.hint.replaceAll('`', '')}`)
    }
    console.log('  - Claude Code, if the plugin is installed: /plugin uninstall gitwarren@gitwarren')
  }

  if (!existsSync(getLauncherDirectory())) {
    console.log(`\nIf a shell profile adds ${getLauncherDirectory()} to PATH, that line can go too.`)
  }
}

export function runUninstall(argv: readonly string[]): boolean | Promise<boolean> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return true
  }

  const known = ['--data', '--yes', '-y', '--dry-run']
  if (argv.some((argument) => !known.includes(argument))) {
    console.error(USAGE)
    return false
  }

  return uninstall({
    data: argv.includes('--data'),
    yes: argv.includes('--yes') || argv.includes('-y'),
    dryRun: argv.includes('--dry-run')
  })
    .then(() => true)
    .catch((error: unknown) => {
      console.error(`[gitwarren] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      return true
    })
}
