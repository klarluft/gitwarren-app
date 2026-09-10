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
import { runOpen } from './open.js'
import { runService } from './service.js'

/** Stamped by `vite.daemon.config.ts`; absent under `tsx`, like in `listen.ts`. */
declare const __APP_VERSION__: string

const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev'

const USAGE = `gitwarren - local-only code review, from the command line

  gitwarren serve                serve the web view on loopback and print its URL
  gitwarren serve --stdio        answer GitWarren's protocol on stdin/stdout
  gitwarren open [link]          open this machine's GitWarren in a browser
  gitwarren service install      write the launchers and start at login
  gitwarren service uninstall    remove the login item
  gitwarren service status       what is registered, and what is running
  gitwarren agent-setup          print the sentence that points an agent here
  gitwarren --version

Run a subcommand with no valid arguments to see its own usage.

The web view is served on 127.0.0.1 only, behind a token minted per launch.
\`gitwarren open\` carries that token for you; see docs/across-hosts.md.
`

/**
 * Run one command. False means "argv asked for something that is not a
 * command", which the entry point turns into exit 2 - a caller can act on that,
 * where a command that ran and failed has already set `exitCode` and said
 * something more specific than any code.
 */
export function runCli(argv: readonly string[]): boolean {
  const [command, ...rest] = argv

  switch (command) {
    case 'serve':
      // Neither carrier named: the person in front of it meant the web view.
      return runDaemon(
        rest.includes('--stdio') || rest.includes('--listen') ? rest : [...rest, '--listen']
      )

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
