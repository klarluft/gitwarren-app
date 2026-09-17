/**
 * `gitwarren doctor` - the machine, as GitWarren finds it.
 *
 * Every other command here does one thing and reports on that one thing.
 * This one exists because of a class of failure none of them can see: the
 * pieces are all still where they were, and one of them now points at
 * something that is gone.
 *
 * The example that made it necessary: `brew uninstall gitwarren-cli` removes
 * the Cellar and leaves `~/.gitwarren/bin/gitwarren-mcp` behind, still naming
 * a file inside it. Nothing is broken enough to complain. `gitwarren` is not
 * on the PATH any more, so nobody types anything to find out. What happens
 * instead is that the next time an agent starts, its harness reports "MCP
 * server failed to connect" - a sentence with no cause in it, in a product
 * that is not this one. The same hole swallows a moved app, an AppImage
 * deleted after an update, and a checkout that was rebuilt somewhere else.
 *
 * So: one command that reads every path GitWarren has ever asked another
 * program to run, says whether the thing on the end of it is there, and offers
 * to repoint the ones that are not.
 *
 * ## `--fix` writes and never deletes
 *
 * The only repair is rewriting a launcher to name this install, which is the
 * same thing `service install` does and is recoverable by running any of the
 * three commands that write them. Removing things is `uninstall`, which shows
 * a plan and asks; a `--fix` that quietly deleted whatever it did not
 * recognise would be a much worse command than the problem it solves. A file
 * at a launcher path that GitWarren did not write is reported and left, on the
 * same principle.
 */
import { existsSync } from 'node:fs'
import { readLiveDaemonRuntime } from '../core/daemon-runtime.js'
import { resolveMigrationsFolder } from '../core/db/migrations.js'
import { getDatabasePath, getDataDirectory } from '../core/paths.js'
import { APP_VERSION } from '../core/version.js'
import { resolveWebRoot } from '../daemon/listen.js'
import { describeSelf } from './install.js'
import {
  describeLayout,
  directorySize,
  formatBytes,
  listDaemonDirectories,
  type InstallLayout
} from './layout.js'
import { inspectLaunchers, writeLaunchers, type LauncherReport } from './launchers.js'
import { loginItemState } from './service.js'

const USAGE = `gitwarren doctor [--fix]

Checks every path GitWarren asks another program to run - the two launchers in
~/.gitwarren/bin that agents and login items name, the MCP server, the review
page, the migrations - and says which of them are not there any more.

  --fix   rewrite a launcher that is missing or points at something that is
          gone, so it names this install. Nothing is ever deleted; that is
          \`gitwarren uninstall\`, which shows a plan first.

Exits non-zero when something is broken, so it can be the thing a script runs.
`

/** What the addon the MCP server loads was built against. See `router.ts`. */
const NODE_API_NEEDED = 10

type Level = 'ok' | 'warn' | 'problem'

interface Check {
  label: string
  level: Level
  text: string
  /** Offered by `--fix`, and named in the summary when it is not run. */
  repair?: { describe: string; run: () => string }
}

