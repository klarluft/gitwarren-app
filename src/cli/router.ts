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
import { createRequire } from 'node:module'
import { readLiveDaemonRuntime } from '../core/daemon-runtime.js'
import { runDaemon } from '../daemon/daemon.js'
import { shutdownListen } from '../daemon/listen.js'
import { runAgentSetup } from './agent-setup.js'
import { openInBrowser } from './browser.js'
import { locateMcpServer } from './install.js'
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
  gitwarren mcp [--serve]        run the MCP server itself, on stdin/stdout - what
                                 \`npx gitwarren mcp\` in an agent's config starts

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

const MCP_USAGE = `gitwarren mcp [--serve]

Runs GitWarren's MCP server, speaking MCP over stdin and stdout. This is for an
agent to run, not a person: it is the same server ~/.gitwarren/bin/gitwarren-mcp
starts, reachable by name so that an agent's config can say \`npx gitwarren mcp\`
on a machine where GitWarren was never installed.

It reads the same SQLite file the app and \`gitwarren serve\` do, so reviews an
agent makes this way are there the moment a person opens GitWarren to look.

  --serve   also serve the review page on 127.0.0.1 for as long as the agent
            keeps this running, unless a GitWarren is already running on this
            machine - then links open there and this serves nothing. This is
            what a plugin asks for, so the links its agent hands out open on a
            machine with nothing else installed.
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
 * `gitwarren mcp` - the MCP server, started by name.
 *
 * `~/.gitwarren/bin/gitwarren-mcp` is still what an installed GitWarren tells
 * an agent to run, and this does not replace it. What it adds is a way to start
 * the same server from a package that was never installed: `npx gitwarren mcp`
 * works on a machine with nothing of GitWarren on it, which is what a Claude
 * Code plugin needs and what a registry listing can name.
 *
 * The server is loaded into this process rather than spawned. It owns stdin and
 * stdout from the moment it loads - stdout is the protocol - and a child would
 * be a second process for the agent's process manager to stop, one it does not
 * know about. A `require` is the nearest thing Node has to the `exec` the shell
 * launcher does.
 *
 * Nothing is written to `~/.gitwarren/bin` on the way. `serve` and
 * `agent-setup` write the launchers because a person ran them; this is run by
 * a program, often out of an npx cache that may be gone tomorrow, and a
 * launcher pointing there would be worse than none.
 */
function runMcp(argv: readonly string[]): boolean {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(MCP_USAGE)
    return true
  }
  if (argv.some((argument) => argument !== '--serve')) {
    console.error(MCP_USAGE)
    return false
  }

  const server = locateMcpServer()
  if (!server) {
    console.error(
      '[gitwarren] this install has no MCP server bundle next to it. From a checkout, run ' +
        '`npm run build:mcp` first, or use `npm run mcp:dev`.'
    )
    return false
  }

  // The entry point installed SIGINT and SIGTERM handlers for the commands that
  // hold a listener. The server installs its own, which close its database, and
  // whichever was registered first would exit the process before the other ran.
  // The server is the whole process from here on, so it gets to be the one -
  // with the page's release registered first, below, when there is a page.
  process.removeAllListeners('SIGINT')
  process.removeAllListeners('SIGTERM')

  if (argv.includes('--serve')) serveBesideMcp()

  // stdout belongs to the protocol from this line on. Nothing above has printed
  // to it, and nothing after it may. `createRequire` from the bundle's own path
  // so that its `require('better-sqlite3')` resolves from where it lives.
  createRequire(server)(server)
  return true
}

/**
 * `--serve`: the review page, in the same process as the MCP server.
 *
 * A plugin's agent hands the user a link the moment a review exists, and on a
 * machine with nothing else installed that link has nothing to open. The rule
 * that a link may never be dead while the agent is connected is what this
 * buys: the page lives exactly as long as the MCP server, which lives exactly
 * as long as the agent's session, so the two cannot disagree about whether
 * GitWarren is "running".
 *
 * It is the same `--listen` a person gets from `gitwarren serve`, loopback only
 * and behind the same per-launch token, and it defers the same way: a data
 * directory has one owner, and if the app or a `serve` already holds it, links
 * open there and this serves nothing. That check is made here rather than left
 * to `runListen` because its refusal is an exit code, and for this caller an
 * owner is the good case rather than a failure.
 *
 * Every other way of not serving - no web build next to this bundle, a port
 * held by something that is not GitWarren - is a sentence on stderr and an MCP
 * server that runs regardless. The page is the extra; the agent's tools are
 * the point.
 *
 * `gitwarren serve` writes the launchers and opens a browser once it is up.
 * Neither happens here, for the reasons `runMcp` gives.
 */
function serveBesideMcp(): void {
  const owner = readLiveDaemonRuntime()
  if (owner) {
    console.error(
      `[gitwarren] GitWarren is already running on this machine as ` +
        `${owner.owner === 'gui' ? 'the desktop app' : 'a server'}; links will open there.`
    )
    return
  }

  if (!runDaemon(['--listen'], { brief: true })) {
    // `runListen` said why on stderr and set an exit code for a `serve` that
    // could not start. This process is still the MCP server, and it has not
    // failed at that.
    process.exitCode = undefined
    console.error(
      '[gitwarren] the review page could not be served, so links will not open until a ' +
        'GitWarren is started on this machine. The MCP server is running regardless.'
    )
    return
  }

  // Registered before the server's own handlers, so the port, the token and
  // the runtime file are released before they exit the process. Registration
  // order is execution order.
  const release = (): void => shutdownListen()
  process.on('SIGINT', release)
  process.on('SIGTERM', release)

  // On its own, the MCP server ends when its stdin does only because nothing
  // else keeps the event loop alive. A listening socket would, and a page that
  // outlives the agent that started it is a process the user never asked for.
  process.stdin.once('end', () => {
    shutdownListen()
    process.exit(0)
  })
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

    case 'mcp':
      return runMcp(rest)

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
