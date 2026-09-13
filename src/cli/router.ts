/**
 * `gitwarren` - the command line, one level above the daemon.
 *
 * The daemon has been runnable since M2 and the web view since M3.1; what did
 * not exist until now is a *program* to install, with a name someone types and
 * subcommands that mean something to a person rather than to a spawning parent.
 * That is all this file is: argv to a subcommand, and a usage block that is the
 * only documentation most people will read.
 *
 * `serve` delegates straight to `runDaemon`, which is the same function
 * `main/index.ts` calls for `GitWarren --serve`. There is one daemon and this
 * is not a second one - the note at the top of `daemon/daemon.ts` is the long
 * version of why that matters, and it matters more now that a third caller
 * exists.
 *
 * ## `serve` with no flag means `--listen`
 *
 * `runDaemon` requires one of `--stdio` or `--listen` and prints usage
 * otherwise, which is right for a function whose callers are all programs. A
 * person typing `gitwarren serve` means the one with a web page on the end of
 * it; nobody types a command to get a pipe they are not holding. So the default
 * is filled in here, at the layer that knows a human is present, and
 * `--stdio` stays the thing a machine asks for by name - which is what M4
 * spawns over ssh.
 */
import { runDaemon } from '../daemon/daemon.js'
import { runAgentSetup } from './agent-setup.js'
import { openInBrowser } from './browser.js'
import { ensureLaunchers } from './launchers.js'
import { runOpen } from './open.js'
import { runService } from './service.js'

/** Stamped by `vite.daemon.config.ts`; absent under `tsx`, like in `listen.ts`. */
declare const __APP_VERSION__: string

const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev'

/**
 * The usage block is the only documentation most people will read, so it is
 * ordered by what a person wants rather than by what the code has: run it now,
 * open it, keep it running, let an agent in. The pipe carrier is last and
 * labelled as something a program asks for, because it is.
 */
const USAGE = `gitwarren - code review for your own git repositories, in a browser tab

Run it now
  gitwarren serve                run GitWarren in this terminal and print its URL
                                 (--open also opens the browser; Ctrl-C stops it)
  gitwarren open [link]          open the running GitWarren in your browser

Keep it running
  gitwarren service install      run GitWarren in the background, from now and at
                                 every login
  gitwarren service uninstall    stop that, and remove the login item
  gitwarren service status       what is running, and where the data is

Let a coding agent in
  gitwarren agent-setup          print the one sentence to give an agent so it can
                                 reach this GitWarren over MCP

  gitwarren serve --stdio        answer GitWarren's protocol on stdin/stdout (this
                                 is what another machine's GitWarren spawns)
  gitwarren --version

Run a subcommand with --help to see its own usage.

GitWarren serves on 127.0.0.1 only, behind a token minted per launch, and
\`gitwarren open\` carries that token for you. Reviews live in one SQLite file
on this machine - serving, the background service and the MCP server all read
the same one, so an agent can use GitWarren whether or not it is being served.
`

const SERVE_USAGE = `gitwarren serve [--open]
gitwarren serve --stdio

Runs GitWarren in this terminal, serving the review UI on 127.0.0.1 and printing
a URL that carries this launch's token. Ctrl-C stops it.

  --open    also open that URL in your browser
  --stdio   answer GitWarren's protocol on stdin/stdout instead. This is what a
            GitWarren on another machine spawns over ssh or wsl.exe; by hand it
            is a way to see what the protocol says.

Serving also writes ~/.gitwarren/bin/gitwarren-mcp, the command a coding agent
starts the MCP server with - see \`gitwarren agent-setup\`.
`

/**
 * What a person's `gitwarren serve` does once it is up, that a program's would
 * not: it writes the launchers, the way the app does on every launch, and it
 * opens the browser when asked to.
 *
 * The launchers come first and unconditionally. Until this, `gitwarren serve`
 * followed by a look at the Agent Access page ended in an instruction to run
 * `service install` - a command about logging in, to a person who wanted an
 * agent. Serving is enough of a statement of intent, and what gets written is
 * two files the person can read.
 *
 * Only what was *created* is announced. Every later `serve` finds them there
 * and says nothing, which is the same silence the app keeps.
 */
function afterListening(url: string, open: boolean): void {
  const launchers = ensureLaunchers()
  if (launchers.refused) {
    console.error(
      `\n[gitwarren] no launcher was written to ~/.gitwarren/bin, so an agent has nothing to ` +
        `start yet: ${launchers.refused}`
    )
  } else if (launchers.created.length > 0) {
    console.error(`\n[gitwarren] wrote ${launchers.created.join(' and ')}`)
  }

  if (open) {
    openInBrowser(url, (message) => console.error(`[gitwarren] ${message}. The URL is above.`))
  }
}

/**
 * Run one command. False means "argv asked for something that is not a
 * command", which the entry point turns into exit 2 - a caller can act on that,
 * where a command that ran and failed has already set `exitCode` and said
 * something more specific than any code.
 */
export function runCli(argv: readonly string[]): boolean {
  const [command, ...rest] = argv

  switch (command) {
    case 'serve': {
      if (rest.includes('--help') || rest.includes('-h')) {
        console.log(SERVE_USAGE)
        return true
      }
      // Neither carrier named: the person in front of it meant the web view.
      const argv = rest.includes('--stdio') || rest.includes('--listen') ? rest : [...rest, '--listen']
      return runDaemon(argv, { onListening: (url) => afterListening(url, rest.includes('--open')) })
    }

    case 'open':
      return runOpen(rest)

    case 'service':
      return runService(rest)

    case 'agent-setup':
      return runAgentSetup(rest)

    case '--version':
    case '-v':
      console.log(VERSION)
      return true

    case '--help':
    case '-h':
      console.log(USAGE)
      return true

    default:
      console.error(USAGE)
      return false
  }
}