/** `~/.gitwarren/bin/gitwarren` reads better than the whole path, when it fits. */
function short(path: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function launcherCheck(report: LauncherReport, layout: InstallLayout): Check {
  const label = report.which === 'cli' ? 'CLI launcher' : 'MCP launcher'
  const name = short(report.path)

  // The one repair there is. Unavailable from a checkout, where there is no
  // file a login shell could run again - `writeLaunchers` throws, and the
  // message it throws is better than anything this could invent.
  const repair = {
    describe: `rewrite ${name} to point at this install`,
    run: (): string => {
      writeLaunchers(describeSelf())
      return `wrote ${report.path}`
    }
  }

  switch (report.state) {
    case 'this-install':
      return { label, level: 'ok', text: `${name} starts this install` }

    case 'other-install':
      // Not a problem, and the case a machine with both the app and the
      // command line is in every day. Worth a line all the same: it is the
      // answer to "why does my agent open a different GitWarren than I do".
      return {
        label,
        level: 'ok',
        text: `${name} starts ${short(report.target ?? 'another GitWarren')}, which is another GitWarren`
      }

    case 'dangling':
      return {
        label,
        level: 'problem',
        text: `${name} starts ${short(report.target ?? '?')}, which is not there any more`,
        repair
      }

    case 'foreign':
      return {
        label,
        level: 'warn',
        text: `${name} is a file GitWarren did not write, and is left alone`
      }

    case 'missing':
      return {
        label,
        level: report.which === 'mcp' ? 'warn' : 'ok',
        text:
          report.which === 'mcp'
            ? `${name} has not been written, so an agent has nothing to start`
            : `${name} has not been written`,
        repair: layout.script === null ? undefined : repair
      }
  }
}

function checks(layout: InstallLayout): Check[] {
  const found: Check[] = [
    { label: 'Install', level: 'ok', text: layout.description },
    {
      label: 'Node',
      level: Number(process.versions.napi) < NODE_API_NEEDED ? 'problem' : 'ok',
      text:
        `${process.version} (Node-API ${process.versions.napi})` +
        (Number(process.versions.napi) < NODE_API_NEEDED
          ? ` - too old for GitWarren's SQLite module, which needs Node-API ${NODE_API_NEEDED}. ` +
            'An agent starting the MCP server under this Node gets a crash on its first query.'
          : '')
    },
    {
      label: 'MCP server',
      level: layout.mcpServer === null ? 'problem' : 'ok',
      text:
        layout.mcpServer === null
          ? 'no server bundle next to this install, so no agent can use it' +
            (layout.kind === 'checkout' ? ' - `npm run build:mcp` builds one' : '')
          : short(layout.mcpServer)
    }
  ]

  const web = resolveWebRoot()
  found.push({
    label: 'Review page',
    level: web === null ? 'warn' : 'ok',
    text:
      web === null
        ? 'no web build next to this install - the protocol and the MCP server work, the browser view does not'
        : short(web)
  })

  try {
    found.push({ label: 'Migrations', level: 'ok', text: short(resolveMigrationsFolder()) })
  } catch (error) {
    found.push({
      label: 'Migrations',
      level: 'problem',
      text: error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
    })
  }

  for (const report of inspectLaunchers(layout)) found.push(launcherCheck(report, layout))

  found.push({ label: 'Login item', level: 'ok', text: loginItemState() })

  const running = readLiveDaemonRuntime()
  found.push({
    label: 'Running now',
    level: 'ok',
    text:
      running === null
        ? 'nothing - `gitwarren serve` runs it in this terminal'
        : `${running.owner === 'gui' ? 'the desktop app' : 'gitwarren serve'} (pid ${running.pid})`
  })

  const data = getDataDirectory()
  found.push({
    label: 'Data',
    level: 'ok',
    text: existsSync(getDatabasePath())
      ? `${short(data)} (${formatBytes(directorySize(data))})`
      : `${short(data)} - no database yet, which is what a machine that has never been opened looks like`
  })

  // Not a problem, because nothing is broken: it is disk, and the only command
  // that will ever offer to take it back is the one named here.
  const stale = listDaemonDirectories(layout.daemonRoot).filter(
    (directory) => directory.version !== layout.version
  )
  if (stale.length > 0) {
    found.push({
      label: 'Old versions',
      level: 'warn',
      text:
        `${stale.map((directory) => directory.version).join(', ')} in ${short(layout.daemonRoot)} ` +
        `(${formatBytes(stale.reduce((sum, directory) => sum + directorySize(directory.path), 0))}) - ` +
        '`gitwarren update` removes what it replaces'
    })
  }

  return found
}

/**
 * The report, and then the summary a person reads first.
 *
 * Each line is `label  text`, with the label column wide enough for the
 * longest one, because this is meant to be read down the left-hand side and
 * stopped at when a word looks wrong. A problem is marked in the text rather
 * than by colour: this is as likely to be pasted into an issue as it is to be
 * read on a terminal that has colours.
 */
export function runDoctor(
  argv: readonly string[],
  layout: InstallLayout = describeLayout(APP_VERSION)
): boolean {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return true
  }
  if (argv.some((argument) => argument !== '--fix')) {
    console.error(USAGE)
    return false
  }

  const fix = argv.includes('--fix')
  const found = checks(layout)
  const width = Math.max(...found.map((check) => check.label.length)) + 2

  for (const check of found) {
    const mark = check.level === 'problem' ? '! ' : '  '
    console.log(`${mark}${check.label.padEnd(width)}${check.text}`)
  }

  const broken = found.filter((check) => check.level === 'problem')
  const repairable = broken.filter((check) => check.repair !== undefined)

  if (broken.length === 0) {
    console.log('\nNothing is broken.')
    return true
  }

  if (!fix) {
    console.log(
      `\n${broken.length} ${broken.length === 1 ? 'problem' : 'problems'}, marked with \`!\`.`
    )
    if (repairable.length > 0) {
      console.log('`gitwarren doctor --fix` would:')
      for (const check of repairable) console.log(`  - ${check.repair?.describe}`)
    }
    process.exitCode = 1
    return true
  }

  if (repairable.length === 0) {
    console.log('\nNothing here is a launcher, which is the only thing --fix can rewrite.')
    process.exitCode = 1
    return true
  }

  console.log('')
  // One write, however many launchers asked for it: `writeLaunchers` does both
  // and is the only function that knows what they should contain.
  const done = new Set<string>()
  for (const check of repairable) {
    try {
      const line = check.repair?.run()
      if (line && !done.has(line)) {
        console.log(line)
        done.add(line)
      }
    } catch (error) {
      console.error(`[gitwarren] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }

  const left = broken.length - repairable.length
  if (left > 0) {
    console.log(
      `\n${left} ${left === 1 ? 'problem is' : 'problems are'} not a launcher, and --fix has ` +
        'nothing to say about them.'
    )
    process.exitCode = 1
  }

  return true
}
